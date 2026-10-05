import { AccountSecurity } from './security';
import { useState, useEffect, useRef } from 'react';
import {
  Search,
  Play,
  Square,
  RefreshCw,
  Download,
  ChevronRight,
  ArrowUpRight,
  Clock,
  Check,
  AlertTriangle,
  FileText,
  Plus,
  Globe,
  Copy,
  ExternalLink,
  Users,
  Shield,
  Trash2,
  Zap,
  Activity,
  Network,
  Send,
  ArrowRight,
  ThumbsUp,
  ThumbsDown,
  BookOpen,
  Layers,
} from 'lucide-react';
import { api, pretty, date, duration, type PageProps, type Navigate } from './api';
import { useData } from './pages';
import {
  Button,
  Badge,
  Empty,
  Modal,
  Field,
  Select,
  PageHeader,
  Loading,
  JsonField,
  Confirm,
} from './ui';
const editable = (r: string) => r !== 'viewer',
  admin = (r: string) => ['owner', 'administrator'].includes(r);
export function RunTable({ runs, go }: { runs: any[]; go: Navigate }) {
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Workflow</th>
            <th>Status</th>
            <th>Mode</th>
            <th>Duration</th>
            <th>Started</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {runs.map((r) => (
            <tr
              key={r.id}
              onClick={() => go('history', r.id)}
              tabIndex={0}
              onKeyDown={(e) => {
                if (e.key === 'Enter') go('history', r.id);
              }}
            >
              <td>
                <span className="table-name">
                  <Network size={17} />
                  <span>
                    <strong>{r.workflow_name || 'Workflow run'}</strong>
                    <small>{r.id.slice(0, 8)}</small>
                  </span>
                </span>
              </td>
              <td>
                <Badge status={r.status} />
              </td>
              <td>
                <span className="mode-label">
                  {r.mode === 'preview' ? 'Development preview' : 'Live model'}
                </span>
              </td>
              <td>{duration(r.created_at, r.finished_at)}</td>
              <td>{date(r.created_at)}</td>
              <td>
                <ChevronRight size={16} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
function RunFeedback({
  base,
  runId,
  notify,
}: {
  base: string;
  runId: string;
  notify: PageProps['notify'];
}) {
  const { data, reload } = useData<any[]>(`${base}/runs/${runId}/feedback`, notify);
  const [comment, setComment] = useState(''),
    [busy, setBusy] = useState(false);
  async function save(rating: number) {
    setBusy(true);
    try {
      await api(`${base}/runs/${runId}/feedback`, { rating, comment });
      reload();
      notify('Feedback saved');
    } catch (error) {
      notify((error as Error).message, true);
    } finally {
      setBusy(false);
    }
  }
  return (
    <details className="panel quality-card">
      <summary>Rate this result � {data?.length || 0} reviews</summary>
      <Field label="Feedback comment">
        <textarea
          rows={2}
          maxLength={2000}
          value={comment}
          onChange={(e) => setComment(e.target.value)}
        />
      </Field>
      <div className="inline-actions">
        <Button disabled={busy} onClick={() => void save(1)}>
          <ThumbsUp size={15} />
          Helpful
        </Button>
        <Button disabled={busy} onClick={() => void save(-1)}>
          <ThumbsDown size={15} />
          Needs improvement
        </Button>
      </div>
      {data?.map((f) => (
        <p key={f.id}>
          <strong>{f.name}</strong> �{' '}
          {f.rating > 0 ? 'Helpful' : f.rating < 0 ? 'Needs improvement' : 'Neutral'}
          {f.comment && ' — ' + f.comment}
        </p>
      ))}
    </details>
  );
}
export function RunDetails({
  base,
  runId,
  notify,
  role,
  onClose,
}: {
  base: string;
  runId: string;
  notify: PageProps['notify'];
  role: string;
  onClose?: () => void;
}) {
  const { data: run, reload } = useData(`${base}/runs/${runId}`, notify);
  const [selected, setSelected] = useState(''),
    [tab, setTab] = useState('output');
  useEffect(() => {
    const s = new EventSource(`${base}/runs/${runId}/events`);
    let timer: ReturnType<typeof setTimeout> | undefined;
    s.onmessage = () => {
      if (!timer)
        timer = setTimeout(() => {
          reload();
          timer = undefined;
        }, 200);
    };
    s.onerror = () => s.close();
    return () => {
      s.close();
      if (timer) clearTimeout(timer);
    };
  }, [base, runId, reload]);
  if (!run) return <Loading />;
  const step =
    run.steps.find((s: any) => s.node_id === selected) ||
    run.steps.find((s: any) => s.status === 'waiting') ||
    run.steps[0];
  const events = run.events.filter((e: any) => e.node_id === step?.node_id);
  return (
    <div className="run-detail">
      <div className="run-heading">
        <div>
          <span className="eyebrow">RUN {run.id.slice(0, 8)}</span>
          <h2>
            {run.graph.nodes.find((n: any) => n.data.kind === 'orchestrator')?.data.label ||
              'Workflow execution'}
          </h2>
          <div className="run-meta">
            <Badge status={run.status} />
            <span>
              {run.mode === 'preview'
                ? 'Development preview · deterministic outputs'
                : 'Live model execution'}
            </span>
            <span>{duration(run.created_at, run.finished_at)}</span>
          </div>
        </div>
        <div className="inline-actions">
          <a className="btn" href={`${base}/runs/${run.id}/download`}>
            <Download size={15} />
            Download
          </a>
          {['queued', 'running', 'waiting'].includes(run.status) && (
            <Button
              disabled={!editable(role)}
              variant="danger"
              onClick={async () => {
                await api(`${base}/runs/${run.id}/cancel`, {});
                reload();
              }}
              title="Cancellation applies immediately to active local requests"
            >
              <Square size={14} />
              Cancel now
            </Button>
          )}
          {['failed', 'cancelled'].includes(run.status) && (
            <Button
              disabled={!editable(role)}
              onClick={async () => {
                try {
                  await api(`${base}/runs/${run.id}/retry`, {});
                  reload();
                } catch (e) {
                  notify((e as Error).message, true);
                }
              }}
            >
              <RefreshCw size={14} />
              Retry failed steps
            </Button>
          )}
          {onClose && <Button onClick={onClose}>Close</Button>}
        </div>
      </div>
      {run.error && (
        <div className="error-banner">
          <AlertTriangle size={18} />
          {run.error}
        </div>
      )}
      <div className="run-stats">
        <span>
          <Zap size={15} />
          {(run.usage.inputTokens || 0) + (run.usage.outputTokens || 0)} tokens
        </span>
        <span>
          {run.steps.filter((s: any) => s.status === 'completed').length}/{run.steps.length} steps
          complete
        </span>
        <span>
          Estimated cost:{' '}
          {run.usage.estimatedCost != null
            ? `$${run.usage.estimatedCost.toFixed(5)}`
            : 'Not configured'}
        </span>
      </div>
      {['completed', 'failed'].includes(run.status) && (
        <RunFeedback base={base} runId={runId} notify={notify} />
      )}
      <div className="run-detail-grid">
        <aside className="timeline">
          <span className="eyebrow">EXECUTION TIMELINE</span>
          {run.steps.map((s: any, i: number) => {
            const node = run.graph.nodes.find((n: any) => n.id === s.node_id);
            return (
              <button
                className={`timeline-step ${step?.id === s.id ? 'active' : ''}`}
                key={s.id}
                onClick={() => setSelected(s.node_id)}
              >
                <span className={`timeline-marker ${s.status}`}>
                  {s.status === 'completed' ? <Check size={13} /> : i + 1}
                </span>
                <span>
                  <strong>{node?.data.label}</strong>
                  <small>
                    {s.status} · {duration(s.started_at, s.finished_at)}
                  </small>
                </span>
              </button>
            );
          })}
          {run.children?.map((c: any) => (
            <button
              key={c.id}
              className="child-run"
              onClick={() => {
                location.hash = `page=history&id=${c.id}`;
                location.reload();
              }}
            >
              <Layers size={15} />
              Subworkflow · {c.status}
              <ArrowUpRight size={14} />
            </button>
          ))}
        </aside>
        <section className="step-details">
          <div className="section-heading">
            <h3>{run.graph.nodes.find((n: any) => n.id === step?.node_id)?.data.label}</h3>
            <Badge status={step?.status} />
          </div>
          <div className="tabs">
            {['output', 'input', 'messages', 'tools'].map((t) => (
              <button className={tab === t ? 'active' : ''} key={t} onClick={() => setTab(t)}>
                {t}
              </button>
            ))}
          </div>
          {step?.status === 'waiting' && (
            <div className="approval-panel">
              <h3>Human approval required</h3>
              <p>
                {run.graph.nodes.find((n: any) => n.id === step.node_id)?.data.config.prompt ||
                  'Review the input, then approve or reject this step.'}
              </p>
              <div className="inline-actions">
                <Button
                  variant="primary"
                  disabled={!editable(role)}
                  onClick={async () => {
                    await api(`${base}/runs/${run.id}/approve`, {
                      nodeId: step.node_id,
                      approved: true,
                    });
                    reload();
                  }}
                >
                  <Check size={15} />
                  Approve & continue
                </Button>
                <Button
                  variant="danger"
                  disabled={!editable(role)}
                  onClick={async () => {
                    await api(`${base}/runs/${run.id}/approve`, {
                      nodeId: step.node_id,
                      approved: false,
                      feedback: 'Rejected in run inspector',
                    });
                    reload();
                  }}
                >
                  Reject
                </Button>
              </div>
            </div>
          )}
          {step?.error && <div className="error-banner">{step.error}</div>}
          {['output', 'input'].includes(tab) ? (
            <pre className="result-block">
              {pretty(
                step?.[tab] ??
                  (tab === 'output'
                    ? events
                        .filter((e: any) => e.type === 'model.token')
                        .map((e: any) => e.data.token)
                        .join('') || 'No result recorded yet.'
                    : 'No input recorded yet.'),
              )}
            </pre>
          ) : (
            <div className="event-feed">
              {events
                .filter((e: any) =>
                  tab === 'messages'
                    ? [
                        'agent.message',
                        'agent.assignment',
                        'orchestrator.plan',
                        'agent.result',
                      ].includes(e.type)
                    : e.type.startsWith('tool.'),
                )
                .map((e: any) => (
                  <article key={e.id}>
                    <span className="eyebrow">
                      {e.type.replaceAll('.', ' ')} · {new Date(e.created_at).toLocaleTimeString()}
                    </span>
                    <pre>{pretty(e.data)}</pre>
                  </article>
                ))}
            </div>
          )}
        </section>
      </div>
      <details className="run-output">
        <summary>Consolidated outcome</summary>
        <pre className="result-block">{pretty(run.output ?? 'Waiting for a final output.')}</pre>
      </details>
    </div>
  );
}
export function RunHistory(p: PageProps & { runId?: string }) {
  const [query, setQuery] = useState(''),
    [status, setStatus] = useState('');
  const { data, reload } = useData<any[]>(
    `${p.base}/runs?q=${encodeURIComponent(query)}&status=${status}`,
    p.notify,
  );
  if (p.runId)
    return (
      <RunDetails
        base={p.base}
        runId={p.runId}
        notify={p.notify}
        role={p.role}
        onClose={() => p.go('history')}
      />
    );
  const completed = data?.filter((r) => r.status === 'completed') || [];
  const usage =
    data?.reduce((n, r) => n + (r.usage.inputTokens || 0) + (r.usage.outputTokens || 0), 0) || 0;
  return (
    <>
      <PageHeader
        title="Run history"
        description="Every step, every handoff, every result. Recorded and inspectable."
      >
        <Button onClick={reload}>
          <RefreshCw size={15} />
          Refresh
        </Button>
      </PageHeader>
      <div className="stats-grid compact">
        <div className="stat-card">
          <span>Recorded runs</span>
          <strong>{data?.length || 0}</strong>
        </div>
        <div className="stat-card">
          <span>Completed</span>
          <strong>{completed.length}</strong>
        </div>
        <div className="stat-card">
          <span>Success rate · current filter</span>
          <strong>
            {data?.length ? `${Math.round((completed.length / data.length) * 100)}%` : '—'}
          </strong>
        </div>
        <div className="stat-card">
          <span>Model tokens</span>
          <strong>{usage.toLocaleString()}</strong>
        </div>
      </div>
      <div className="list-toolbar">
        <div className="search-input">
          <Search size={16} />
          <input
            aria-label="Search run history"
            placeholder="Search tasks, workflow names, or run IDs…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
        <Select value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="">All statuses</option>
          {['queued', 'running', 'waiting', 'completed', 'failed', 'cancelled'].map((s) => (
            <option key={s}>{s}</option>
          ))}
        </Select>
      </div>
      <section className="panel">
        {data?.length ? (
          <RunTable runs={data} go={p.go} />
        ) : (
          <Empty
            icon={<Clock size={26} />}
            title="A clear record of your work"
            description="Run a workflow to see its timeline, model usage, inputs, and results here."
            action={
              <Button onClick={() => p.go('workflows')}>
                Open workflows
                <ArrowRight size={15} />
              </Button>
            }
          />
        )}
      </section>
    </>
  );
}
export function Applications(p: PageProps) {
  const { data, reload } = useData<any[]>(`${p.base}/applications`, p.notify);
  const { data: workflows } = useData<any[]>(`${p.base}/workflows`, p.notify);
  const [editing, setEditing] = useState<any>(null),
    [token, setToken] = useState<any>(null),
    [deleting, setDeleting] = useState<any>(null);
  return (
    <>
      <PageHeader
        eyebrow="PUT YOUR TEAM TO WORK"
        title="Applications"
        description="Publish a saved version as a local chat, widget, API, or webhook."
      >
        {editable(p.role) && (
          <Button
            variant="primary"
            onClick={() =>
              setEditing({
                name: '',
                workflowId: workflows?.[0]?.id || '',
                settings: {
                  public: false,
                  mode: 'preview',
                  welcome: 'What would you like our team to work on?',
                  accent: '#b3f576',
                },
              })
            }
          >
            <Plus size={16} />
            Publish locally
          </Button>
        )}
      </PageHeader>
      <div className="info-banner">
        <Shield size={20} />
        <div>
          <strong>Draft freely. Publish deliberately.</strong>
          <p>
            Applications run immutable saved versions. Draft edits take effect only when you publish
            a new version.
          </p>
        </div>
      </div>
      {data?.length ? (
        <div className="card-grid">
          {data.map((a) => (
            <article className="application-card panel" key={a.id}>
              <div className="card-top">
                <div className="icon-tile green">
                  <Globe size={23} />
                </div>
                <Badge status="ready">Published · v{a.revision}</Badge>
              </div>
              <h3>{a.name}</h3>
              <p>
                {a.settings.public ? 'Public chat enabled' : 'Access token required'} ·{' '}
                {a.settings.mode === 'preview' ? 'Development preview' : 'Live execution'}
              </p>
              <div className="app-links">
                <a href={`/apps/${a.id}`} target="_blank" rel="noreferrer">
                  Open hosted chat
                  <ExternalLink size={15} />
                </a>
                <button
                  onClick={() => {
                    navigator.clipboard.writeText(`${location.origin}/api/apps/${a.id}/invoke`);
                    p.notify('API endpoint copied');
                  }}
                >
                  Copy API endpoint
                  <Copy size={15} />
                </button>
                <button
                  onClick={() => {
                    navigator.clipboard.writeText(
                      `<script src="${location.origin}/widget.js" data-app="${a.id}"></script>`,
                    );
                    p.notify('Embed snippet copied. Public chat must be enabled for visitors.');
                  }}
                >
                  Copy widget snippet
                  <Copy size={15} />
                </button>
              </div>
              <footer>
                <Button disabled={!editable(p.role)} onClick={() => setEditing(a)}>
                  Settings
                </Button>
                <Button
                  variant="ghost"
                  disabled={!editable(p.role)}
                  onClick={async () => {
                    try {
                      const r = await api(`${p.base}/applications/${a.id}/rotate`, {});
                      setToken({ ...r, id: a.id });
                      p.notify('Previous token revoked');
                    } catch (e) {
                      p.notify((e as Error).message, true);
                    }
                  }}
                >
                  Rotate token
                </Button>
                <Button
                  variant="icon"
                  title="Remove application"
                  disabled={!editable(p.role)}
                  onClick={() => setDeleting(a)}
                >
                  <Trash2 size={15} />
                </Button>
              </footer>
            </article>
          ))}
        </div>
      ) : (
        <Empty
          icon={<Globe size={28} />}
          title="Your workflow, ready for others"
          description="Publish locally when your workflow is ready. Deployment to a public host is a separate step."
          action={
            <Button
              disabled={!editable(p.role) || !workflows?.length}
              onClick={() =>
                setEditing({
                  name: '',
                  workflowId: workflows?.[0]?.id,
                  settings: {
                    public: false,
                    mode: 'preview',
                    welcome: 'How can we help?',
                    accent: '#b3f576',
                  },
                })
              }
            >
              Publish a saved workflow
            </Button>
          }
        />
      )}
      <section className="panel api-guide">
        <h3>Call a published application</h3>
        <p>
          POST JSON with an input field and Authorization: Bearer YOUR_APPLICATION_TOKEN. Webhooks
          use the same token and a /webhook endpoint. Read the returned run endpoint for its result.
        </p>
        <pre>{`POST /api/apps/{application-id}/invoke\nAuthorization: Bearer YOUR_APPLICATION_TOKEN\nContent-Type: application/json\n\n{"input":"Research our next opportunity"}`}</pre>
      </section>
      {editing && (
        <Modal
          title={editing.id ? 'Application settings' : 'Publish a local application'}
          onClose={() => setEditing(null)}
        >
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              try {
                const r = await api(
                  `${p.base}/applications${editing.id ? '/' + editing.id : ''}`,
                  editing,
                  editing.id ? 'PUT' : 'POST',
                );
                if (r.token) setToken(r);
                setEditing(null);
                reload();
                p.notify('Application saved locally');
              } catch (e) {
                p.notify((e as Error).message, true);
              }
            }}
          >
            <Field label="Application name">
              <input
                value={editing.name}
                required
                onChange={(e) => setEditing({ ...editing, name: e.target.value })}
                placeholder="Research concierge"
              />
            </Field>
            {!editing.id && (
              <Field label="Saved workflow">
                <Select
                  required
                  value={editing.workflowId}
                  onChange={(e) => setEditing({ ...editing, workflowId: e.target.value })}
                >
                  {workflows?.map((w) => (
                    <option key={w.id} value={w.id}>
                      {w.name} · v{w.revision}
                    </option>
                  ))}
                </Select>
              </Field>
            )}
            <Field label="Welcome message">
              <textarea
                value={editing.settings.welcome || ''}
                onChange={(e) =>
                  setEditing({
                    ...editing,
                    settings: { ...editing.settings, welcome: e.target.value },
                  })
                }
              />
            </Field>
            <div className="form-grid">
              <Field label="Accent color">
                <input
                  type="color"
                  value={editing.settings.accent || '#b3f576'}
                  onChange={(e) =>
                    setEditing({
                      ...editing,
                      settings: { ...editing.settings, accent: e.target.value },
                    })
                  }
                />
              </Field>
              <Field label="Execution mode">
                <Select
                  value={editing.settings.mode || 'preview'}
                  onChange={(e) =>
                    setEditing({
                      ...editing,
                      settings: { ...editing.settings, mode: e.target.value },
                    })
                  }
                >
                  <option value="preview">Development preview</option>
                  <option value="live">Live model connections</option>
                </Select>
              </Field>
            </div>
            <label className="checkbox">
              <input
                type="checkbox"
                checked={!!editing.settings.public}
                onChange={(e) =>
                  setEditing({
                    ...editing,
                    settings: { ...editing.settings, public: e.target.checked },
                  })
                }
              />
              Allow public hosted chat and widget access
            </label>
            <small className="muted">
              The API and webhook always require the application token.
            </small>
            {editing.id && (
              <label className="checkbox">
                <input
                  type="checkbox"
                  checked={!!editing.publishLatest}
                  onChange={(e) => setEditing({ ...editing, publishLatest: e.target.checked })}
                />
                Publish the latest saved workflow version
              </label>
            )}
            <div className="modal-actions">
              <Button variant="primary" type="submit">
                {editing.id ? 'Save application' : 'Publish locally'}
              </Button>
            </div>
          </form>
        </Modal>
      )}
      {token && (
        <Modal
          title="Your application is ready"
          subtitle="Copy the access token now. It is shown only once and stored as a hash."
          onClose={() => setToken(null)}
        >
          <Field label="Application access token">
            <input readOnly value={token.token} onFocus={(e) => e.target.select()} />
          </Field>
          <Button
            onClick={() => {
              navigator.clipboard.writeText(token.token);
              p.notify('Token copied');
            }}
          >
            <Copy size={15} />
            Copy token
          </Button>
          <pre className="result-block">{`POST ${location.origin}/api/apps/${token.id}/invoke\nAuthorization: Bearer YOUR_APPLICATION_TOKEN\n\n{"input":"Your task"}`}</pre>
          <a className="btn primary" href={`/apps/${token.id}`} target="_blank" rel="noreferrer">
            Open chat
            <ExternalLink size={15} />
          </a>
        </Modal>
      )}
      {deleting && (
        <Confirm
          title="Remove this application?"
          description="Its hosted chat, API, and webhook endpoints will stop accepting new runs."
          onClose={() => setDeleting(null)}
          onConfirm={async () => {
            await api(`${p.base}/applications/${deleting.id}`, undefined, 'DELETE');
            setDeleting(null);
            reload();
          }}
        />
      )}
    </>
  );
}
export function Team(p: PageProps) {
  const { data, reload } = useData(`${p.base}/members`, p.notify);
  const [invite, setInvite] = useState(false),
    [token, setToken] = useState<any>(null),
    [remove, setRemove] = useState<any>(null);
  return (
    <>
      <PageHeader
        title="Your team"
        description="Shared context. Clear responsibilities. One workspace."
      >
        {admin(p.role) && (
          <Button variant="primary" onClick={() => setInvite(true)}>
            <Plus size={16} />
            Invite member
          </Button>
        )}
      </PageHeader>
      <section className="panel">
        <div className="section-heading">
          <h3>Workspace members</h3>
          <span className="muted">{data?.members.length || 0} members</span>
        </div>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Member</th>
                <th>Email</th>
                <th>Role</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {data?.members.map((m: any) => (
                <tr key={m.id}>
                  <td>
                    <span className="table-name">
                      <span className="user-avatar">{m.name[0]}</span>
                      <strong>{m.name}</strong>
                    </span>
                  </td>
                  <td>{m.email}</td>
                  <td>
                    {m.role === 'owner' ? (
                      <Badge status="ready">Owner</Badge>
                    ) : (
                      <Select
                        value={m.role}
                        disabled={
                          !admin(p.role) || (m.role === 'administrator' && p.role !== 'owner')
                        }
                        onChange={async (e) => {
                          try {
                            await api(`${p.base}/members/${m.id}`, { role: e.target.value }, 'PUT');
                            reload();
                            p.notify('Member role updated');
                          } catch (e) {
                            p.notify((e as Error).message, true);
                          }
                        }}
                      >
                        {p.role === 'owner' && <option value="administrator">Administrator</option>}
                        <option value="editor">Editor</option>
                        <option value="viewer">Viewer</option>
                      </Select>
                    )}
                  </td>
                  <td>
                    {m.role !== 'owner' && admin(p.role) && (
                      <Button
                        variant="icon"
                        aria-label={`Remove ${m.name}`}
                        onClick={() => setRemove(m)}
                      >
                        <Trash2 size={15} />
                      </Button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
      <section className="panel role-guide">
        <h3>A role for every collaborator</h3>
        <div className="provider-grid">
          {[
            { role: 'Owner', text: 'Manage the workspace and administrator access.' },
            {
              role: 'Administrator',
              text: 'Manage connections, tools, invitations, and settings.',
            },
            { role: 'Editor', text: 'Build, run, publish, and manage knowledge.' },
            { role: 'Viewer', text: 'Inspect workflows, knowledge, and run history.' },
          ].map((r) => (
            <div key={r.role}>
              <Shield size={18} />
              <strong>{r.role}</strong>
              <p>{r.text}</p>
            </div>
          ))}
        </div>
      </section>
      {data?.invitations.length > 0 && (
        <section className="panel">
          <div className="section-heading">
            <h3>Invitations</h3>
          </div>
          {data.invitations.map((i: any) => (
            <div className="invitation-row" key={i.id}>
              <span>{i.email}</span>
              <span>{i.role}</span>
              <Badge status={i.accepted ? 'completed' : 'waiting'}>
                {i.accepted ? 'Accepted' : i.expires_at < Date.now() ? 'Expired' : 'Pending'}
              </Badge>
            </div>
          ))}
        </section>
      )}
      {invite && (
        <Modal
          title="Invite a collaborator"
          subtitle="Creates a shareable invitation. Relay does not send email."
          onClose={() => setInvite(false)}
        >
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              try {
                const r = await api(
                  `${p.base}/invitations`,
                  Object.fromEntries(new FormData(e.currentTarget)),
                );
                setInvite(false);
                setToken(r);
                reload();
              } catch (e) {
                p.notify((e as Error).message, true);
              }
            }}
          >
            <Field label="Email address">
              <input name="email" type="email" required />
            </Field>
            <Field label="Role">
              <Select name="role" defaultValue="editor">
                <option value="viewer">Viewer</option>
                <option value="editor">Editor</option>
                {p.role === 'owner' && <option value="administrator">Administrator</option>}
              </Select>
            </Field>
            <div className="modal-actions">
              <Button variant="primary" type="submit">
                Create invitation
              </Button>
            </div>
          </form>
        </Modal>
      )}
      {token && (
        <Modal
          title="Invitation created"
          subtitle="Share this token with the intended recipient. It expires in seven days."
          onClose={() => setToken(null)}
        >
          <Field label="Invitation token">
            <input readOnly value={token.token} onFocus={(e) => e.target.select()} />
          </Field>
          <Button
            onClick={() => {
              navigator.clipboard.writeText(token.token);
              p.notify('Invitation token copied');
            }}
          >
            <Copy size={15} />
            Copy invitation token
          </Button>
        </Modal>
      )}
      {remove && (
        <Confirm
          title={`Remove ${remove.name}?`}
          description="They will lose access to this workspace. Their account remains available."
          onClose={() => setRemove(null)}
          onConfirm={async () => {
            try {
              await api(`${p.base}/members/${remove.id}`, undefined, 'DELETE');
              setRemove(null);
              reload();
            } catch (e) {
              p.notify((e as Error).message, true);
            }
          }}
        />
      )}
    </>
  );
}
export function WorkspaceSettings(p: PageProps & { workspace: any; onUpdate: () => void }) {
  const { data: memories, reload: reloadMemory } = useData<any[]>(`${p.base}/memories`, p.notify);
  const { data: audit } = useData<any[]>(`${p.base}/audit`, p.notify);
  const { data: artifacts } = useData<any[]>(`${p.base}/artifacts`, p.notify);
  const [tab, setTab] = useState('general'),
    [name, setName] = useState(p.workspace?.name || '');
  return (
    <>
      <PageHeader
        title="Settings"
        description="Keep your workspace, memory, and activity under your control."
      />
      <div className="tabs settings-tabs">
        {['general', 'security', 'memory', 'artifacts', 'audit'].map((t) => (
          <button className={tab === t ? 'active' : ''} key={t} onClick={() => setTab(t)}>
            {t}
          </button>
        ))}
      </div>
      {tab === 'general' && (
        <div className="settings-grid">
          <section className="panel settings-form">
            <h3>Workspace details</h3>
            <form
              onSubmit={async (e) => {
                e.preventDefault();
                try {
                  await api(
                    `${p.base}/settings`,
                    { name, settings: p.workspace.settings || {} },
                    'PUT',
                  );
                  p.onUpdate();
                  p.notify('Workspace updated');
                } catch (e) {
                  p.notify((e as Error).message, true);
                }
              }}
            >
              <Field label="Workspace name">
                <input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  required
                  disabled={!admin(p.role)}
                />
              </Field>
              <Button type="submit" variant="primary" disabled={!admin(p.role)}>
                Save changes
              </Button>
            </form>
          </section>
          <section className="panel shortcut-guide">
            <h3>Keyboard shortcuts</h3>
            {[
              ['Search workspace', 'Ctrl / ⌘ K'],
              ['Toggle theme', 'Ctrl / ⌘ Shift L'],
              ['Save workflow', 'Ctrl / ⌘ S'],
              ['Undo / redo', 'Ctrl / ⌘ Z / Shift Z'],
              ['Copy / paste nodes', 'Ctrl / ⌘ C / V'],
              ['Duplicate selection', 'Ctrl / ⌘ D'],
              ['Run workflow', 'Ctrl / ⌘ Enter'],
              ['Fit canvas', 'F'],
            ].map(([label, key]) => (
              <div key={label}>
                <span>{label}</span>
                <kbd>{key}</kbd>
              </div>
            ))}
          </section>
        </div>
      )}
      {tab === 'security' && <AccountSecurity notify={p.notify} />}
      {tab === 'memory' && (
        <section className="panel">
          <div className="section-heading">
            <div>
              <h3>Agent memory</h3>
              <p>Persistent and conversation memories are isolated to this workspace.</p>
            </div>
            <Badge status="draft">{memories?.length || 0} entries</Badge>
          </div>
          {memories?.length ? (
            memories.map((m) => (
              <article className="memory-entry" key={m.id}>
                <div>
                  <span className="eyebrow">
                    AGENT {m.agent_id} · {date(m.created_at)}
                  </span>
                  <small>
                    {m.conversation_id ? 'Conversation ' + m.conversation_id : 'Persistent memory'}
                  </small>
                  <pre>{m.content}</pre>
                </div>
                <Button
                  variant="icon"
                  title="Delete memory"
                  disabled={!editable(p.role)}
                  onClick={async () => {
                    await api(`${p.base}/memories/${m.id}`, undefined, 'DELETE');
                    reloadMemory();
                    p.notify('Memory deleted');
                  }}
                >
                  <Trash2 size={16} />
                </Button>
              </article>
            ))
          ) : (
            <Empty
              icon={<BookOpen size={25} />}
              title="A fresh memory"
              description="Enable conversation or persistent memory on an agent to store context from its runs."
            />
          )}
        </section>
      )}
      {tab === 'artifacts' && (
        <section className="panel">
          <div className="section-heading">
            <h3>Workspace files</h3>
          </div>
          {artifacts?.length ? (
            artifacts.map((a) => (
              <div className="artifact-row" key={a.id}>
                <FileText size={18} />
                <span className="grow">{a.name}</span>
                <small>{date(a.created_at)}</small>
                <a className="btn" href={`${p.base}/artifacts/${a.id}`}>
                  <Download size={14} />
                  Download
                </a>
              </div>
            ))
          ) : (
            <Empty
              title="No artifacts yet"
              description="Use a workspace file tool to save a report or structured result from a workflow."
            />
          )}
        </section>
      )}
      {tab === 'audit' && (
        <section className="panel">
          <div className="section-heading">
            <h3>Activity & audit history</h3>
          </div>
          <div className="audit-list">
            {audit?.map((a) => (
              <div key={a.id}>
                <Activity size={16} />
                <span>
                  <strong>{a.action.replaceAll('.', ' ')}</strong>
                  <small>
                    {a.user_name || a.user_id} · {a.target.slice(0, 12)}
                  </small>
                </span>
                <time>{new Date(a.created_at).toLocaleString()}</time>
              </div>
            ))}
          </div>
        </section>
      )}
    </>
  );
}
export function PublishedChat({ appId }: { appId: string }) {
  const [meta, setMeta] = useState<any>(null),
    [token, setToken] = useState(''),
    [input, setInput] = useState(''),
    [messages, setMessages] = useState<any[]>([]),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const conversation = useRef(crypto.randomUUID());
  useEffect(() => {
    api(`/apps/${appId}/meta`)
      .then(setMeta)
      .catch((e) => setError(e.message));
  }, [appId]);
  async function request(path: string, body?: any) {
    const r = await fetch(path, {
      method: body ? 'POST' : 'GET',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error);
    return data;
  }
  async function send(e: React.FormEvent) {
    e.preventDefault();
    if (!input.trim() || busy) return;
    const text = input;
    setInput('');
    setMessages((m) => [...m, { role: 'user', content: text }]);
    setBusy(true);
    setError('');
    try {
      const run = await request(`/apps/${appId}/invoke`, {
        input: text,
        conversationId: conversation.current,
      });
      for (let i = 0; i < 600; i++) {
        const r = await request(`/apps/${appId}/runs/${run.id}`);
        if (['completed', 'failed', 'cancelled'].includes(r.status)) {
          if (r.status !== 'completed') throw new Error(r.error || 'Run did not complete');
          setMessages((m) => [...m, { role: 'assistant', content: pretty(r.output) }]);
          break;
        }
        if (r.status === 'waiting')
          throw new Error(
            'This workflow needs approval from its workspace. Open run history to continue.',
          );
        await new Promise((resolve) => setTimeout(resolve, 700));
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div
      className="published-chat"
      style={{ '--accent': meta?.settings.accent || '#b3f576' } as React.CSSProperties}
    >
      <header>
        <span className="brand-symbol">
          <Network size={21} />
        </span>
        <div>
          <strong>{meta?.name || 'Agent application'}</strong>
          <small>{meta?.settings.mode === 'preview' ? 'Development preview' : 'Agent team'}</small>
        </div>
      </header>
      <main>
        {!messages.length && (
          <div className="chat-welcome">
            <div className="icon-tile green">
              <Network size={29} />
            </div>
            <h1>{meta?.name || 'A team at your service'}</h1>
            <p>{meta?.settings.welcome || 'What would you like to work on?'}</p>
          </div>
        )}
        {meta && !meta.settings.public && (
          <Field label="Application access token">
            <input
              type="password"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              placeholder="Enter your application token"
            />
          </Field>
        )}
        {messages.map((m, i) => (
          <div className={`chat-message ${m.role}`} key={i}>
            <span>{m.role === 'user' ? 'You' : meta?.name}</span>
            <pre>{m.content}</pre>
          </div>
        ))}
        {busy && (
          <div className="chat-working">
            <span className="status-dot" />
            Your team is working…
          </div>
        )}
        {error && <div className="error-banner">{error}</div>}
      </main>
      <form onSubmit={send}>
        <input
          aria-label="Message"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Give your team a task…"
          required
        />
        <Button type="submit" variant="primary" disabled={busy}>
          <Send size={18} />
        </Button>
      </form>
      <footer>
        Powered by Relay ·{' '}
        {meta?.settings.mode === 'preview'
          ? 'Deterministic development preview'
          : 'Your connected models'}
      </footer>
    </div>
  );
}
