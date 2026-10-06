import 'dotenv/config';
import express from 'express';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import multer from 'multer';
import crypto from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs';
import { z } from 'zod';
import {
  all,
  one,
  exec,
  id,
  now,
  encode,
  decode,
  encrypt,
  decrypt,
  hash,
  audit,
  transaction,
  safeError,
  redact,
} from './db.js';
import {
  authenticate,
  workspaceAccess,
  requireRole,
  createSession,
  passwordHash,
  checkPassword,
  createWorkspace,
  rank,
} from './auth.js';
import { templates, nodeCatalog, toolCatalog, validateGraph } from './catalog.js';
import {
  createRun,
  startEngine,
  cancelRun,
  approveStep,
  retryRun,
  snapshotGraph,
} from './engine.js';
import {
  addSource,
  ingestWebsite,
  crawlWebsite,
  retrieve,
  indexSource,
  deleteSource,
} from './knowledge.js';
import { modelCall, providerRegistry } from './providers.js';
import { executeTool, toolHandlers } from './tools.js';
import { maintenance } from './maintenance.js';
import { safeFetch, responseText } from './network.js';
import { registerSecurity, finishLogin } from './security.js';
import { registerPlatform } from './platform.js';
import { registerApplicationMcp } from './mcp-server.js';
import { browserBoundary } from './security/http.js';
import { localRateLimit } from './security/rate-limits.js';
import {
  issueGuestRun,
  guestRunAccess,
  consumeWebhook,
  publicationAuthorized,
  recordInvitation,
  invitationAuthorized,
  revokeMemberDelegations,
} from './security/local.js';
import { parseUpload } from './security/upload.js';
const app = express();
app.disable('x-powered-by');
app.use(
  helmet({
    contentSecurityPolicy: process.env.NODE_ENV === 'production' ? undefined : false,
    crossOriginResourcePolicy: { policy: 'same-origin' },
  }),
);
app.use(express.json({ limit: '3mb' }));
app.use(cookieParser());
app.use((req, res, next) => {
  const json = res.json.bind(res);
  res.json = (value) => json(redact(req.workspace || req.application?.workspace_id, value));
  next();
});
app.use(
  browserBoundary({
    publicOrigin: process.env.PUBLIC_ORIGIN || `http://127.0.0.1:${process.env.PORT || 4311}`,
    development: process.env.NODE_ENV !== 'production',
  }),
);
app.use(['/api/auth', '/api/account'], localRateLimit({ limit: 80, windowMs: 900000 }));
app.use('/api', localRateLimit({ limit: 600, windowMs: 60000 }));
app.use(['/api/apps', '/apps'], localRateLimit({ limit: 300, windowMs: 60000 }));
const route = (handler) => async (req, res, next) => {
  try {
    await handler(req, res);
  } catch (e) {
    next(e);
  }
};
const accountSchema = z.object({
  name: z.string().min(1).max(80),
  email: z.email(),
  password: z.string().min(10).max(200),
});
const nodeIdSchema = z
  .string()
  .min(1)
  .max(100)
  .regex(/^[A-Za-z0-9_-]+$/);
