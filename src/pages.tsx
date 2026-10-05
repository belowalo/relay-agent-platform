import { useState, useEffect, useCallback, useRef } from 'react';
import {
  Plus,
  ArrowUpRight,
  ArrowRight,
  Bot,
  Workflow,
  Clock,
  CheckCircle2,
  Play,
  BookOpen,
  FileText,
  Upload,
  Search,
  Trash2,
  RefreshCw,
  Network,
  MoreHorizontal,
  Layers,
  Activity,
  Globe,
  Plug,
  Zap,
  Shield,
  Download,
  ChevronRight,
  Copy,
  ExternalLink,
  Code2,
  Settings,
  Users,
  GitBranch,
  Square,
  AlertTriangle,
  Terminal,
  Send,
  Check,
  X,
} from 'lucide-react';
import { api, pretty, date, duration, download, type PageProps } from './api';
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
export function useData<T = any>(url: string, notify: PageProps['notify']) {
  const [data, setData] = useState<T | null>(null);
  const generation = useRef(0);
  const reload = useCallback(async () => {
    const request = ++generation.current;
    try {
      const result = await api<T>(url);
      if (request === generation.current) setData(result);
    } catch (error) {
      if (request === generation.current) notify((error as Error).message, true);
    }
  }, [url, notify]);
  useEffect(() => {
    setData(null);
    void reload();
    return () => {
      generation.current++;
    };
  }, [reload]);
  return { data, reload, setData };
}
const canEdit = (role: string) => role !== 'viewer',
  canAdmin = (role: string) => ['owner', 'administrator'].includes(role);
