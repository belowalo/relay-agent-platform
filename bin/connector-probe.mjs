import fs from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { connectorFor } from '../server/connectors/index.js';

// Explicit operator-run diagnostic. Output is status only; provider data and secrets are discarded.
const args = process.argv.slice(2);
let spec, secret;
try {
  if (args[0] === '--github' && /^[\w.-]+\/[\w.-]+$/.test(args[1] || '')) {
    const repository = args[1];
    secret = execFileSync('gh', ['auth', 'token'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
    spec = {
      kind: 'github',
      config: { repositories: [repository] },
      reads: [
        { action: 'repositories', input: { repository } },
        { action: 'issues', input: { repository, limit: 1 } },
        { action: 'pulls', input: { repository, limit: 1 } },
        {
          action: 'document',
          input: { repository, path: 'README.md', ref: 'codex/production-foundation' },
        },
      ],
    };
  } else if (args[0] === '--spec' && args[1]) {
    spec = JSON.parse(await fs.readFile(args[1], 'utf8'));
    secret = process.env.RELAY_CONNECTOR_PROBE_SECRET || '';
  } else throw new Error('usage');
  const context = {
    workspaceId: 'probe',
    actor: { kind: 'service', id: 'operator' },
    requestId: crypto.randomUUID(),
  };
  const ref = { workspaceId: 'probe', connectionId: 'probe', version: 1 };
  const connector = connectorFor(spec.kind, spec.config, {
    authorize: async () => {},
    secrets: { resolve: async () => secret },
  });
  const results = [];
  for (const read of spec.reads || []) {
    if (connector.descriptor.actions.find((a) => a.id === read.action)?.effect !== 'read')
      throw new Error('write forbidden');
    try {
      await connector.invoke(context, {
        ...read,
        secretRef: ref,
        signal: AbortSignal.timeout(30000),
      });
      results.push({ action: read.action, ok: true });
    } catch (e) {
      results.push({ action: read.action, ok: false, code: e.code || 'DEPENDENCY_UNAVAILABLE' });
    }
  }
  console.log(JSON.stringify({ verification: 'live-read-only', connector: spec.kind, results }));
  if (!results.length || results.some((r) => !r.ok)) process.exitCode = 1;
} catch {
  console.error(
    'Connector probe failed. Use --github owner/repository (OS keyring) or --spec nonsecret-config.json with RELAY_CONNECTOR_PROBE_SECRET. No writes are permitted.',
  );
  process.exitCode = 1;
}