const graphSchema = z.object({
  nodes: z
    .array(
      z.object({
        id: nodeIdSchema,
        type: z.literal('relay').default('relay'),
        position: z.object({ x: z.number(), y: z.number() }),
        data: z.object({
          kind: z.enum(nodeCatalog.map((n) => n.kind)),
          label: z.string().min(1).max(100),
          config: z.record(z.string(), z.any()).default({}),
        }),
      }),
    )
    .max(100),
  edges: z
    .array(
      z.object({
        id: nodeIdSchema,
        source: nodeIdSchema,
        target: nodeIdSchema,
        label: z.string().optional(),
        data: z.record(z.string(), z.any()).optional(),
        sourceHandle: z.string().nullable().optional(),
        targetHandle: z.string().nullable().optional(),
      }),
    )
    .max(300),
  settings: z.record(z.string(), z.any()).optional(),
});
function seed(wid) {
  for (const template of templates.slice(0, 1))
    saveNewWorkflow(wid, {
      name: template.name,
      description: template.description,
      graph: template.graph,
    });
  for (const [name, role, instructions] of [
    ['Research analyst', 'Researcher', 'Research the assigned topic and cite retrieved sources.'],
    ['Editorial reviewer', 'Reviewer', 'Check evidence and synthesize a clear final result.'],
  ])
    exec(
      'INSERT INTO agents VALUES(?,?,?,?,?)',
      id(),
      wid,
      name,
      encode({
        role,
        instructions,
        memory: 'none',
        maxSteps: 5,
        temperature: 0.4,
        maxTokens: 2048,
      }),
      now(),
    );
}
function cleanGraph(graph) {
  const result = graphSchema.parse(graph);
  for (const node of result.nodes || []) {
    delete node.selected;
    delete node.dragging;
    delete node.measured;
    delete node.data?.status;
    delete node.data?.output;
    if (node.data?.config) {
      delete node.data.config.graphSnapshot;
      delete node.data.config.toolSnapshots;
      delete node.data.config.toolSnapshot;
    }
  }
  return result;
}
function assertNoSecrets(value) {
  function visit(v) {
    if (!v || typeof v !== 'object') return;
    for (const [key, child] of Object.entries(v)) {
      if (/^(secret|apiKey|password|authorization|x-api-key|api-key)$/i.test(key) && child)
        throw new Error('Store credentials in Connections and reference them by ID');
      visit(child);
    }
  }
  visit(value);
}
function saveNewWorkflow(wid, b) {
  const graph = cleanGraph(b.graph);
  assertNoSecrets(graph);
  const widProject =
    b.projectId || one('SELECT id FROM projects WHERE workspace_id=? LIMIT 1', wid)?.id;
  if (widProject && !one('SELECT id FROM projects WHERE id=? AND workspace_id=?', widProject, wid))
    throw new Error('Project belongs to another workspace');
  const workflowId = id();
  transaction(() => {
    exec(
      'INSERT INTO workflows VALUES(?,?,?,?,?,?,?,?,?)',
      workflowId,
      wid,
      widProject,
      String(b.name || 'Untitled workflow').slice(0, 100),
      b.description || '',
      encode(graph),
      1,
      now(),
      now(),
    );
    exec(
      'INSERT INTO versions VALUES(?,?,?,?,?,?)',
      id(),
      workflowId,
      1,
      b.name || 'Untitled workflow',
      encode(graph),
      now(),
    );
  });
  return workflowId;
}
const workflowRow = (r) => ({ ...r, graph: decode(r.graph) });
const jsonRow = (r, key = 'config') => ({ ...r, [key]: decode(r[key]) });
const noSecret = (c) => {
  const { secret, ...rest } = c;
  return { ...rest, hasCredential: !!decrypt(secret), config: decode(c.config) };
};
function scoped(table, key, wid) {
  const row = one(`SELECT * FROM ${table} WHERE id=? AND workspace_id=?`, key, wid);
  if (!row) {
    const e = new Error('Resource was not found in this workspace');
    e.status = 404;
    throw e;
  }
  return row;
}
app.get('/api/health', (req, res) => res.json({ status: 'ok', product: 'Relay' }));
app.post(
  '/api/auth/register',
  route((req, res) => {
    const body = accountSchema.parse(req.body);
    const userId = id();
    if (one('SELECT id FROM users WHERE email=?', body.email.toLowerCase()))
      return res.status(409).json({ error: 'An account already exists with this email' });
    let wid;
    transaction(() => {
      exec(
        'INSERT INTO users(id,email,name,password,created_at) VALUES(?,?,?,?,?)',
        userId,
        body.email.toLowerCase(),
        body.name,
        passwordHash(body.password),
        now(),
      );
      wid = createWorkspace(userId, `${body.name.split(' ')[0]}'s workspace`);
    });
    seed(wid);
    createSession(res, userId);
    res.status(201).json({ id: userId, name: body.name, email: body.email, workspaceId: wid });
  }),
);
app.post(
  '/api/auth/login',
  route((req, res) => {
    const body = z.object({ email: z.email(), password: z.string().max(200) }).parse(req.body);
    const user = one('SELECT * FROM users WHERE email=?', body.email.toLowerCase());
    if (!user || !checkPassword(body.password, user.password))
      return res.status(401).json({ error: 'Email or password is incorrect' });
    finishLogin(res, user);
  }),
);
registerSecurity(app, { seed });
app.post('/api/auth/logout', (req, res) => {
  exec('DELETE FROM sessions WHERE token=?', hash(req.cookies.relay_session || ''));
  res.clearCookie('relay_session');
  res.json({ ok: true });
});
app.get('/api/me', authenticate, (req, res) =>
  res.json({
    user: req.user,
    workspaces: all(
      'SELECT w.*,m.role FROM workspaces w JOIN members m ON w.id=m.workspace_id WHERE m.user_id=?',
      req.user.id,
    ).map((r) => jsonRow(r, 'settings')),
  }),
);
app.post(
  '/api/workspaces',
  authenticate,
  route((req, res) => {
    const name = z.string().min(1).max(100).parse(req.body.name);
    let wid;
    transaction(() => {
      wid = createWorkspace(req.user.id, name);
    });
    res.status(201).json({ id: wid });
  }),
);
app.post(
  '/api/invitations/accept',
  authenticate,
  route((req, res) => {
    const invite = one(
      'SELECT * FROM invitations WHERE token_hash=? AND expires_at>? AND accepted=0',
      hash(String(req.body.token || '')),
      Date.now(),
    );
    if (
      !invite ||
      !invitationAuthorized(invite) ||
      invite.email.toLowerCase() !== req.user.email.toLowerCase()
    )
      return res
        .status(403)
        .json({ error: 'Invitation is invalid, expired, or addressed to another account' });
    transaction(() => {
      exec(
        'INSERT OR IGNORE INTO members VALUES(?,?,?)',
        invite.workspace_id,
        req.user.id,
        invite.role,
      );
      exec('UPDATE invitations SET accepted=1 WHERE id=?', invite.id);
      audit(invite.workspace_id, req.user.id, 'invitation.accepted', invite.id);
    });
    res.json({ workspaceId: invite.workspace_id });
  }),
);
const api = express.Router({ mergeParams: true });
app.use('/api/w/:wid', authenticate, workspaceAccess, api);
api.get('/catalog', (req, res) =>
  res.json({
    nodes: nodeCatalog,
    tools: toolCatalog,
    providers: Object.keys(providerRegistry),
    templates,
  }),
);
api.get('/overview', (req, res) => {
  const runs = all(
    'SELECT id,workflow_id,status,mode,usage,created_at,finished_at FROM runs WHERE workspace_id=? AND parent_id IS NULL ORDER BY created_at DESC LIMIT 1000',
    req.workspace,
  ).map((r) => jsonRow(r, 'usage'));
  res.json({
    workflows: one('SELECT count(*) AS count FROM workflows WHERE workspace_id=?', req.workspace)
      .count,
    agents: one('SELECT count(*) AS count FROM agents WHERE workspace_id=?', req.workspace).count,
    runs,
    activity: all(
      'SELECT a.*,u.name AS user_name FROM audit a LEFT JOIN users u ON a.user_id=u.id WHERE a.workspace_id=? ORDER BY a.created_at DESC LIMIT 12',
      req.workspace,
    ),
  });
});
api.get('/search', (req, res) => {
  const q = '%' + String(req.query.q || '').slice(0, 100) + '%';
  res.json({
    workflows: all(
      'SELECT id,name FROM workflows WHERE workspace_id=? AND name LIKE ? LIMIT 15',
      req.workspace,
      q,
    ),
    agents: all(
      'SELECT id,name FROM agents WHERE workspace_id=? AND name LIKE ? LIMIT 15',
      req.workspace,
      q,
    ),
    sources: all(
      'SELECT id,name FROM sources WHERE workspace_id=? AND name LIKE ? LIMIT 15',
      req.workspace,
      q,
    ),
    runs: all(
      'SELECT id,status,created_at FROM runs WHERE workspace_id=? AND (id LIKE ? OR input LIKE ?) LIMIT 15',
      req.workspace,
      q,
      q,
    ),
  });
});
api.get('/projects', (req, res) =>
  res.json(
    all(
      'SELECT p.*,(SELECT count(*) FROM workflows f WHERE f.project_id=p.id) AS workflow_count FROM projects p WHERE p.workspace_id=? ORDER BY created_at DESC',
      req.workspace,
    ),
  ),
);
api.post(
  '/projects',
  requireRole('editor'),
  route((req, res) => {
    const b = z
      .object({ name: z.string().min(1).max(100), description: z.string().max(1000).default('') })
      .parse(req.body);
    const pid = id();
    exec(
      'INSERT INTO projects VALUES(?,?,?,?,?)',
      pid,
      req.workspace,
      b.name,
      b.description,
      now(),
    );
    audit(req.workspace, req.user.id, 'project.created', pid);
    res.status(201).json({ id: pid });
  }),
);
api.get('/workflows', (req, res) =>
  res.json(
    all(
      'SELECT w.*,(SELECT count(*) FROM runs r WHERE r.workflow_id=w.id AND r.parent_id IS NULL) AS run_count FROM workflows w WHERE workspace_id=? ORDER BY updated_at DESC',
      req.workspace,
    ).map(workflowRow),
  ),
);
api.post(
  '/workflows',
  requireRole('editor'),
  route((req, res) => {
    const b = z
      .object({
        name: z.string().min(1).max(100),
        description: z.string().max(2000).optional(),
        projectId: z.string().optional(),
        graph: z.object({
          nodes: z.array(z.any()),
          edges: z.array(z.any()),
          settings: z.any().optional(),
        }),
      })
      .parse(req.body);
    const fid = saveNewWorkflow(req.workspace, b);
    audit(req.workspace, req.user.id, 'workflow.created', fid);
    res.status(201).json(workflowRow(scoped('workflows', fid, req.workspace)));
  }),
);
api.get(
  '/workflows/:fid',
  route((req, res) => res.json(workflowRow(scoped('workflows', req.params.fid, req.workspace)))),
);
api.put(
  '/workflows/:fid',
  requireRole('editor'),
  route((req, res) => {
    const current = scoped('workflows', req.params.fid, req.workspace);
    const b = req.body;
    if (b.revision !== current.revision)
      return res.status(409).json({
        error: 'This workflow changed in another session. Reload before saving.',
        revision: current.revision,
      });
    const graph = cleanGraph(b.graph || decode(current.graph));
    assertNoSecrets(graph);
    const revision = current.revision + 1,
      name = String(b.name || current.name).slice(0, 100);
    if (b.projectId) scoped('projects', b.projectId, req.workspace);
    transaction(() => {
      exec(
        'UPDATE workflows SET name=?,description=?,project_id=?,graph=?,revision=?,updated_at=? WHERE id=?',
        name,
        b.description ?? current.description,
        b.projectId || current.project_id,
        encode(graph),
        revision,
        now(),
        current.id,
      );
      exec(
        'INSERT INTO versions VALUES(?,?,?,?,?,?)',
        id(),
        current.id,
        revision,
        name,
        encode(graph),
        now(),
      );
      audit(req.workspace, req.user.id, 'workflow.saved', current.id);
    });
    res.json(workflowRow(scoped('workflows', current.id, req.workspace)));
  }),
);
api.delete(
  '/workflows/:fid',
  requireRole('editor'),
  route((req, res) => {
    scoped('workflows', req.params.fid, req.workspace);
    if (one('SELECT id FROM applications WHERE workflow_id=?', req.params.fid))
      return res
        .status(409)
        .json({ error: 'Remove the published application before deleting its workflow' });
    exec('DELETE FROM workflows WHERE id=?', req.params.fid);
    audit(req.workspace, req.user.id, 'workflow.deleted', req.params.fid);
    res.json({ ok: true });
  }),
);
api.get(
  '/workflows/:fid/versions',
  route((req, res) => {
    scoped('workflows', req.params.fid, req.workspace);
    res.json(
      all(
        'SELECT * FROM versions WHERE workflow_id=? ORDER BY revision DESC LIMIT 100',
        req.params.fid,
      ).map(workflowRow),
    );
  }),
);
api.post(
  '/validate',
  route((req, res) => res.json({ errors: validateGraph(req.body.graph) })),
);
api.post(
  '/workflows/:fid/runs',
  requireRole('editor'),
  route((req, res) => {
    const w = scoped('workflows', req.params.fid, req.workspace);
    const runId = createRun({
      wid: req.workspace,
      workflowId: w.id,
      graph: decode(w.graph),
      input: req.body.input ?? '',
      mode: req.body.mode || 'preview',
      conversationId: req.body.conversationId || null,
      actor: { userId: req.user.id },
    });
    audit(req.workspace, req.user.id, 'run.started', runId);
    res.status(201).json({ id: runId });
  }),
);
api.post(
  '/workflows/:fid/nodes/:nid/test',
  requireRole('editor'),
  route((req, res) => {
    const w = scoped('workflows', req.params.fid, req.workspace);
    const saved = decode(w.graph);
    const node = saved.nodes.find((n) => n.id === req.params.nid);
    if (!node || ['input', 'output'].includes(node.data.kind))
      throw new Error('Choose an executable workflow component');
    const before = id(),
      after = id();
    const nodes = [
      { id: before, data: { kind: 'input', label: 'Test payload', config: {} } },
      node,
      { id: after, data: { kind: 'output', label: 'Component result', config: {} } },
    ];
    const graph = {
      nodes,
      edges: [
        { id: id(), source: before, target: node.id },
        ...(node.data.kind === 'condition'
          ? ['true', 'false'].map((branch) => ({
              id: id(),
              source: node.id,
              target: after,
              label: branch,
              data: { branch },
            }))
          : [{ id: id(), source: node.id, target: after }]),
      ],
      settings: saved.settings,
    };
    const runId = createRun({
      wid: req.workspace,
      workflowId: w.id,
      graph,
      input: req.body.input,
      mode: req.body.mode || 'preview',
      actor: { userId: req.user.id },
    });
    audit(req.workspace, req.user.id, 'component.tested', `${w.id}:${node.id}`);
    res.status(201).json({ id: runId });
  }),
);
api.get('/runs', (req, res) => {
  const q = '%' + String(req.query.q || '').slice(0, 100) + '%',
    status = req.query.status || '';
  res.json(
    all(
      "SELECT r.*,w.name AS workflow_name FROM runs r LEFT JOIN workflows w ON w.id=r.workflow_id WHERE r.workspace_id=? AND r.parent_id IS NULL AND (r.input LIKE ? OR w.name LIKE ? OR r.id LIKE ?) AND (?='' OR r.status=?) ORDER BY r.created_at DESC LIMIT 300",
      req.workspace,
      q,
      q,
      q,
      status,
      status,
    ).map((r) => ({
      ...r,
      graph: undefined,
      input: decode(r.input),
      output: decode(r.output),
      usage: decode(r.usage),
    })),
  );
});
function runDetails(rid, wid) {
  const run = scoped('runs', rid, wid);
  const order = new Map(decode(run.graph).nodes.map((node, i) => [node.id, i]));
  const steps = all('SELECT * FROM steps WHERE run_id=?', rid).sort((a, b) => {
    if (a.started_at && b.started_at)
      return (
        a.started_at.localeCompare(b.started_at) || order.get(a.node_id) - order.get(b.node_id)
      );
    if (a.started_at) return -1;
    if (b.started_at) return 1;
    return order.get(a.node_id) - order.get(b.node_id);
  });
  return {
    ...run,
    graph: decode(run.graph),
    input: decode(run.input),
    output: decode(run.output),
    usage: decode(run.usage),
    steps: steps.map((s) => ({
      ...s,
      input: decode(s.input),
      output: decode(s.output),
      checkpoint: undefined,
    })),
    approvals: all(
      "SELECT a.id,s.node_id,a.tool_name,a.input FROM tool_approvals a JOIN steps s ON s.id=a.step_id WHERE s.run_id=? AND a.status='pending'",
      rid,
    ).map((a) => ({ ...a, input: decode(a.input) })),
    events: all('SELECT * FROM events WHERE run_id=? ORDER BY id LIMIT 3000', rid).map((e) =>
      jsonRow(e, 'data'),
    ),
    children: all(
      'SELECT id,status,parent_id FROM runs WHERE workspace_id=? AND parent_id LIKE ?',
      wid,
      rid + ':%',
    ),
    actions: all('SELECT id,tool_id,status,error FROM actions WHERE run_id=?', rid),
  };
}
api.get(
  '/runs/:rid',
  route((req, res) => res.json(runDetails(req.params.rid, req.workspace))),
);
function eventStream(req, res, runId) {
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  res.flushHeaders();
  let cursor = Number(req.headers['last-event-id'] || req.query.after || 0);
  const timer = setInterval(() => {
    let allowed = req.user
      ? one(
          'SELECT m.role FROM members m JOIN sessions s ON s.user_id=m.user_id WHERE m.workspace_id=? AND m.user_id=? AND s.token=? AND s.expires_at>?',
          req.workspace,
          req.user.id,
          hash(req.cookies.relay_session || ''),
          Date.now(),
        )
      : one(
          'SELECT * FROM applications WHERE id=? AND token_hash=?',
          req.application?.id,
          hash(req.headers.authorization?.replace(/^Bearer /i, '') || ''),
        );
    if (!req.user && allowed) {
      const settings = decode(allowed.settings);
      allowed =
        publicationAuthorized(allowed) &&
        !settings.tokenRevoked &&
        settings.tokenExpiresAt > Date.now() &&
        settings.tokenScopes?.includes('read');
    }
    if (!allowed) {
      clearInterval(timer);
      res.end();
      return;
    }
    const events = all(
      'SELECT * FROM events WHERE run_id=? AND id>? ORDER BY id LIMIT 100',
      runId,
      cursor,
    );
    for (const event of events) {
      cursor = event.id;
      res.write(`id: ${event.id}\ndata: ${encode({ ...event, data: decode(event.data) })}\n\n`);
    }
    res.write(': heartbeat\n\n');
    const r = one('SELECT status FROM runs WHERE id=?', runId);
    if (r && ['completed', 'failed', 'cancelled'].includes(r.status) && !events.length) {
      clearInterval(timer);
      res.end();
    }
  }, 150);
  req.on('close', () => clearInterval(timer));
}
api.get(
  '/runs/:rid/events',
  route((req, res) => {
    scoped('runs', req.params.rid, req.workspace);
    eventStream(req, res, req.params.rid);
  }),
);
api.post(
  '/runs/:rid/cancel',
  requireRole('editor'),
  route((req, res) => {
    scoped('runs', req.params.rid, req.workspace);
    cancelRun(req.params.rid);
    audit(req.workspace, req.user.id, 'run.cancelled', req.params.rid);
    res.json({ ok: true });
  }),
);
api.post(
  '/runs/:rid/retry',
  requireRole('editor'),
  route((req, res) => {
    scoped('runs', req.params.rid, req.workspace);
    retryRun(req.params.rid);
    audit(req.workspace, req.user.id, 'run.retried', req.params.rid);
    res.json({ ok: true });
  }),
);
api.post(
  '/runs/:rid/approve',
  requireRole('editor'),
  route((req, res) => {
    scoped('runs', req.params.rid, req.workspace);
    approveStep(
      req.params.rid,
      String(req.body.nodeId),
      !!req.body.approved,
      String(req.body.feedback || ''),
    );
    audit(req.workspace, req.user.id, 'run.approval', req.params.rid);
    res.json({ ok: true });
  }),
);
api.get(
  '/runs/:rid/download',
  route((req, res) => {
    const details = runDetails(req.params.rid, req.workspace);
    res.attachment(`relay-run-${details.id.slice(0, 8)}.json`).json(details);
  }),
);
api.get('/agents', (req, res) =>
  res.json(
    all('SELECT * FROM agents WHERE workspace_id=? ORDER BY created_at DESC', req.workspace).map(
      (r) => jsonRow(r),
    ),
  ),
);
api.post(
  '/agents',
  requireRole('editor'),
  route((req, res) => {
    const b = z
      .object({ name: z.string().min(1).max(100), config: z.record(z.string(), z.any()) })
      .parse(req.body);
    assertNoSecrets(b.config);
    const aid = id();
    exec(
      'INSERT INTO agents VALUES(?,?,?,?,?)',
      aid,
      req.workspace,
      b.name,
      encode(b.config),
      now(),
    );
    audit(req.workspace, req.user.id, 'agent.created', aid);
    res.status(201).json({ id: aid });
  }),
);
api.put(
  '/agents/:aid',
  requireRole('editor'),
  route((req, res) => {
    const a = scoped('agents', req.params.aid, req.workspace);
    assertNoSecrets(req.body.config);
    exec(
      'UPDATE agents SET name=?,config=? WHERE id=?',
      String(req.body.name || a.name),
      encode(req.body.config || decode(a.config)),
      a.id,
    );
    res.json({ ok: true });
  }),
);
api.delete(
  '/agents/:aid',
  requireRole('editor'),
  route((req, res) => {
    scoped('agents', req.params.aid, req.workspace);
    exec('DELETE FROM agents WHERE id=?', req.params.aid);
    res.json({ ok: true });
  }),
);
api.get('/connections', (req, res) =>
  res.json(all('SELECT * FROM connections WHERE workspace_id=?', req.workspace).map(noSecret)),
);
api.delete(
  '/model-cache',
  requireRole('administrator'),
  route((req, res) => {
    exec('DELETE FROM model_cache WHERE workspace_id=?', req.workspace);
    audit(req.workspace, req.user.id, 'model.cache_cleared', req.workspace);
    res.json({ ok: true });
  }),
);
const connectionSchema = z
  .object({
    name: z.string().min(1).max(100),
    provider: z.enum(['openai-compatible', 'anthropic', 'credential']),
    endpoint: z.union([z.url(), z.literal('')]).default(''),
    model: z.string().max(120).default(''),
    secret: z.string().trim().max(5000).default(''),
    config: z.record(z.string(), z.any()).default({}),
  })
  .superRefine((value, ctx) => {
    if (value.provider !== 'credential' && /^OPENAI_API_KEY\s*=/.test(value.secret))
      ctx.addIssue({
        code: 'custom',
        message: 'Paste only the API key value, without OPENAI_API_KEY= or surrounding quotes',
      });
    if (value.provider !== 'credential' && (!value.endpoint || !value.model))
      ctx.addIssue({
        code: 'custom',
        message: 'Model connections need an endpoint and model identifier',
      });
  });