function IconTile({ children, color = 'green' }: { children: React.ReactNode; color?: string }) {
  return <div className={`icon-tile ${color}`}>{children}</div>;
}
function WorkflowSketch() {
  return (
    <div className="workflow-sketch">
      <div className="sketch-node">
        <Network size={18} />
        <span>Orchestrator</span>
        <span className="sketch-dot" />
      </div>
      <div className="sketch-fork" />
      <div className="sketch-workers">
        <div className="sketch-node">
          <Search size={17} />
          <span>Researcher</span>
        </div>
        <div className="sketch-node">
          <SparkIcon />
          <span>Strategist</span>
        </div>
      </div>
      <div className="sketch-fork reverse" />
      <div className="sketch-node review">
        <CheckCircle2 size={17} />
        <span>Reviewer</span>
        <span className="sketch-dot" />
      </div>
    </div>
  );
}
function SparkIcon() {
  return <Zap size={17} />;
}
export function Dashboard(p: PageProps & { user: any }) {
  const { data } = useData(`${p.base}/overview`, p.notify);
  const { data: workflows } = useData<any[]>(`${p.base}/workflows`, p.notify);
  const { data: collections } = useData<any[]>(`${p.base}/collections`, p.notify);
  const { data: connections } = useData<any[]>(`${p.base}/connections`, p.notify);
  if (!data || !workflows) return <Loading />;
  const completed = data.runs.filter((r: any) => r.status === 'completed'),
    tokens = data.runs.reduce(
      (t: number, r: any) => t + (r.usage.inputTokens || 0) + (r.usage.outputTokens || 0),
      0,
    ),
    avg = completed.length
      ? completed.reduce(
          (t: number, r: any) =>
            t + new Date(r.finished_at).getTime() - new Date(r.created_at).getTime(),
          0,
        ) /
        completed.length /
        1000
      : 0;
  const stats = [
    { label: 'Workflows', value: data.workflows, icon: Workflow, note: 'Ready to build and run' },
    {
      label: 'Agent library',
      value: data.agents,
      icon: Bot,
      note: 'Specialists in your workspace',
    },
    {
      label: 'Completed runs',
      value: completed.length,
      icon: CheckCircle2,
      note: `${data.runs.length} recorded runs`,
    },
    {
      label: 'Model usage',
      value: tokens.toLocaleString(),
      icon: Activity,
      note: avg ? `${avg.toFixed(1)}s average run duration` : 'Tokens from live model calls',
    },
  ];
  return (
    <>
      <PageHeader
        eyebrow="LET’S MAKE SOMETHING HAPPEN"
        title={`Welcome back, ${p.user.name.split(' ')[0]}.`}
        description="A little coordination. A lot of possibility."
      >
        {canEdit(p.role) && (
          <Button variant="primary" onClick={() => p.go('workflows')}>
            <Plus size={16} />
            New workflow
          </Button>
        )}
      </PageHeader>
      <div className="stats-grid">
        {stats.map((s) => (
          <div className="stat-card" key={s.label}>
            <div className="stat-top">
              <span>{s.label}</span>
              <s.icon size={17} />
            </div>
            <strong>{s.value}</strong>
            <small>{s.note}</small>
          </div>
        ))}
      </div>
      <div className="dashboard-grid">
        <section className="panel featured">
          <div className="section-heading">
            <span className="eyebrow">YOUR NEXT GREAT WORKFLOW</span>
            <Badge status="ready">Ready to explore</Badge>
          </div>
          <div className="featured-body">
            <div>
              <IconTile>
                <Network size={24} />
              </IconTile>
              <h2>
                One brief.
                <br />A whole team behind it.
              </h2>
              <p>
                Let an orchestrator bring the right specialists together, then turn their work into
                one thoughtful result.
              </p>
              <div className="pills">
                <span>Parallel specialists</span>
                <span>Built-in review</span>
              </div>
              <Button
                onClick={() =>
                  workflows[0] ? p.go('builder', workflows[0].id) : p.go('workflows')
                }
              >
                Open your workflow
                <ArrowRight size={16} />
              </Button>
            </div>
            <WorkflowSketch />
          </div>
          <div className="featured-footer">
            <span>
              <GitBranch size={15} />
              Real connections. Real execution.
            </span>
            <span>Development preview available</span>
          </div>
        </section>
        <section className="panel getting-started">
          <div className="section-heading">
            <h3>Your launchpad</h3>
            <span className="subtle">03 steps</span>
          </div>
          <p className="muted">From a first idea to your first agent run.</p>
          {[
            {
              title: 'Shape your team',
              text: 'Open the canvas and make it yours.',
              icon: Workflow,
              page: 'workflows',
              done: workflows.length > 0,
            },
            {
              title: 'Bring your context',
              text: 'Add documents your agents can use.',
              icon: BookOpen,
              page: 'knowledge',
              done: !!collections?.some((c) => c.chunk_count > 0),
            },
            {
              title: 'Make the connection',
              text: 'Choose your provider or local model.',
              icon: Zap,
              page: 'connections',
              done: !!connections?.some((c) => c.provider !== 'credential'),
            },
          ].map((s, i) => (
            <button className="launch-step" key={s.title} onClick={() => p.go(s.page)}>
              <span className={`step-num ${s.done ? 'done' : ''}`}>
                {s.done ? <Check size={16} /> : String(i + 1).padStart(2, '0')}
              </span>
              <span>
                <strong>{s.title}</strong>
                <small>{s.text}</small>
              </span>
              <ChevronRight size={16} />
            </button>
          ))}
          <div className="launch-note">
            <Shield size={17} />
            <p>
              Your data stays in this workspace.
              <br />
              Preview is deterministic. Live calls need a working model connection and may use
              provider quota. Tools can act in either mode.
            </p>
          </div>
        </section>
      </div>
      <section className="panel recent-panel">
        <div className="section-heading">
          <div>
            <h3>Recent runs</h3>
            <p>Every task leaves a trail you can follow.</p>
          </div>
          <Button variant="ghost" onClick={() => p.go('history')}>
            View history
            <ArrowUpRight size={15} />
          </Button>
        </div>
        {!data.runs.length ? (
          <Empty
            icon={<Play size={23} />}
            title="Your first run starts here"
            description="Open a workflow, give your team a task, and watch each step unfold."
            action={
              <Button onClick={() => workflows[0] && p.go('builder', workflows[0].id)}>
                Try development preview
                <ArrowRight size={15} />
              </Button>
            }
          />
        ) : (
          <RunTable
            runs={data.runs.slice(0, 5).map((r: any) => ({
              ...r,
              workflow_name: workflows.find((w) => w.id === r.workflow_id)?.name,
            }))}
            go={p.go}
          />
        )}
      </section>
      <div className="dashboard-footer">
        <span>
          <span className="status-dot" />
          All activity shown comes from recorded workspace data.
        </span>
        <span>Built for thoughtful automation.</span>
      </div>
    </>
  );
}
export function Workflows(p: PageProps) {
  const { data, reload } = useData<any[]>(`${p.base}/workflows`, p.notify);
  const { data: catalog } = useData(`${p.base}/catalog`, p.notify);
  const [create, setCreate] = useState(false),
    [query, setQuery] = useState(''),
    [deleting, setDeleting] = useState<any>(null);
  async function newFlow(template: any, name?: string) {
    try {
      const graph = template?.graph || {
        nodes: [
          {
            id: 'input',
            type: 'relay',
            position: { x: 50, y: 150 },
            data: { kind: 'input', label: 'Task input', config: {} },
          },
          {
            id: 'output',
            type: 'relay',
            position: { x: 430, y: 150 },
            data: { kind: 'output', label: 'Final output', config: {} },
          },
        ],
        edges: [{ id: 'input-output', source: 'input', target: 'output' }],
      };
      const r = await api(`${p.base}/workflows`, {
        name: name || template.name,
        description: template?.description || '',
        graph,
      });
      p.go('builder', r.id);
      p.notify('Workflow created');
    } catch (e) {
      p.notify((e as Error).message, true);
    }
  }
  return (
    <>
      <PageHeader
        eyebrow="IDEAS, CONNECTED"
        title="Workflows"
        description="Build a path from a task to a meaningful result."
      >
        {canEdit(p.role) && (
          <Button variant="primary" onClick={() => setCreate(true)}>
            <Plus size={16} />
            Create workflow
          </Button>
        )}
      </PageHeader>
      <div className="list-toolbar">
        <div className="search-input">
          <Search size={16} />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search workflows…"
            aria-label="Search workflows"
          />
        </div>
        <span className="muted">{data?.length || 0} workflows</span>
      </div>
      {!data ? (
        <Loading />
      ) : (
        <div className="card-grid">
          {data
            .filter((w) => w.name.toLowerCase().includes(query.toLowerCase()))
            .map((w) => (
              <article className="workflow-card" key={w.id}>
                <div className="card-top">
                  <IconTile>
                    <Workflow size={22} />
                  </IconTile>
                  <Badge status="draft">Draft · v{w.revision}</Badge>
                </div>
                <button className="card-title" onClick={() => p.go('builder', w.id)}>
                  {w.name}
                  <ArrowUpRight size={18} />
                </button>
                <p>{w.description || 'An open canvas for your next idea.'}</p>
                <div className="mini-nodes">
                  {w.graph.nodes
                    .filter((n: any) => ['agent', 'orchestrator', 'model'].includes(n.data.kind))
                    .slice(0, 4)
                    .map((n: any) => (
                      <span key={n.id} title={n.data.label}>
                        {n.data.kind === 'orchestrator' ? <Network size={15} /> : <Bot size={15} />}
                      </span>
                    ))}
                  <small>{w.graph.nodes.length} components</small>
                </div>
                <footer>
                  <span>
                    Edited {date(w.updated_at)} · {w.run_count} runs
                  </span>
                  <Button
                    variant="icon"
                    aria-label={`Delete ${w.name}`}
                    disabled={!canEdit(p.role)}
                    onClick={() => setDeleting(w)}
                  >
                    <Trash2 size={15} />
                  </Button>
                </footer>
              </article>
            ))}
        </div>
      )}
      {create && (
        <Modal
          title="Give your idea a starting point"
          subtitle="Every template is editable and connected to the execution engine."
          wide
          onClose={() => setCreate(false)}
        >
          <div className="template-grid">
            <button
              className="template-card blank"
              onClick={() => newFlow(null, 'Untitled workflow')}
            >
              <Plus size={24} />
              <strong>Start from scratch</strong>
              <p>A clean canvas. Your own logic.</p>
              <span>
                Blank workflow
                <ArrowRight size={15} />
              </span>
            </button>
            {catalog?.templates.map((t: any) => (
              <button className="template-card" key={t.id} onClick={() => newFlow(t)}>
                <span className="template-tag">{t.tag}</span>
                <Network size={23} />
                <strong>{t.name}</strong>
                <p>{t.description}</p>
                <span>
                  Use template
                  <ArrowRight size={15} />
                </span>
              </button>
            ))}
          </div>
        </Modal>
      )}
      {deleting && (
        <Confirm
          title={`Delete ${deleting.name}?`}
          description="This removes the draft and version history. Recorded runs remain available."
          onClose={() => setDeleting(null)}
          onConfirm={async () => {
            try {
              await api(`${p.base}/workflows/${deleting.id}`, undefined, 'DELETE');
              setDeleting(null);
              reload();
              p.notify('Workflow deleted');
            } catch (e) {
              p.notify((e as Error).message, true);
            }
          }}
        />
      )}
    </>
  );
}
export function Projects(p: PageProps) {
  const { data, reload } = useData<any[]>(`${p.base}/projects`, p.notify);
  const [modal, setModal] = useState(false);
  return (
    <>
      <PageHeader
        title="Projects"
        description="Keep related workflows together and give your work room to grow."
      >
        {canEdit(p.role) && (
          <Button variant="primary" onClick={() => setModal(true)}>
            <Plus size={16} />
            New project
          </Button>
        )}
      </PageHeader>
      <div className="card-grid">
        {data?.map((pr) => (
          <article className="project-card panel" key={pr.id}>
            <IconTile color="purple">
              <Layers size={23} />
            </IconTile>
            <h3>{pr.name}</h3>
            <p>{pr.description || 'A home for your workflows.'}</p>
            <footer>
              <span>{pr.workflow_count} workflows</span>
              <Button variant="ghost" onClick={() => p.go('workflows')}>
                Browse
                <ArrowUpRight size={15} />
              </Button>
            </footer>
          </article>
        ))}
      </div>
      {modal && (
        <Modal title="Create a project" onClose={() => setModal(false)}>
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              try {
                await api(`${p.base}/projects`, Object.fromEntries(new FormData(e.currentTarget)));
                reload();
                setModal(false);
                p.notify('Project created');
              } catch (e) {
                p.notify((e as Error).message, true);
              }
            }}
          >
            <Field label="Project name">
              <input name="name" required placeholder="Customer research" />
            </Field>
            <Field label="Description">
              <textarea name="description" placeholder="What brings these workflows together?" />
            </Field>
            <div className="modal-actions">
              <Button variant="primary" type="submit">
                Create project
              </Button>
            </div>
          </form>
        </Modal>
      )}
    </>
  );
}
export function Agents(p: PageProps) {
  const { data, reload } = useData<any[]>(`${p.base}/agents`, p.notify);
  const { data: connections } = useData<any[]>(`${p.base}/connections`, p.notify);
  const [editing, setEditing] = useState<any>(null);
  return (
    <>
      <PageHeader
        title="Agent library"
        description="Reusable specialists, ready to join your next workflow."
      >
        {canEdit(p.role) && (
          <Button
            variant="primary"
            onClick={() =>
              setEditing({
                name: '',
                config: {
                  role: 'Specialist',
                  instructions: '',
                  memory: 'none',
                  temperature: 0.4,
                  maxTokens: 2048,
                  maxSteps: 5,
                },
              })
            }
          >
            <Plus size={16} />
            Create agent
          </Button>
        )}
      </PageHeader>
      <div className="card-grid">
        {data?.map((a) => (
          <article className="agent-card panel" key={a.id}>
            <div className="card-top">
              <IconTile color="purple">
                <Bot size={24} />
              </IconTile>
              <Badge status="draft">{a.config.role || 'Specialist'}</Badge>
            </div>
            <h3>{a.name}</h3>
            <p>{a.config.instructions}</p>
            <div className="agent-meta">
              <span>
                <Zap size={14} />
                {connections?.find((c) => c.id === a.config.connectionId)?.name ||
                  'Choose model in workflow'}
              </span>
              <span>
                <BookOpen size={14} />
                {a.config.memory || 'none'} memory
              </span>
            </div>
            <footer>
              <Button variant="ghost" onClick={() => setEditing(a)} disabled={!canEdit(p.role)}>
                Configure
                <ArrowUpRight size={15} />
              </Button>
              <Button
                variant="icon"
                aria-label={`Delete agent ${a.name}`}
                disabled={!canEdit(p.role)}
                onClick={async () => {
                  try {
                    await api(`${p.base}/agents/${a.id}`, undefined, 'DELETE');
                    reload();
                  } catch (e) {
                    p.notify((e as Error).message, true);
                  }
                }}
              >
                <Trash2 size={15} />
              </Button>
            </footer>
          </article>
        ))}
      </div>
      {editing && (
        <Modal
          title={editing.id ? 'Configure agent' : 'Create a specialist'}
          subtitle="Add this agent to a canvas from the component library."
          onClose={() => setEditing(null)}
        >
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              try {
                await api(
                  `${p.base}/agents${editing.id ? '/' + editing.id : ''}`,
                  editing,
                  editing.id ? 'PUT' : 'POST',
                );
                reload();
                setEditing(null);
                p.notify('Agent saved');
              } catch (e) {
                p.notify((e as Error).message, true);
              }
            }}
          >
            <Field label="Name">
              <input
                required
                value={editing.name}
                onChange={(e) => setEditing({ ...editing, name: e.target.value })}
              />
            </Field>
            <Field label="Role">
              <input
                value={editing.config.role || ''}
                onChange={(e) =>
                  setEditing({ ...editing, config: { ...editing.config, role: e.target.value } })
                }
              />
            </Field>
            <Field label="Instructions">
              <textarea
                rows={5}
                value={editing.config.instructions || ''}
                onChange={(e) =>
                  setEditing({
                    ...editing,
                    config: { ...editing.config, instructions: e.target.value },
                  })
                }
              />
            </Field>
            <Field label="Model connection">
              <Select
                value={editing.config.connectionId || ''}
                onChange={(e) =>
                  setEditing({
                    ...editing,
                    config: { ...editing.config, connectionId: e.target.value },
                  })
                }
              >
                <option value="">Select in workflow</option>
                {connections
                  ?.filter((c) => c.provider !== 'credential')
                  .map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name} · {c.model}
                    </option>
                  ))}
              </Select>
            </Field>
            <Field label="Memory">
              <Select
                value={editing.config.memory || 'none'}
                onChange={(e) =>
                  setEditing({ ...editing, config: { ...editing.config, memory: e.target.value } })
                }
              >
                <option value="none">No memory</option>
                <option value="conversation">Conversation</option>
                <option value="persistent">Persistent agent memory</option>
              </Select>
            </Field>
            <details>
              <summary>Generation, limits, and structured output</summary>
              <JsonField
                value={editing.config}
                onChange={(config) => setEditing({ ...editing, config })}
              />
            </details>
            <div className="modal-actions">
              <Button variant="primary" type="submit">
                Save agent
              </Button>
            </div>
          </form>
        </Modal>
      )}
    </>
  );
}
export function Knowledge(p: PageProps) {
  const { data: collections, reload } = useData<any[]>(`${p.base}/collections`, p.notify);
  const [selected, setSelected] = useState(''),
    [sources, setSources] = useState<any[]>([]),
    [modal, setModal] = useState(false),
    [query, setQuery] = useState(''),
    [results, setResults] = useState<any[]>([]),
    [busy, setBusy] = useState(false),
    [website, setWebsite] = useState(false);
  const [retrievalOptions, setRetrievalOptions] = useState<any>({});
  const [metadataSource, setMetadataSource] = useState<any>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const loadSources = useCallback(() => {
    if (selected)
      api(`${p.base}/collections/${selected}/sources`)
        .then(setSources)
        .catch((e) => p.notify(e.message, true));
  }, [selected, p.base, p.notify]);
  useEffect(() => {
    if (!selected && collections?.length) setSelected(collections[0].id);
  }, [collections, selected]);
  useEffect(() => {
    loadSources();
    const t = setInterval(loadSources, 1500);
    return () => clearInterval(t);
  }, [loadSources]);
  async function upload(file: File) {
    setBusy(true);
    const form = new FormData();
    form.append('file', file);
    try {
      await api(`${p.base}/collections/${selected}/upload`, form);
      loadSources();
      reload();
      p.notify('Document uploaded. Indexing has started.');
    } catch (e) {
      p.notify((e as Error).message, true);
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <PageHeader
        eyebrow="CONTEXT MAKES THE DIFFERENCE"
        title="Knowledge"
        description="Give your agents a reliable source of truth."
      >
        {canEdit(p.role) && (
          <Button variant="primary" onClick={() => setModal(true)}>
            <Plus size={16} />
            New collection
          </Button>
        )}
      </PageHeader>
      {!collections ? (
        <Loading />
      ) : !collections.length ? (
        <Empty
          icon={<BookOpen size={27} />}
          title="Bring your knowledge together"
          description="Create a collection, upload documents, and retrieve cited passages in your workflows."
          action={
            <Button onClick={() => setModal(true)} disabled={!canEdit(p.role)}>
              Create collection
            </Button>
          }
        />
      ) : (
        <div className="knowledge-layout">
          <aside className="collection-list">
            <span className="eyebrow">COLLECTIONS</span>
            {collections.map((c) => (
              <button
                key={c.id}
                className={selected === c.id ? 'active' : ''}
                onClick={() => {
                  setSelected(c.id);
                  setResults([]);
                }}
              >
                <BookOpen size={18} />
                <span>
                  <strong>{c.name}</strong>
                  <small>
                    {c.source_count} sources · {c.chunk_count} chunks
                  </small>
                </span>
              </button>
            ))}
          </aside>
          <div>
            <section className="panel">
              <div className="section-heading">
                <div>
                  <h3>{collections.find((c) => c.id === selected)?.name}</h3>
                  <p>Documents and webpages, indexed for retrieval.</p>
                  <Select
                    aria-label="Retrieval method"
                    value={
                      collections.find((c) => c.id === selected)?.config?.retrieval || 'lexical'
                    }
                    disabled={!canEdit(p.role)}
                    onChange={async (e) => {
                      try {
                        const c = collections.find((c) => c.id === selected);
                        await api(
                          `${p.base}/collections/${selected}`,
                          { config: { ...c.config, retrieval: e.target.value } },
                          'PUT',
                        );
                        reload();
                        loadSources();
                        p.notify('Retrieval method updated. Sources are being reindexed.');
                      } catch (error) {
                        p.notify((error as Error).message, true);
                      }
                    }}
                  >
                    <option value="lexical">Keyword search</option>
                    <option value="semantic">Semantic search · local embeddings</option>
                    <option value="hybrid">Hybrid search · keywords + semantics</option>
                  </Select>
                </div>
                <div className="inline-actions">
                  <Button onClick={() => setWebsite(true)} disabled={!canEdit(p.role)}>
                    <Globe size={15} />
                    Add website
                  </Button>
                  <Button
                    onClick={() => fileInput.current?.click()}
                    disabled={busy || !canEdit(p.role)}
                  >
                    <Upload size={15} />
                    {busy ? 'Uploading…' : 'Upload document'}
                  </Button>
                </div>
              </div>
              <input
                ref={fileInput}
                type="file"
                accept=".pdf,.docx,.txt,.md,.csv,.json,.html"
                hidden
                onChange={(e) => {
                  if (e.target.files?.[0]) upload(e.target.files[0]);
                  e.target.value = '';
                }}
              />
              {!sources.length ? (
                <div
                  className="upload-zone"
                  onDragOver={(e) => e.preventDefault()}
                  onDrop={(e) => {
                    e.preventDefault();
                    if (canEdit(p.role) && e.dataTransfer.files[0]) upload(e.dataTransfer.files[0]);
                  }}
                >
                  <Upload size={27} />
                  <h3>Your sources belong here</h3>
                  <p>
                    Drop a document or use Upload document.
                    <br />
                    PDF, DOCX, text, Markdown, CSV, JSON, HTML · up to 15 MB
                  </p>
                </div>
              ) : (
                <div className="source-list">
                  {sources.map((s) => (
                    <div key={s.id}>
                      <IconTile color="blue">
                        <FileText size={18} />
                      </IconTile>
                      <span className="grow">
                        <strong>{s.name}</strong>
                        <small>
                          {(s.size / 1024).toFixed(1)} KB · {s.error || `${s.progress}% indexed`}
                        </small>
                        {['queued', 'indexing'].includes(s.status) && (
                          <progress
                            aria-label={`Indexing ${s.name}`}
                            max={100}
                            value={s.progress || 0}
                          />
                        )}
                        {s.error && (
                          <small className="text-error">
                            Check the file format and extracted text, then reindex. Scanned PDFs
                            need OCR.
                          </small>
                        )}
                      </span>
                      <Badge status={s.status} />
                      <Button
                        variant="icon"
                        title="Edit source metadata"
                        disabled={!canEdit(p.role)}
                        onClick={() =>
                          setMetadataSource({ ...s, metadata: JSON.parse(s.metadata || '{}') })
                        }
                      >
                        <Settings size={15} />
                      </Button>
                      <Button
                        variant="icon"
                        title="Reindex source"
                        disabled={!canEdit(p.role)}
                        onClick={async () => {
                          await api(`${p.base}/sources/${s.id}/reindex`, {});
                          loadSources();
                        }}
                      >
                        <RefreshCw size={15} />
                      </Button>
                      <Button
                        variant="icon"
                        title="Delete source"
                        disabled={!canEdit(p.role)}
                        onClick={async () => {
                          await api(`${p.base}/sources/${s.id}`, undefined, 'DELETE');
                          loadSources();
                          reload();
                        }}
                      >
                        <Trash2 size={15} />
                      </Button>
                    </div>
                  ))}
                </div>
              )}
            </section>
            <section className="panel retrieval-panel">
              <div className="section-heading">
                <div>
                  <h3>Try a retrieval</h3>
                  <p>See the passages your agents will receive, with source citations.</p>
                </div>
                <Search size={20} />
              </div>
              <form
                className="inline-form"
                onSubmit={async (e) => {
                  e.preventDefault();
                  try {
                    const r = await api(`${p.base}/collections/${selected}/retrieve`, {
                      query,
                      topK: 4,
                      options: retrievalOptions,
                    });
                    setResults(r.sources);
                    if (!r.sources.length) p.notify('No matching passages found');
                  } catch (e) {
                    p.notify((e as Error).message, true);
                  }
                }}
              >
                <input
                  required
                  placeholder="Ask something about your sources…"
                  aria-label="Retrieval query"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                />
                <Button type="submit">
                  Retrieve
                  <ArrowRight size={15} />
                </Button>
              </form>
              <details>
                <summary>Retrieval controls</summary>
                <JsonField
                  label="Filters & reranking"
                  value={retrievalOptions}
                  onChange={setRetrievalOptions}
                  hint='Use metadata: {"team":"support"}, sourceIds, nameContains, maxPerSource, minScore, rerankConnectionId and rerankModel. Reranking calls the connection’s /rerank endpoint.'
                />
              </details>
              {results.map((r, i) => (
                <div className="retrieval-result" key={i}>
                  <span className="source-citation">{r.citation}</span>
                  <p>{r.content}</p>
                  <details className="citation-details">
                    <summary>Inspect citation</summary>
                    <dl>
                      <dt>Source</dt>
                      <dd>{r.source || r.sourceId}</dd>
                      <dt>Source ID</dt>
                      <dd>{r.sourceId}</dd>
                      <dt>Chunk ID</dt>
                      <dd>{r.chunkId}</dd>
                      {r.sourceVersion != null && (
                        <>
                          <dt>Evidence version</dt>
                          <dd>{r.sourceVersion}</dd>
                        </>
                      )}
                      {r.retrieval && (
                        <>
                          <dt>Retrieval method</dt>
                          <dd>{r.retrieval}</dd>
                        </>
                      )}
                      {Number.isFinite(r.score) && (
                        <>
                          <dt>Relevance score</dt>
                          <dd>{r.score} (method-specific; not confidence)</dd>
                        </>
                      )}
                    </dl>
                  </details>
                  {r.url && (
                    <a target="_blank" rel="noreferrer" href={r.url}>
                      View source
                      <ArrowUpRight size={13} />
                    </a>
                  )}
                </div>
              ))}
            </section>
          </div>
        </div>
      )}
      {modal && (
        <Modal title="Create a knowledge collection" onClose={() => setModal(false)}>
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              const form = new FormData(e.currentTarget);
              try {
                const r = await api(`${p.base}/collections`, {
                  name: form.get('name'),
                  config: {
                    chunkSize: Number(form.get('chunkSize')),
                    overlap: Number(form.get('overlap')),
                    retrieval: form.get('retrieval'),
                  },
                });
                reload();
                setSelected(r.id);
                setModal(false);
                p.notify('Collection created');
              } catch (e) {
                p.notify((e as Error).message, true);
              }
            }}
          >
            <Field label="Collection name">
              <input name="name" required placeholder="Product knowledge" />
            </Field>
            <Field
              label="Retrieval method"
              hint="Semantic and hybrid modes run embeddings locally. The first use downloads the model; no API credits are needed."
            >
              <Select name="retrieval" defaultValue="lexical">
                <option value="lexical">Keyword search</option>
                <option value="semantic">Semantic search</option>
                <option value="hybrid">Hybrid search</option>
              </Select>
            </Field>
            <div className="form-grid">
              <Field label="Chunk size (characters)">
                <input name="chunkSize" type="number" defaultValue="1000" min="200" max="4000" />
              </Field>
              <Field label="Overlap (characters)">
                <input name="overlap" type="number" defaultValue="150" min="0" max="1000" />
              </Field>
            </div>
            <div className="modal-actions">
              <Button variant="primary" type="submit">
                Create collection
              </Button>
            </div>
          </form>
        </Modal>
      )}
      {metadataSource && (
        <Modal title={`Metadata · ${metadataSource.name}`} onClose={() => setMetadataSource(null)}>
          <JsonField
            label="Document metadata"
            value={metadataSource.metadata}
            onChange={(v) => setMetadataSource({ ...metadataSource, metadata: v })}
            hint='Up to 20 fields with string, number, or boolean values. For example {"team":"support","year":2026}.'
          />
          <Button
            variant="primary"
            onClick={async () => {
              try {
                await api(
                  `${p.base}/sources/${metadataSource.id}/metadata`,
                  { metadata: metadataSource.metadata },
                  'PUT',
                );
                setMetadataSource(null);
                loadSources();
                p.notify('Metadata saved');
              } catch (e) {
                p.notify((e as Error).message, true);
              }
            }}
          >
            Save metadata
          </Button>
        </Modal>
      )}
      {website && (
        <Modal
          title="Add a website"
          subtitle="Index a public page or crawl linked pages from the same website."
          onClose={() => setWebsite(false)}
        >
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              setBusy(true);
              try {
                await api(`${p.base}/collections/${selected}/website`, {
                  url: new FormData(e.currentTarget).get('url'),
                  maxPages: Number(new FormData(e.currentTarget).get('maxPages')),
                });
                setWebsite(false);
                loadSources();
                reload();
                p.notify('Website ingested');
              } catch (e) {
                p.notify((e as Error).message, true);
              } finally {
                setBusy(false);
              }
            }}
          >
            <Field label="Page URL">
              <input name="url" type="url" required placeholder="https://example.com/docs" />
            </Field>
            <Field
              label="Maximum pages"
              hint="Follows links on the same website and checks robots.txt. Existing pages are skipped."
            >
              <input name="maxPages" type="number" min="1" max="20" defaultValue="1" />
            </Field>
            <div className="modal-actions">
              <Button variant="primary" type="submit" disabled={busy}>
                {busy ? 'Ingesting…' : 'Ingest page'}
              </Button>
            </div>
          </form>
        </Modal>
      )}
    </>
  );
}

export { Connections, Tools } from './resources';
export {
  RunTable,
  RunDetails,
  RunHistory,
  Applications,
  Team,
  WorkspaceSettings,
  PublishedChat,
} from './operations';
import { RunTable } from './operations';
