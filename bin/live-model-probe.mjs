// Explicit bounded live diagnostic. Read-only legacy vault access; plaintext
// stays in this process and never goes to CI, logs, exports or a temporary file.
import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { execFileSync } from 'node:child_process';
import { callModel } from '../server/connectors/models.js';
const report = {
  commit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  live: true,
  scope:
    'Three synthetic questions against a real provider adapter. Not a deployed workflow or held-out document-quality qualification.',
  checks: [],
};
let db;
try {
  if (process.env.LIVE_ALLOW_MODEL_CALLS !== 'yes')
    throw new Error('Model calls require explicit opt-in');
  const [source, keyFile, id] = process.argv.slice(2);
  db = new DatabaseSync(source, { readOnly: true });
  const c = db.prepare('SELECT provider,endpoint,model,secret FROM connections WHERE id=?').get(id);
  if (c?.endpoint !== 'https://api.groq.com/openai/v1')
    throw new Error('This bounded probe only accepts the selected Groq endpoint');
  const key = await fs.readFile(keyFile),
    [iv, tag, body] = c.secret.split('.').map((v) => Buffer.from(v, 'base64'));
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  const secret = Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8');
  report.provider = 'Groq';
  report.model = c.model;
  const inputs = [
    {
      name: 'reasoning-stream-usage',
      messages: [
        {
          role: 'user',
          content:
            'A team has 7 boxes with 6 tickets each and sells 9 tickets. Reply only with the number of tickets left.',
        },
      ],
      valid: (r) => r.text.trim() === '33',
    },
    {
      name: 'structured-json-usage',
      messages: [{ role: 'user', content: 'Return JSON with ticketsLeft equal to 33.' }],
      outputSchema: {
        type: 'object',
        properties: { ticketsLeft: { type: 'integer' } },
        required: ['ticketsLeft'],
        additionalProperties: false,
      },
      valid: (r) => r.structuredOutput?.ticketsLeft === 33,
    },
    {
      name: 'tool-selection-schema',
      messages: [
        {
          role: 'user',
          content:
            'Call the lookup tool with q exactly "Relay qualification". Do not answer directly.',
        },
      ],
      tools: [
        {
          id: 'lookup',
          name: 'lookup',
          config: {
            inputSchema: {
              type: 'object',
              properties: { q: { type: 'string' } },
              required: ['q'],
              additionalProperties: false,
            },
          },
        },
      ],
      valid: (r) =>
        r.toolCalls?.length === 1 && r.toolCalls[0].arguments.q === 'Relay qualification',
    },
  ];
  for (const i of inputs) {
    let streamed = 0;
    const t = Date.now();
    try {
      const r = await callModel({
        provider: c.provider,
        endpoint: c.endpoint,
        secret,
        config: {
          model: c.model,
          maxTokens: 512,
          temperature: 0,
          ...(i.outputSchema ? { outputSchema: i.outputSchema } : {}),
        },
        messages: i.messages,
        tools: i.tools || [],
        signal: AbortSignal.timeout(45000),
        onToken: (v) => {
          streamed += v.length;
        },
      });
      report.checks.push({
        name: i.name,
        passed: i.valid(r) && r.usage.known,
        elapsedMs: Date.now() - t,
        streamedCharacters: streamed,
        usage: r.usage,
        toolExecuted: false,
      });
    } catch (e) {
      report.checks.push({
        name: i.name,
        passed: false,
        code: e.code || 'DEPENDENCY_UNAVAILABLE',
        elapsedMs: Date.now() - t,
      });
    }
  }
  report.passed = report.checks.every((v) => v.passed);
} catch (e) {
  report.passed = false;
  report.code = e.code || 'PRIVATE_SOURCE_OR_PROVIDER_UNAVAILABLE';
} finally {
  db?.close();
}
console.log(JSON.stringify(report));
if (!report.passed) process.exitCode = 1;
