import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { json } from '../../server/runtime/core.js';
export const node = (id, kind, config = {}) => ({
  id,
  type: 'relay',
  position: { x: 0, y: 0 },
  data: { kind, label: id, config },
});
export const edge = (source, target, branch) => ({
  id: source + '-' + target,
  source,
  target,
  ...(branch ? { data: { branch } } : {}),
});
export const linear = (kind = 'transform', config = {}) => ({
  nodes: [node('in', 'input'), node('work', kind, config), node('out', 'output')],
  edges: [edge('in', 'work'), edge('work', 'out')],
});
export const context = (workspaceId = 'fixture_workspace', actorId = 'fixture_user') => ({
  workspaceId,
  actor: { kind: 'user', id: actorId },
  requestId: 'fixture_request',
});
export const usageFixture = () => ({
  reservations: [],
  settlements: [],
  releases: [],
  async reserve(ctx, request) {
    const r = { id: crypto.randomUUID(), workspaceId: ctx.workspaceId, ...request };
    this.reservations.push(r);
    return r;
  },
  async settle(ctx, id, result) {
    this.settlements.push({ id, ...result });
  },
  async release(ctx, id) {
    this.releases.push(id);
  },
});
export function sqliteFixture(file) {
  const db = new DatabaseSync(file);
  db.exec(fs.readFileSync(new URL('../../server/schema.sql', import.meta.url), 'utf8'));
  const dir = new URL('../../server/migrations/', import.meta.url);
  for (const name of fs
    .readdirSync(dir)
    .filter((n) => /^\d.*\.sql$/.test(n))
    .sort())
    db.exec(fs.readFileSync(new URL(name, dir), 'utf8'));
  db.prepare('INSERT INTO users(id,email,name,password,created_at) VALUES(?,?,?,?,?)').run(
    'fixture_user',
    'fixture@relay.test',
    'Synthetic fixture',
    'synthetic-password-hash',
    '2026-01-01T00:00:00Z',
  );
  db.prepare('INSERT INTO workspaces(id,name,created_at) VALUES(?,?,?)').run(
    'fixture_workspace',
    'Synthetic workspace',
    '2026-01-01T00:00:00Z',
  );
  db.prepare('INSERT INTO members VALUES(?,?,?)').run('fixture_workspace', 'fixture_user', 'owner');
  db.prepare('INSERT INTO collections(id,workspace_id,name,created_at) VALUES(?,?,?,?)').run(
    'fixture_collection',
    'fixture_workspace',
    'Synthetic documents',
    '2026-01-01T00:00:00Z',
  );
  db.prepare(
    'INSERT INTO sources(id,workspace_id,collection_id,name,status,content,created_at) VALUES(?,?,?,?,?,?,?)',
  ).run(
    'fixture_source',
    'fixture_workspace',
    'fixture_collection',
    'Synthetic document',
    'ready',
    'Synthetic document text',
    '2026-01-01T00:00:00Z',
  );
  db.prepare('INSERT INTO chunks VALUES(?,?,?,?,?,?)').run(
    'fixture_chunk',
    'fixture_workspace',
    'fixture_collection',
    'fixture_source',
    0,
    'Synthetic document text',
  );
  db.prepare('INSERT INTO embeddings VALUES(?,?,?,?,?)').run(
    'fixture_chunk',
    'fixture_workspace',
    'fixture_collection',
    'synthetic-embedding',
    '[0.1,0.2]',
  );
  const graph = linear();
  db.prepare(
    'INSERT INTO workflows(id,workspace_id,name,graph,created_at,updated_at) VALUES(?,?,?,?,?,?)',
  ).run(
    'fixture_workflow',
    'fixture_workspace',
    'Synthetic graph',
    json(graph),
    '2026-01-01T00:00:00Z',
    '2026-01-01T00:00:00Z',
  );
  db.prepare('INSERT INTO versions VALUES(?,?,?,?,?,?)').run(
    'fixture_version',
    'fixture_workflow',
    1,
    'Synthetic revision',
    json(graph),
    '2026-01-01T00:00:00Z',
  );
  db.prepare(
    'INSERT INTO runs(id,workspace_id,workflow_id,graph,input,status,mode,created_at) VALUES(?,?,?,?,?,?,?,?)',
  ).run(
    'fixture_run',
    'fixture_workspace',
    'fixture_workflow',
    json(graph),
    '{}',
    'running',
    'live',
    '2026-01-01T00:00:00Z',
  );
  db.prepare('INSERT INTO steps(id,run_id,node_id,status) VALUES(?,?,?,?)').run(
    'fixture_step',
    'fixture_run',
    'work',
    'running',
  );
  db.prepare(
    'INSERT INTO applications(id,workspace_id,workflow_id,version_id,name,settings,token_hash,created_at,graph_snapshot) VALUES(?,?,?,?,?,?,?,?,?)',
  ).run(
    'fixture_application',
    'fixture_workspace',
    'fixture_workflow',
    'fixture_version',
    'Synthetic publication',
    '{}',
    'synthetic-token-digest',
    '2026-01-01T00:00:00Z',
    json(graph),
  );
  db.prepare(
    'INSERT INTO schedules(id,workspace_id,workflow_id,name,interval_minutes,input,mode,next_at,created_at) VALUES(?,?,?,?,?,?,?,?,?)',
  ).run(
    'fixture_schedule',
    'fixture_workspace',
    'fixture_workflow',
    'Legacy halted schedule',
    60,
    '{}',
    'live',
    1,
    '2026-01-01T00:00:00Z',
  );
  db.prepare(
    'INSERT INTO actions(id,workspace_id,run_id,step_id,tool_id,status,side_effect,created_at) VALUES(?,?,?,?,?,?,?,?)',
  ).run(
    'fixture_action',
    'fixture_workspace',
    'fixture_run',
    'fixture_step',
    'synthetic_tool',
    'running',
    1,
    '2026-01-01T00:00:00Z',
  );
  db.prepare('INSERT INTO events(run_id,type,data,created_at) VALUES(?,?,?,?)').run(
    'fixture_run',
    'run.running',
    '{}',
    '2026-01-01T00:00:00Z',
  );
  const key = crypto.randomBytes(32),
    iv = crypto.randomBytes(12),
    cipher = crypto.createCipheriv('aes-256-gcm', key, iv),
    encrypted = Buffer.concat([cipher.update('synthetic-secret'), cipher.final()]);
  const envelope = [iv, cipher.getAuthTag(), encrypted].map((b) => b.toString('base64')).join('.');
  db.prepare(
    'INSERT INTO connections(id,workspace_id,name,provider,endpoint,model,secret,created_at) VALUES(?,?,?,?,?,?,?,?)',
  ).run(
    'fixture_connection',
    'fixture_workspace',
    'Synthetic connection',
    'fixture',
    'https://example.invalid',
    'fixture-model',
    envelope,
    '2026-01-01T00:00:00Z',
  );
  db.close();
  return { key, envelope };
}
