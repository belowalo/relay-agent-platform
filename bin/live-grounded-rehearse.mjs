// Real provider + actual CPU embeddings/pgvector/security/accounting components.
// Embedded PostgreSQL and fixed synthetic documents: no deployment/customer claim.
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { execFileSync } from 'node:child_process';
import { PGlite } from '@electric-sql/pglite';
import { vector } from '@electric-sql/pglite-pgvector';
import { applyMigrations } from '../server/foundation/migrations.js';
import { grantProductionRoles } from '../server/production/roles.js';
import {
  createKnowledgeRepository,
  createKnowledgeSecurity,
  createKnowledgeResourceLookup,
  createLocalEmbeddings,
  createRetriever,
  createGroundedAnswer,
} from '../server/knowledge/index.js';
import { createAuthorization } from '../server/security/authorization.js';
import { createUsagePort } from '../server/security/usage.js';
import { callModel } from '../server/connectors/models.js';
const hash = (v) => crypto.createHash('sha256').update(JSON.stringify(v)).digest('hex');
const uuid = () => crypto.randomUUID();
const output = path.resolve(process.env.LIVE_OUTPUT || 'verification-results/live-grounded');
await fs.mkdir(output, { recursive: true });
let sqlite, pg, embeddings;
const cases = [];
try {
  if (process.env.LIVE_ALLOW_MODEL_CALLS !== 'yes')
    throw new Error('Explicit model opt-in required');
  const [source, keyFile, id] = process.argv.slice(2);
  sqlite = new DatabaseSync(source, { readOnly: true });
  const c = sqlite
    .prepare('SELECT provider,endpoint,model,secret FROM connections WHERE id=?')
    .get(id);
  if (c?.endpoint !== 'https://api.groq.com/openai/v1')
    throw new Error('Only selected Groq endpoint is allowed');
  const key = await fs.readFile(keyFile),
    [iv, tag, body] = c.secret.split('.').map((v) => Buffer.from(v, 'base64'));
  const d = crypto.createDecipheriv('aes-256-gcm', key, iv);
  d.setAuthTag(tag);
  const secret = Buffer.concat([d.update(body), d.final()]).toString('utf8');
  sqlite.close();
  sqlite = undefined;
  const benchmark = JSON.parse(await fs.readFile('tests/fixtures/business/held-out.json', 'utf8'));
  const limit = Math.min(
    benchmark.cases.length,
    Math.max(1, Number(process.env.LIVE_CASE_LIMIT) || benchmark.cases.length),
  );
  const manifest = {
    commit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
    benchmarkHash: hash(benchmark),
    provider: 'Groq',
    model: c.model,
    cases: limit,
    partial: limit !== benchmark.cases.length,
    topK: 5,
    mode: 'hybrid',
    maximumOutputTokens: 1536,
    temperature: 0,
    scope:
      'Real provider, fixed synthetic documents, embedded PostgreSQL. Independent human review, deployed workflows and customer-document validation remain required.',
  };
  await fs.writeFile(path.join(output, 'manifest.json'), JSON.stringify(manifest, null, 2));
  pg = new PGlite({ extensions: { vector } });
  const query = async (sql, args) =>
    args?.length ? pg.query(sql, args) : { rows: (await pg.exec(sql)).at(-1)?.rows || [] };
  const pool = { query, connect: async () => ({ query, release() {} }) };
  await applyMigrations(pool);
  await pg.exec(
    'CREATE ROLE relay_app;CREATE ROLE relay_identity;CREATE ROLE relay_rate;CREATE ROLE relay_dispatch;',
  );
  await grantProductionRoles(pool);
  const ctx = { workspaceId: uuid(), actor: { kind: 'user', id: uuid() }, requestId: uuid() },
    collectionId = uuid();
  await pg.query('INSERT INTO relay.workspaces(id,name,created_at) VALUES($1,$2,$3)', [
    ctx.workspaceId,
    'Disposable held-out benchmark',
    new Date().toISOString(),
  ]);
  await pg.query('INSERT INTO relay.security_workspaces(workspace_id) VALUES($1)', [
    ctx.workspaceId,
  ]);
  await pg.query(
    'INSERT INTO relay.security_accounts(id,email,name,password_hash) VALUES($1,$2,$3,$4)',
    [ctx.actor.id, 'benchmark@relay.test', 'Benchmark', 'not-a-login'],
  );
  await pg.query("INSERT INTO relay.security_memberships VALUES($1,$2,'owner')", [
    ctx.workspaceId,
    ctx.actor.id,
  ]);
  await pg.query(
    'INSERT INTO relay.collections(id,workspace_id,name,created_at) VALUES($1,$2,$3,$4)',
    [collectionId, ctx.workspaceId, 'Frozen documents', new Date().toISOString()],
  );
  const database = {
    transaction(c, fn) {
      return pg.transaction(async (t) => {
        await t.exec('SET LOCAL ROLE relay_app');
        await t.query("SELECT set_config('relay.workspace_id',$1,true)", [c.workspaceId]);
        return fn({
          context: c,
          query: async (s, a = []) => {
            const r = await t.query(s, a);
            return { rows: r.rows, rowCount: r.affectedRows ?? r.rows.length };
          },
          one: async (s, a = []) => (await t.query(s, a)).rows[0] || null,
          all: async (s, a = []) => (await t.query(s, a)).rows,
        });
      });
    },
  };
  const repo = createKnowledgeRepository(database),
    authorization = createAuthorization({
      database,
      resourceLookup: createKnowledgeResourceLookup(repo, async (c, id) => {
        const row = await database.transaction(c, (s) =>
          s.one('SELECT workspace_id FROM relay.collections WHERE id=$1', [id]),
        );
        return row ? { workspaceId: row.workspace_id } : null;
      }),
    }),
    security = createKnowledgeSecurity(authorization),
    usage = createUsagePort({ database, authorize: authorization.authorize });
  await usage.configure(ctx, {
    periodId: 'qualification',
    tokenLimit: 250000,
    costLimitMicros: null,
    allowUnknownCost: true,
    maxConcurrent: 1,
    maxReservedTokens: 8000,
  });
  embeddings = createLocalEmbeddings({ cacheDir: path.resolve('data/models') });
  const sourceIds = {};
  for (const doc of benchmark.documents) {
    const accepted = await repo.upsert(ctx, {
      collectionId,
      externalId: doc.id,
      name: doc.name,
      text: doc.text,
      metadata: {},
      access: { mode: 'workspace', principalIds: [] },
    });
    sourceIds[doc.id] = accepted.sourceId;
    const lease = await repo.claim(ctx, accepted.jobId, 'bounded-local-rehearsal');
    const vectors = await embeddings.embed(ctx, [doc.text]);
    await repo.finish(
      ctx,
      lease,
      [
        {
          id: uuid(),
          ordinal: 0,
          content: doc.text,
          location: { start: 0, end: doc.text.length },
          vector: vectors[0],
        },
      ],
      embeddings.model,
    );
  }
  const retrieve = createRetriever({ repository: repo, security, embeddings });
  for (const item of benchmark.cases.slice(0, limit)) {
    const started = Date.now();
    let observedUsage = {},
      rawOutput,
      streamed = 0;
    const retrieval = await retrieve(ctx, collectionId, item.question, { topK: 5, mode: 'hybrid' });
    const row = {
      id: item.id,
      question: item.question,
      expected: item.expected,
      retrievedExpectedSource: retrieval.evidence.some(
        (e) => e.citation.sourceId === sourceIds[item.sourceId],
      ),
      evidence: retrieval.evidence.map((e) => e.citation),
    };
    try {
      const answer = createGroundedAnswer({
        retrieve,
        security,
        repository: repo,
        generate: async (_ctx, p) => {
          const messages = [
              { role: 'system', content: p.system },
              {
                role: 'user',
                content: JSON.stringify({ question: p.question, evidence: p.evidence }),
              },
            ],
            runId = uuid();
          const reservation = await usage.reserve(ctx, {
            runId,
            maximumTokens: Buffer.byteLength(JSON.stringify(messages)) + 1536,
            maximumCostMicros: null,
          });
          try {
            const r = await callModel({
              provider: c.provider,
              endpoint: c.endpoint,
              secret,
              config: { model: c.model, maxTokens: 1536, temperature: 0 },
              messages,
              tools: [],
              signal: AbortSignal.timeout(45000),
              onToken: (v) => {
                streamed += v.length;
              },
            });
            observedUsage = r.usage;
            rawOutput = r.text;
            if (!r.usage.known) throw new Error('Unknown usage');
            await usage.settle(ctx, reservation.id, {
              tokens: r.usage.inputTokens + r.usage.outputTokens,
              costMicros: null,
              provider: 'Groq',
              model: c.model,
            });
            return r.text;
          } catch (e) {
            await usage.markUncertain(ctx, reservation.id);
            throw e;
          }
        },
      });
      const result = await answer(ctx, collectionId, item.question, { topK: 5, mode: 'hybrid' });
      Object.assign(row, {
        status: 'completed',
        answer: result.text,
        citations: result.citations,
        automatedExpectedTextMatch: result.text.includes(item.expected),
      });
    } catch (e) {
      Object.assign(row, {
        status: 'failed',
        code: e.code || 'PROVIDER_OR_GROUNDING_FAILURE',
        reason: [
          'Answer provider returned invalid grounded output.',
          'Answer provider returned inconsistent evidence status.',
          'Answer contains an invalid or unsupported citation.',
          'Answer claim could not be verified against its evidence.',
        ].includes(e.message)
          ? e.message
          : 'Provider invocation failed',
        // Fixed synthetic documents only; retain failed output for diagnosis and
        // human review without exposing a key or sending it to CI.
        ...(rawOutput ? { rejectedOutput: rawOutput.slice(0, 20000) } : {}),
        automatedExpectedTextMatch: false,
      });
    }
    Object.assign(row, {
      usage: observedUsage,
      streamedTokens: streamed > 0,
      elapsedMs: Date.now() - started,
    });
    cases.push(row);
    await fs.writeFile(
      path.join(output, 'cases.json'),
      JSON.stringify(
        { benchmarkHash: manifest.benchmarkHash, resultsHash: hash(cases), cases },
        null,
        2,
      ),
    );
    console.log(
      JSON.stringify({
        completed: cases.length,
        total: benchmark.cases.length,
        status: row.status,
        expectedSource: row.retrievedExpectedSource,
      }),
    );
    // Stay below free-tier token/minute ceilings without hidden retries.
    await new Promise((r) => setTimeout(r, Math.max(0, 10000 - (Date.now() - started))));
  }
  const report = {
    ...manifest,
    resultsHash: hash(cases),
    recallAt5: cases.filter((c) => c.retrievedExpectedSource).length / cases.length,
    automatedExpectedTextMatch:
      cases.filter((c) => c.automatedExpectedTextMatch).length / cases.length,
    completed: cases.filter((c) => c.status === 'completed').length,
    reportedTokens: cases.reduce(
      (n, c) => n + (c.usage.inputTokens || 0) + (c.usage.outputTokens || 0),
      0,
    ),
    verdict: 'blocked',
    missingAction:
      'Independent human review against these exact answers/citations and a separate deployed/customer-document test.',
  };
  await fs.writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
} catch (e) {
  console.error(
    JSON.stringify({ code: e.code || 'REHEARSAL_FAILED', privateDetailsPrinted: false }),
  );
  process.exitCode = 1;
} finally {
  sqlite?.close();
  await embeddings?.close();
  await pg?.close();
}