api.post(
  '/connections',
  requireRole('administrator'),
  route((req, res) => {
    const b = connectionSchema.parse(req.body),
      cid = id();
    if (b.provider === 'credential' && !b.secret) throw new Error('Enter a credential to store');
    assertNoSecrets(b.config);
    exec(
      'INSERT INTO connections VALUES(?,?,?,?,?,?,?,?,?)',
      cid,
      req.workspace,
      b.name,
      b.provider,
      b.endpoint,
      b.model,
      encrypt(b.secret),
      encode(b.config),
      now(),
    );
    audit(req.workspace, req.user.id, 'connection.created', cid);
    res.status(201).json(noSecret(scoped('connections', cid, req.workspace)));
  }),
);
api.put(
  '/connections/:cid',
  requireRole('administrator'),
  route((req, res) => {
    const current = scoped('connections', req.params.cid, req.workspace);
    const b = connectionSchema.parse(req.body);
    assertNoSecrets(b.config);
    exec(
      'UPDATE connections SET name=?,provider=?,endpoint=?,model=?,secret=?,config=? WHERE id=?',
      b.name,
      b.provider,
      b.endpoint,
      b.model,
      b.secret ? encrypt(b.secret) : current.secret,
      encode(b.config),
      current.id,
    );
    audit(req.workspace, req.user.id, 'connection.updated', current.id);
    res.json(noSecret(scoped('connections', current.id, req.workspace)));
  }),
);
api.delete(
  '/connections/:cid',
  requireRole('administrator'),
  route((req, res) => {
    scoped('connections', req.params.cid, req.workspace);
    exec('DELETE FROM connections WHERE id=?', req.params.cid);
    audit(req.workspace, req.user.id, 'connection.deleted', req.params.cid);
    res.json({ ok: true });
  }),
);
api.get(
  '/connections/:cid/models',
  requireRole('administrator'),
  route(async (req, res) => {
    const c = scoped('connections', req.params.cid, req.workspace);
    if (c.provider !== 'openai-compatible')
      throw new Error('Model discovery requires an OpenAI-compatible provider');
    const secret = decrypt(c.secret),
      config = decode(c.config);
    const r = await safeFetch(
      c.endpoint.replace(/\/$/, '') + '/models',
      {
        headers: secret ? { Authorization: 'Bearer ' + secret } : {},
        signal: AbortSignal.timeout(15000),
        noRedirect: true,
      },
      !!config.allowPrivate,
    );
    if (!r.ok) throw new Error('Model discovery returned HTTP ' + r.status);
    const data = JSON.parse(await responseText(r, 500000));
    if (!Array.isArray(data.data)) throw new Error('Provider returned an unsupported model list');
    res.json(
      data.data
        .map((v) => String(v.id || ''))
        .filter(Boolean)
        .sort()
        .slice(0, 500),
    );
  }),
);
api.post(
  '/connections/:cid/test',
  requireRole('administrator'),
  route(async (req, res) => {
    const c = scoped('connections', req.params.cid, req.workspace);
    const r = await modelCall(
      { wid: req.workspace, mode: 'live', signal: AbortSignal.timeout(15000), onToken: () => {} },
      { connectionId: c.id, maxTokens: 20 },
      [{ role: 'user', content: 'Reply with OK.' }],
    );
    res.json({ ok: true, usage: r.usage, message: 'Connection responded successfully' });
  }),
);
api.get('/tools', (req, res) =>
  res.json(all('SELECT * FROM tools WHERE workspace_id=?', req.workspace).map((r) => jsonRow(r))),
);
api.post(
  '/tools',
  requireRole('administrator'),
  route((req, res) => {
    const b = z
      .object({
        name: z.string().min(1).max(100),
        kind: z.enum(Object.keys(toolHandlers)),
        config: z.record(z.string(), z.any()),
      })
      .parse(req.body);
    assertNoSecrets(b.config);
    const tid = id();
    exec(
      'INSERT INTO tools VALUES(?,?,?,?,?,?)',
      tid,
      req.workspace,
      b.name,
      b.kind,
      encode(b.config),
      now(),
    );
    audit(req.workspace, req.user.id, 'tool.created', tid);
    res.status(201).json({ id: tid });
  }),
);
api.put(
  '/tools/:tid',
  requireRole('administrator'),
  route((req, res) => {
    const t = scoped('tools', req.params.tid, req.workspace);
    assertNoSecrets(req.body.config);
    exec(
      'UPDATE tools SET name=?,config=? WHERE id=?',
      req.body.name || t.name,
      encode(req.body.config || decode(t.config)),
      t.id,
    );
    res.json({ ok: true });
  }),
);
api.delete(
  '/tools/:tid',
  requireRole('administrator'),
  route((req, res) => {
    scoped('tools', req.params.tid, req.workspace);
    exec('DELETE FROM tools WHERE id=?', req.params.tid);
    res.json({ ok: true });
  }),
);
api.post(
  '/tools/:tid/test',
  requireRole('administrator'),
  route(async (req, res) => {
    const tool = jsonRow(scoped('tools', req.params.tid, req.workspace));
    if (tool.config.requireApproval) {
      const graph = {
        nodes: [
          { id: 'input', data: { kind: 'input', label: 'Test payload', config: {} } },
          {
            id: 'tool',
            data: {
              kind: 'tool',
              label: tool.name,
              config: { kind: tool.kind, toolSnapshot: tool },
            },
          },
          { id: 'output', data: { kind: 'output', label: 'Tool result', config: {} } },
        ],
        edges: [
          { id: 'input-tool', source: 'input', target: 'tool' },
          { id: 'tool-output', source: 'tool', target: 'output' },
        ],
      };
      const runId = createRun({
        wid: req.workspace,
        graph,
        input: req.body.input || {},
        mode: 'preview',
      });
      return res.status(202).json({
        output: { runId, message: 'Review and approve this tool test in execution history' },
      });
    }
    const testId = id();
    const result = await executeTool(
      {
        wid: req.workspace,
        runId: 'test-' + testId,
        stepId: testId,
        signal: AbortSignal.timeout(15000),
      },
      tool,
      req.body.input || {},
    );
    audit(req.workspace, req.user.id, 'tool.tested', tool.id);
    res.json({ output: result });
  }),
);
api.get('/collections', (req, res) =>
  res.json(
    all(
      'SELECT c.*,(SELECT count(*) FROM sources s WHERE s.collection_id=c.id) AS source_count,(SELECT count(*) FROM chunks k WHERE k.collection_id=c.id) AS chunk_count FROM collections c WHERE c.workspace_id=?',
      req.workspace,
    ).map((r) => jsonRow(r)),
  ),
);
const collectionConfig = z.object({
  retrieval: z.enum(['lexical', 'semantic', 'hybrid']).default('lexical'),
  chunkSize: z.number().min(200).max(4000).default(1000),
  overlap: z.number().min(0).max(1000).default(150),
  embeddingConnectionId: z.string().optional(),
  embeddingModel: z.string().max(200).optional(),
});
api.post(
  '/collections',
  requireRole('editor'),
  route((req, res) => {
    const b = z
        .object({
          name: z.string().min(1).max(100),
          config: collectionConfig.default({ retrieval: 'lexical', chunkSize: 1000, overlap: 150 }),
        })
        .parse(req.body),
      cid = id();
    if (b.config.embeddingConnectionId)
      scoped('connections', b.config.embeddingConnectionId, req.workspace);
    exec(
      'INSERT INTO collections VALUES(?,?,?,?,?)',
      cid,
      req.workspace,
      b.name,
      encode(b.config),
      now(),
    );
    audit(req.workspace, req.user.id, 'collection.created', cid);
    res.status(201).json({ id: cid });
  }),
);
api.get(
  '/collections/:cid/sources',
  route((req, res) => {
    scoped('collections', req.params.cid, req.workspace);
    res.json(
      all(
        'SELECT id,name,url,metadata,status,progress,error,created_at,length(content) AS size FROM sources WHERE collection_id=? AND workspace_id=?',
        req.params.cid,
        req.workspace,
      ),
    );
  }),
);
api.put(
  '/collections/:cid',
  requireRole('editor'),
  route((req, res) => {
    const c = scoped('collections', req.params.cid, req.workspace);
    const config = collectionConfig.parse(req.body.config);
    if (config.embeddingConnectionId)
      scoped('connections', config.embeddingConnectionId, req.workspace);
    exec('UPDATE collections SET config=? WHERE id=?', encode(config), c.id);
    for (const s of all('SELECT id FROM sources WHERE collection_id=?', c.id)) {
      exec(
        "UPDATE sources SET status='queued',progress=0,index_generation=index_generation+1 WHERE id=?",
        s.id,
      );
      setImmediate(() => indexSource(s.id));
    }
    audit(req.workspace, req.user.id, 'collection.reconfigured', c.id);
    res.json({ ok: true });
  }),
);
api.delete(
  '/collections/:cid',
  requireRole('editor'),
  route((req, res) => {
    scoped('collections', req.params.cid, req.workspace);
    transaction(() => {
      exec(
        'DELETE FROM chunk_search WHERE collection_id=? AND workspace_id=?',
        req.params.cid,
        req.workspace,
      );
      exec('DELETE FROM collections WHERE id=?', req.params.cid);
    });
    res.json({ ok: true });
  }),
);
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024, files: 1, fields: 10, parts: 11, fieldSize: 4096 },
});
api.post(
  '/collections/:cid/upload',
  requireRole('editor'),
  localRateLimit({ limit: 10, windowMs: 60000 }),
  upload.single('file'),
  route(async (req, res) => {
    scoped('collections', req.params.cid, req.workspace);
    if (!req.file) throw new Error('Choose a document to upload');
    const content = await parseUpload(req.file.buffer, req.file.originalname);
    const sid = addSource(req.workspace, req.params.cid, req.file.originalname, content);
    audit(req.workspace, req.user.id, 'source.uploaded', sid);
    res.status(201).json({ id: sid });
  }),
);
api.post(
  '/collections/:cid/website',
  requireRole('editor'),
  route(async (req, res) => {
    scoped('collections', req.params.cid, req.workspace);
    const ids = await crawlWebsite(
      req.workspace,
      req.params.cid,
      z.url().parse(req.body.url),
      req.body.maxPages,
    );
    const sid = ids[0];
    audit(req.workspace, req.user.id, 'source.ingested', sid);
    res.status(201).json({ id: sid, ids });
  }),
);
api.post(
  '/collections/:cid/retrieve',
  route(async (req, res) =>
    res.json({
      sources: await retrieve(
        req.workspace,
        req.params.cid,
        String(req.body.query || ''),
        req.body.topK,
        req.body.options,
        { kind: 'user', id: req.user.id },
      ),
    }),
  ),
);
api.put(
  '/sources/:sid/metadata',
  requireRole('editor'),
  route((req, res) => {
    scoped('sources', req.params.sid, req.workspace);
    const metadata = z
      .record(
        z.string().regex(/^[A-Za-z0-9_-]{1,60}$/),
        z.union([z.string().max(500), z.number(), z.boolean()]),
      )
      .refine((v) => Object.keys(v).length <= 20)
      .parse(req.body.metadata);
    exec('UPDATE sources SET metadata=? WHERE id=?', encode(metadata), req.params.sid);
    audit(req.workspace, req.user.id, 'source.metadata', req.params.sid);
    res.json({ ok: true });
  }),
);
api.post(
  '/sources/:sid/reindex',
  requireRole('editor'),
  route((req, res) => {
    scoped('sources', req.params.sid, req.workspace);
    exec("UPDATE sources SET status='queued',progress=0 WHERE id=?", req.params.sid);
    setImmediate(() => indexSource(req.params.sid));
    res.json({ ok: true });
  }),
);
api.delete(
  '/sources/:sid',
  requireRole('editor'),
  route((req, res) => {
    scoped('sources', req.params.sid, req.workspace);
    deleteSource(req.params.sid, req.workspace);
    res.json({ ok: true });
  }),
);
api.get('/memories', (req, res) =>
  res.json(
    all(
      'SELECT * FROM memories WHERE workspace_id=? ORDER BY created_at DESC LIMIT 300',
      req.workspace,
    ),
  ),
);
api.delete(
  '/memories/:mid',
  requireRole('editor'),
  route((req, res) => {
    scoped('memories', req.params.mid, req.workspace);
    exec('DELETE FROM memories WHERE id=?', req.params.mid);
    audit(req.workspace, req.user.id, 'memory.deleted', req.params.mid);
    res.json({ ok: true });
  }),
);
api.get('/artifacts', (req, res) =>
  res.json(
    all(
      'SELECT id,name,run_id,created_at,length(content) AS size FROM artifacts WHERE workspace_id=? ORDER BY created_at DESC',
      req.workspace,
    ),
  ),
);
api.get(
  '/artifacts/:aid',
  route((req, res) => {
    const file = scoped('artifacts', req.params.aid, req.workspace);
    res
      .attachment(file.name.replace(/[^\w. -]/g, '_'))
      .type('text/plain')
      .send(file.content);
  }),
);
api.get('/members', (req, res) =>
  res.json({
    members: all(
      'SELECT u.id,u.name,u.email,m.role FROM members m JOIN users u ON u.id=m.user_id WHERE m.workspace_id=?',
      req.workspace,
    ),
    invitations: all(
      'SELECT id,email,role,expires_at,accepted FROM invitations WHERE workspace_id=?',
      req.workspace,
    ),
  }),
);
api.post(
  '/invitations',
  requireRole('administrator'),
  route((req, res) => {
    const b = z
      .object({ email: z.email(), role: z.enum(['administrator', 'editor', 'viewer']) })
      .parse(req.body);
    if (b.role === 'administrator' && req.role !== 'owner')
      return res.status(403).json({ error: 'Only the owner can invite administrators' });
    const token = crypto.randomBytes(24).toString('hex'),
      iid = id();
    exec(
      'INSERT INTO invitations VALUES(?,?,?,?,?,?,?)',
      iid,
      req.workspace,
      b.email.toLowerCase(),
      b.role,
      hash(token),
      Date.now() + 7 * 86400000,
      0,
    );
    audit(req.workspace, req.user.id, 'invitation.created', iid);
    recordInvitation(iid, req.user.id);
    res.status(201).json({ token, url: `${req.protocol}://${req.get('host')}/?invite=${token}` });
  }),
);
api.put(
  '/members/:uid',
  requireRole('administrator'),
  route((req, res) => {
    const role = z.enum(['administrator', 'editor', 'viewer']).parse(req.body.role);
    const m = one(
      'SELECT role FROM members WHERE workspace_id=? AND user_id=?',
      req.workspace,
      req.params.uid,
    );
    if (
      !m ||
      m.role === 'owner' ||
      ((m.role === 'administrator' || role === 'administrator') && req.role !== 'owner')
    )
      return res.status(403).json({
        error: 'Only the owner can manage administrators; ownership cannot be changed here',
      });
    exec(
      'UPDATE members SET role=? WHERE workspace_id=? AND user_id=?',
      role,
      req.workspace,
      req.params.uid,
    );
    audit(req.workspace, req.user.id, 'member.role.changed', req.params.uid);
    revokeMemberDelegations(req.workspace, req.params.uid);
    res.json({ ok: true });
  }),
);
api.delete(
  '/members/:uid',
  requireRole('administrator'),
  route((req, res) => {
    const m = one(
      'SELECT role FROM members WHERE workspace_id=? AND user_id=?',
      req.workspace,
      req.params.uid,
    );
    if (!m || m.role === 'owner' || (m.role === 'administrator' && req.role !== 'owner'))
      return res.status(403).json({ error: 'This member cannot be removed by your role' });
    exec('DELETE FROM members WHERE workspace_id=? AND user_id=?', req.workspace, req.params.uid);
    revokeMemberDelegations(req.workspace, req.params.uid);
    audit(req.workspace, req.user.id, 'member.removed', req.params.uid);
    res.json({ ok: true });
  }),
);
api.get('/audit', requireRole('administrator'), (req, res) =>
  res.json(
    all(
      'SELECT a.*,u.name AS user_name FROM audit a LEFT JOIN users u ON u.id=a.user_id WHERE a.workspace_id=? ORDER BY created_at DESC LIMIT 300',
      req.workspace,
    ),
  ),
);
api.put(
  '/settings',
  requireRole('administrator'),
  route((req, res) => {
    const current = one('SELECT * FROM workspaces WHERE id=?', req.workspace);
    const b = z
      .object({
        name: z.string().min(1).max(100),
        settings: z.record(z.string(), z.any()).default({}),
      })
      .parse(req.body);
    assertNoSecrets(b.settings);
    if (b.settings.historyRetentionDays != null)
      z.number().int().min(0).max(3650).parse(b.settings.historyRetentionDays);
    exec(
      'UPDATE workspaces SET name=?,settings=? WHERE id=?',
      b.name,
      encode(b.settings),
      req.workspace,
    );
    audit(req.workspace, req.user.id, 'workspace.updated', req.workspace);
    res.json({ ok: true });
  }),
);
api.get('/applications', (req, res) =>
  res.json(
    all(
      'SELECT a.*,v.revision FROM applications a JOIN versions v ON a.version_id=v.id WHERE a.workspace_id=?',
      req.workspace,
    ).map((a) => {
      const { token_hash, graph_snapshot, ...rest } = a;
      return jsonRow(rest, 'settings');
    }),
  ),
);
api.post(
  '/applications',
  requireRole('administrator'),
  localRateLimit({ limit: 20, windowMs: 60000 }),
  route((req, res) => {
    const w = scoped('workflows', req.body.workflowId, req.workspace);
    const errors = validateGraph(decode(w.graph));
    if (errors.length) throw new Error(errors.join('; '));
    const v = one('SELECT * FROM versions WHERE workflow_id=? AND revision=?', w.id, w.revision);
    const settings = req.body.settings || {
      public: false,
      mode: 'preview',
      welcome: 'How can this team help you?',
      accent: '#b3f576',
    };
    const token = crypto.randomBytes(32).toString('hex'),
      aid = id();
    assertNoSecrets(settings);
    settings.tokenExpiresAt = Date.now() + 90 * 86400000;
    settings.tokenRevoked = false;
    settings.tokenScopes = ['invoke', 'read', 'webhook', 'mcp'];
    settings.publisherId = req.user.id;
    exec(
      'INSERT INTO applications(id,workspace_id,workflow_id,version_id,name,settings,token_hash,created_at,graph_snapshot) VALUES(?,?,?,?,?,?,?,?,?)',
      aid,
      req.workspace,
      w.id,
      v.id,
      String(req.body.name || w.name).slice(0, 100),
      encode(settings),
      hash(token),
      now(),
      encode(snapshotGraph(decode(w.graph), req.workspace, [w.id])),
    );
    audit(req.workspace, req.user.id, 'application.published', aid);
    res.status(201).json({ id: aid, token, revision: w.revision });
  }),
);
api.put(
  '/applications/:aid',
  requireRole('administrator'),
  route((req, res) => {
    const a = scoped('applications', req.params.aid, req.workspace);
    assertNoSecrets(req.body.settings);
    const settings = {
      ...(req.body.settings || decode(a.settings)),
      tokenExpiresAt: decode(a.settings).tokenExpiresAt,
      tokenRevoked: decode(a.settings).tokenRevoked,
      tokenScopes: decode(a.settings).tokenScopes,
      publisherId: decode(a.settings).publisherId,
    };
    exec(
      'UPDATE applications SET name=?,settings=? WHERE id=?',
      req.body.name || a.name,
      encode(settings),
      a.id,
    );
    if (req.body.publishLatest) {
      const w = scoped('workflows', a.workflow_id, req.workspace);
      const errors = validateGraph(decode(w.graph));
      if (errors.length) throw new Error(errors.join('; '));
      const v = one('SELECT id FROM versions WHERE workflow_id=? AND revision=?', w.id, w.revision);
      exec(
        'UPDATE applications SET version_id=?,graph_snapshot=? WHERE id=?',
        v.id,
        encode(snapshotGraph(decode(w.graph), req.workspace, [w.id])),
        a.id,
      );
    }
    audit(req.workspace, req.user.id, 'application.updated', a.id);
    res.json({ ok: true });
  }),
);
api.post(
  '/applications/:aid/rotate',
  requireRole('administrator'),
  route((req, res) => {
    const a = scoped('applications', req.params.aid, req.workspace);
    const token = crypto.randomBytes(32).toString('hex');
    const scopes = z
      .array(z.enum(['invoke', 'read', 'webhook', 'mcp']))
      .min(1)
      .max(4)
      .parse(req.body.scopes || ['invoke', 'read', 'webhook', 'mcp']);
    const ttl = z
      .number()
      .int()
      .min(1)
      .max(90)
      .parse(req.body.expiresInDays || 90);
    exec(
      'UPDATE applications SET token_hash=?,settings=? WHERE id=?',
      hash(token),
      encode({
        ...decode(a.settings),
        tokenExpiresAt: Date.now() + ttl * 86400000,
        tokenRevoked: false,
        tokenScopes: scopes,
        publisherId: req.user.id,
      }),
      a.id,
    );
    audit(req.workspace, req.user.id, 'application.token.rotated', a.id);
    res.json({ token });
  }),
);
api.delete(
  '/applications/:aid',
  requireRole('administrator'),
  route((req, res) => {
    scoped('applications', req.params.aid, req.workspace);
    exec('DELETE FROM applications WHERE id=?', req.params.aid);
    audit(req.workspace, req.user.id, 'application.removed', req.params.aid);
    res.json({ ok: true });
  }),
);
api.post(
  '/applications/:aid/revoke',
  requireRole('administrator'),
  route((req, res) => {
    const a = scoped('applications', req.params.aid, req.workspace);
    exec(
      'UPDATE applications SET settings=? WHERE id=?',
      encode({ ...decode(a.settings), tokenRevoked: true }),
      a.id,
    );
    audit(req.workspace, req.user.id, 'application.token.revoked', a.id);
    res.json({ ok: true });
  }),
);
function appAccess(req, res, next) {
  const a = one('SELECT * FROM applications WHERE id=?', req.params.aid);
  if (!a) return res.status(404).json({ error: 'Application was not found' });
  if (!publicationAuthorized(a))
    return res.status(403).json({ error: 'Publication requires administrator review' });
  const token = req.headers.authorization?.replace(/^Bearer /i, '') || '';
  const settings = decode(a.settings);
  const valid =
    token &&
    hash(token) === a.token_hash &&
    !settings.tokenRevoked &&
    Number.isFinite(settings.tokenExpiresAt) &&
    settings.tokenExpiresAt > Date.now();
  if (token && !valid)
    return res.status(401).json({ error: 'Application token is invalid, expired or revoked' });
  const permission = req.path.includes('/runs/')
    ? 'read'
    : req.path.endsWith('/webhook')
      ? 'webhook'
      : req.path.endsWith('/mcp')
        ? 'mcp'
        : 'invoke';
  if (valid && !settings.tokenScopes?.includes(permission))
    return res.status(403).json({ error: 'Application token lacks the required scope' });
  if (!valid && !(req.path.startsWith('/apps/') && settings.public))
    return res.status(401).json({ error: 'An application access token is required' });
  if (!valid && req.params.rid && !guestRunAccess(req, req.params.rid))
    return res.status(403).json({ error: 'This browser cannot read that run' });
  req.publicGuest = !valid;
  req.application = { ...a, settings };
  next();
}
function queueApplication(a, input, conversationId = null, publicGuest = false) {
  const version = one('SELECT graph FROM versions WHERE id=?', a.version_id);
  const count = one(
    'SELECT count(*) AS count FROM runs WHERE workspace_id=? AND created_at>?',
    a.workspace_id,
    new Date(Date.now() - 60000).toISOString(),
  ).count;
  if (count >= 60) {
    const error = new Error('Workspace application rate limit reached');
    error.status = 429;
    throw error;
  }
  const runId = createRun({
    wid: a.workspace_id,
    workflowId: a.workflow_id,
    versionId: a.version_id,
    graph: decode(a.graph_snapshot || version.graph),
    input,
    mode: a.settings.mode || 'preview',
    conversationId,
    actor: { applicationId: a.id, tokenHash: publicGuest ? null : a.token_hash, publicGuest },
  });
  exec('UPDATE runs SET application_id=? WHERE id=?', a.id, runId);
  return { id: runId, status: 'queued', events: `/api/apps/${a.id}/runs/${runId}/events` };
}
function invoke(req, res) {
  const a = req.application;
  const result = queueApplication(
    a,
    Object.hasOwn(req.body, 'input') ? req.body.input : req.body,
    req.body.conversationId || null,
    req.publicGuest,
  );
  if (req.publicGuest) issueGuestRun(res, a.id, result.id);
  if (req.path.endsWith('/webhook')) audit(a.workspace_id, 'application', 'webhook.accepted', a.id);
  res.status(202).json(result);
}
registerApplicationMcp(app, appAccess, {
  invoke: queueApplication,
  status: (a, runId) => {
    const r = scoped('runs', runId, a.workspace_id);
    if (r.application_id !== a.id) throw new Error('Run belongs to another application');
    return runDetails(r.id, r.workspace_id);
  },
});
app.post('/api/apps/:aid/invoke', appAccess, route(invoke));
app.post(
  '/api/apps/:aid/webhook',
  appAccess,
  route((req, res) => {
    consumeWebhook(req.application, req.headers['idempotency-key']);
    invoke(req, res);
  }),
);
app.get(
  '/api/apps/:aid/runs/:rid',
  appAccess,
  route((req, res) => {
    const r = scoped('runs', req.params.rid, req.application.workspace_id);
    if (r.application_id !== req.application.id)
      return res.status(403).json({ error: 'Run belongs to another application version' });
    res.json(runDetails(r.id, r.workspace_id));
  }),
);
app.get(
  '/api/apps/:aid/runs/:rid/events',
  appAccess,
  route((req, res) => {
    const r = scoped('runs', req.params.rid, req.application.workspace_id);
    if (r.application_id !== req.application.id)
      return res.status(403).json({ error: 'Run belongs to another application version' });
    eventStream(req, res, r.id);
  }),
);
app.get(
  '/apps/:aid/meta',
  appAccess,
  route((req, res) => {
    const a = one('SELECT * FROM applications WHERE id=?', req.params.aid);
    if (!a) return res.status(404).json({ error: 'Application was not found' });
    const settings = decode(a.settings);
    res.json({
      id: a.id,
      name: a.name,
      settings: {
        welcome: settings.welcome,
        accent: settings.accent,
        public: settings.public,
        mode: settings.mode,
      },
    });
  }),
);
app.post('/apps/:aid/invoke', appAccess, route(invoke));
app.get(
  '/apps/:aid/runs/:rid',
  appAccess,
  route((req, res) => {
    const r = scoped('runs', req.params.rid, req.application.workspace_id);
    if (r.application_id !== req.application.id)
      return res.status(403).json({ error: 'Run belongs to another application' });
    res.json({ id: r.id, status: r.status, output: decode(r.output), error: r.error });
  }),
);
app.get('/widget.js', (req, res) => {
  res
    .set('Cross-Origin-Resource-Policy', 'cross-origin')
    .type('application/javascript')
    .send(
      `(()=>{const script=document.currentScript;const id=script.dataset.app;const origin=new URL(script.src).origin;const button=document.createElement('button');button.textContent='Chat with our team';button.style.cssText='position:fixed;bottom:24px;right:24px;background:#151a20;color:#c5ff89;border:0;border-radius:24px;padding:16px 22px;cursor:pointer;z-index:99999;font:14px system-ui';const frame=document.createElement('iframe');frame.src=origin+'/apps/'+encodeURIComponent(id);frame.title='Agent chat';frame.style.cssText='position:fixed;bottom:84px;right:24px;width:380px;max-width:calc(100vw - 48px);height:560px;max-height:calc(100vh - 110px);border:1px solid #333;border-radius:18px;display:none;z-index:99999';button.onclick=()=>frame.style.display=frame.style.display==='none'?'block':'none';document.body.append(frame,button);})();`,
    );
});
app.use('/apps/:aid', (req, res, next) => {
  const a = one('SELECT settings FROM applications WHERE id=?', req.params.aid);
  if (a && decode(a.settings).public) res.removeHeader('X-Frame-Options');
  next();
});
const dist = path.resolve('dist');
if (fs.existsSync(dist)) {
  app.use(express.static(dist));
  app.get('/{*path}', (req, res) => {
    if (req.path.startsWith('/api/')) return res.status(404).json({ error: 'Endpoint not found' });
    // Anchor the trusted root so a hidden parent directory (e.g. .codex worktrees)
    // is not interpreted as a requested dotfile by Express/send.
    res.sendFile('index.html', { root: dist });
  });
} else
  app.get('/apps/:aid', (req, res) => res.redirect(`http://127.0.0.1:5173/apps/${req.params.aid}`));
app.use((error, req, res, next) => {
  if (res.headersSent) return next(error);
  const status = error instanceof z.ZodError ? 400 : error.status || 400;
  res.status(status).json({
    error:
      error instanceof z.ZodError
        ? error.issues.map((i) => i.path.join('.') + ': ' + i.message).join('; ')
        : safeError(error),
  });
});
const stopEngine = process.env.ENGINE_ROLE === 'api' ? () => {} : startEngine({ maintenance });
registerPlatform(api);
const port = Number(process.env.PORT) || 4311;
const server = app.listen(port, process.env.HOST || '127.0.0.1', () =>
  console.log(`Relay API listening on http://127.0.0.1:${port}`),
);
process.on('SIGTERM', () => {
  stopEngine();
  server.close(() => process.exit(0));
});
export { app, server };
