import { useState } from 'react';
import {
  Plus,
  Zap,
  Plug,
  Trash2,
  Play,
  Shield,
  ExternalLink,
  Check,
  Globe,
  FileText,
  Database,
  Search,
  Terminal,
  ArrowUpRight,
} from 'lucide-react';
import { api, pretty, type PageProps } from './api';
import { useData } from './pages';
import { Button, Modal, Field, Select, PageHeader, Empty, Badge, JsonField, Confirm } from './ui';
const admin = (role: string) => ['owner', 'administrator'].includes(role);
export function Connections(p: PageProps) {
  const { data, reload } = useData<any[]>(`${p.base}/connections`, p.notify);
  const [editing, setEditing] = useState<any>(null),
    [models, setModels] = useState<string[]>([]),
    [testing, setTesting] = useState(''),
    [deleting, setDeleting] = useState<any>(null);
  return (
    <>
      <PageHeader
        eyebrow="YOUR MODELS. YOUR CHOICE."
        title="Credentials & model connections"
        description="Bring a hosted provider or an OpenAI-compatible local model."
      >
        {admin(p.role) && (
          <Button
            variant="primary"
            onClick={() =>
              setEditing({
                name: '',
                provider: 'openai-compatible',
                endpoint: 'https://api.openai.com/v1',
                model: '',
                secret: '',
                config: { allowPrivate: false },
              })
            }
          >
            <Plus size={16} />
            Add connection
          </Button>
        )}
      </PageHeader>
      <div className="info-banner">
        <Shield size={20} />
        <div>
          <strong>Credentials stay with your workspace.</strong>
          <p>
            Stored encrypted on the server. Responses and workflow exports contain connection
            references only.
          </p>
        </div>
      </div>
      {data?.length ? (
        <div className="card-grid">
          {data.map((c) => (
            <article className="connection-card panel" key={c.id}>
              <div className="card-top">
                <div className="icon-tile green">
                  <Zap size={22} />
                </div>
                <Badge status="draft">
                  {c.provider === 'credential'
                    ? 'Reusable credential'
                    : c.provider === 'anthropic'
                      ? 'Anthropic'
                      : 'OpenAI compatible'}
                </Badge>
              </div>
              <h3>{c.name}</h3>
              <p className="model-name">{c.model || 'Encrypted API credential'}</p>
              {c.endpoint && <code className="endpoint">{c.endpoint}</code>}
              <div className="agent-meta">
                <span>
                  <Shield size={14} />
                  {c.hasCredential ? 'Credential encrypted' : 'No API key · local connection'}
                </span>
              </div>
              <footer>
                <Button
                  disabled={c.provider === 'credential' || !!testing || !admin(p.role)}
                  onClick={async () => {
                    setTesting(c.id);
                    try {
                      const r = await api(`${p.base}/connections/${c.id}/test`, {});
                      p.notify(r.message);
                    } catch (e) {
                      p.notify((e as Error).message, true);
                    } finally {
                      setTesting('');
                    }
                  }}
                >
                  <Play size={14} />
                  {c.provider === 'credential'
                    ? 'Test through a tool'
                    : testing === c.id
                      ? 'Testing…'
                      : 'Test connection'}
                </Button>
                <Button
                  variant="ghost"
                  disabled={!admin(p.role)}
                  onClick={() => setEditing({ ...c, secret: '' })}
                >
                  Edit
                </Button>
                <Button
                  variant="icon"
                  aria-label={`Delete connection ${c.name}`}
                  disabled={!admin(p.role)}
                  onClick={() => setDeleting(c)}
                >
                  <Trash2 size={15} />
                </Button>
              </footer>
            </article>
          ))}
        </div>
      ) : (
        <Empty
          icon={<Zap size={28} />}
          title="Connect your first model"
          description="Use OpenAI-compatible endpoints, Anthropic, Ollama, LM Studio, or another compatible self-hosted server."
          action={
            <Button
              disabled={!admin(p.role)}
              onClick={() =>
                setEditing({
                  name: '',
                  provider: 'openai-compatible',
                  endpoint: 'http://127.0.0.1:11434/v1',
                  model: '',
                  secret: '',
                  config: { allowPrivate: true },
                })
              }
            >
              Connect a local model
              <ArrowUpRight size={15} />
            </Button>
          }
        />
      )}
      <div className="provider-explainer panel">
        <h3>Two adapters. Many possibilities.</h3>
        <div className="provider-grid">
          <div>
            <strong>OpenAI-compatible</strong>
            <p>
              Streaming chat completions and function tools. Choose the exact model and base URL
              offered by your provider.
            </p>
          </div>
          <div>
            <strong>Anthropic</strong>
            <p>Messages API streaming and tool use. Base URL ends in /v1.</p>
          </div>
          <div>
            <strong>Local & self-hosted</strong>
            <p>
              Ollama or LM Studio with an OpenAI-compatible endpoint. Enable local network access on
              that connection.
            </p>
          </div>
        </div>
        {admin(p.role) && (
          <Button
            onClick={async () => {
              try {
                await api(`${p.base}/model-cache`, undefined, 'DELETE');
                p.notify('Workspace model cache cleared');
              } catch (e) {
                p.notify((e as Error).message, true);
              }
            }}
          >
            Clear model response cache
          </Button>
        )}
      </div>
      {editing && (
        <Modal
          title={editing.id ? 'Edit connection' : 'Add a connection or credential'}
          subtitle="Use reusable credentials for API tools, or connect a model provider."
          onClose={() => setEditing(null)}
        >
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              try {
                await api(
                  `${p.base}/connections${editing.id ? '/' + editing.id : ''}`,
                  editing,
                  editing.id ? 'PUT' : 'POST',
                );
                setEditing(null);
                reload();
                p.notify('Connection saved');
              } catch (e) {
                p.notify((e as Error).message, true);
              }
            }}
          >
            {!editing.id && (
              <Field label="Quick provider setup">
                <Select
                  defaultValue=""
                  onChange={(e) => {
                    const presets: any = {
                      groq: {
                        name: 'Groq',
                        endpoint: 'https://api.groq.com/openai/v1',
                        model: 'openai/gpt-oss-20b',
                      },
                      openai: { name: 'OpenAI', endpoint: 'https://api.openai.com/v1', model: '' },
                      anthropic: {
                        name: 'Anthropic',
                        provider: 'anthropic',
                        endpoint: 'https://api.anthropic.com/v1',
                        model: '',
                      },
                      ollama: {
                        name: 'Ollama',
                        endpoint: 'http://127.0.0.1:11434/v1',
                        model: '',
                        local: true,
                      },
                      lmstudio: {
                        name: 'LM Studio',
                        endpoint: 'http://127.0.0.1:1234/v1',
                        model: '',
                        local: true,
                      },
                    };
                    const v = presets[e.target.value];
                    if (v)
                      setEditing({
                        ...editing,
                        ...v,
                        provider: v.provider || 'openai-compatible',
                        secret: '',
                        config: { ...editing.config, allowPrivate: !!v.local },
                      });
                  }}
                >
                  <option value="">Choose a provider or configure manually</option>
                  <option value="groq">Groq</option>
                  <option value="openai">OpenAI</option>
                  <option value="anthropic">Anthropic</option>
                  <option value="ollama">Ollama (local)</option>
                  <option value="lmstudio">LM Studio (local)</option>
                </Select>
              </Field>
            )}
            <Field label="Connection name">
              <input
                value={editing.name}
                required
                placeholder="Our research model"
                onChange={(e) => setEditing({ ...editing, name: e.target.value })}
              />
            </Field>
            <Field label="Provider adapter">
              <Select
                value={editing.provider}
                onChange={(e) =>
                  setEditing({
                    ...editing,
                    provider: e.target.value,
                    endpoint:
                      e.target.value === 'credential'
                        ? ''
                        : e.target.value === 'anthropic'
                          ? 'https://api.anthropic.com/v1'
                          : 'https://api.openai.com/v1',
                  })
                }
              >
                <option value="openai-compatible">OpenAI-compatible (including local)</option>
                <option value="anthropic">Anthropic</option>
                <option value="credential">Reusable API credential</option>
              </Select>
            </Field>
            {editing.provider !== 'credential' && (
              <>
                <Field
                  label="Base endpoint"
                  hint="Include /v1 where required. Do not append /chat/completions or /messages."
                >
                  <input
                    required
                    type="url"
                    value={editing.endpoint}
                    onChange={(e) => setEditing({ ...editing, endpoint: e.target.value })}
                  />
                </Field>
                {editing.id && editing.provider === 'openai-compatible' && (
                  <Button
                    type="button"
                    onClick={async () => {
                      try {
                        setModels(await api(`${p.base}/connections/${editing.id}/models`));
                        p.notify('Available models loaded from the saved connection');
                      } catch (error) {
                        p.notify((error as Error).message, true);
                      }
                    }}
                  >
                    Discover available models
                  </Button>
                )}
                <datalist id="provider-models">
                  {models.map((m) => (
                    <option key={m} value={m} />
                  ))}
                </datalist>
                <Field label="Model identifier">
                  <input
                    required
                    value={editing.model}
                    list="provider-models"
                    placeholder="Exact model ID from your provider"
                    onChange={(e) => setEditing({ ...editing, model: e.target.value })}
                  />
                </Field>
              </>
            )}
            <Field
              label={editing.provider === 'credential' ? 'API key or Bearer token' : 'API key'}
              hint={
                editing.id
                  ? 'Leave blank to keep the stored credential.'
                  : editing.provider === 'credential'
                    ? 'Used by assigned tools; stored encrypted.'
                    : 'Optional for local servers that do not require a key.'
              }
            >
              <input
                type="password"
                autoComplete="new-password"
                value={editing.secret}
                onChange={(e) => setEditing({ ...editing, secret: e.target.value })}
              />
            </Field>
            <label className="checkbox">
              <input
                type="checkbox"
                checked={!!editing.config.allowPrivate}
                onChange={(e) =>
                  setEditing({
                    ...editing,
                    config: { ...editing.config, allowPrivate: e.target.checked },
                  })
                }
              />
              Allow this connection to access local/private endpoints
            </label>
            <details>
              <summary>Optional cost estimates</summary>
              <p className="muted">
                Enter current prices from your provider per million tokens. Reports label these as
                estimates.
              </p>
              <div className="form-grid">
                <Field label="Input price / 1M tokens (USD)">
                  <input
                    type="number"
                    step="0.001"
                    min="0"
                    value={editing.config.inputPrice ?? ''}
                    onChange={(e) =>
                      setEditing({
                        ...editing,
                        config: {
                          ...editing.config,
                          inputPrice: e.target.value ? Number(e.target.value) : undefined,
                        },
                      })
                    }
                  />
                </Field>
                <Field label="Output price / 1M tokens (USD)">
                  <input
                    type="number"
                    step="0.001"
                    min="0"
                    value={editing.config.outputPrice ?? ''}
                    onChange={(e) =>
                      setEditing({
                        ...editing,
                        config: {
                          ...editing.config,
                          outputPrice: e.target.value ? Number(e.target.value) : undefined,
                        },
                      })
                    }
                  />
                </Field>
              </div>
            </details>
            <div className="modal-actions">
              <Button type="submit" variant="primary">
                Save connection
              </Button>
            </div>
          </form>
        </Modal>
      )}
      {deleting && (
        <Confirm
          title="Delete this connection?"
          description="Workflows that reference it will need another connection before live execution."
          onClose={() => setDeleting(null)}
          onConfirm={async () => {
            await api(`${p.base}/connections/${deleting.id}`, undefined, 'DELETE');
            setDeleting(null);
            reload();
            p.notify('Connection deleted');
          }}
        />
      )}
    </>
  );
}
const icons: Record<string, any> = {
  http: Globe,
  web: Globe,
  search: Search,
  file: FileText,
  database: Database,
  mcp: Plug,
  custom: Terminal,
};
const defaults: Record<string, any> = {
  http: { url: '', method: 'GET' },
  web: { url: '' },
  search: { url: 'http://127.0.0.1:8080/search', allowPrivate: true, limit: 5 },
  file: { operation: 'list' },
  database: { query: 'SELECT name, content FROM documents LIMIT 10' },
  mcp: { url: '', operation: 'list' },
  custom: {
    url: '',
    method: 'POST',
    inputSchema: { type: 'object', properties: {} },
    outputSchema: { type: 'object' },
  },
};
export function Tools(p: PageProps) {
  const { data, reload } = useData<any[]>(`${p.base}/tools`, p.notify);
  const { data: catalog } = useData(`${p.base}/catalog`, p.notify);
  const { data: connections } = useData<any[]>(`${p.base}/connections`, p.notify);
  const [editing, setEditing] = useState<any>(null),
    [library, setLibrary] = useState(false),
    [test, setTest] = useState<any>(null),
    [testInput, setTestInput] = useState<any>({}),
    [testResult, setTestResult] = useState<any>(null),
    [busy, setBusy] = useState(false),
    [deleting, setDeleting] = useState<any>(null);
  const cfg = (key: string, value: any) =>
    setEditing((v: any) => ({ ...v, config: { ...v.config, [key]: value } }));
  return (
    <>
      <PageHeader
        title="Tools & integrations"
        description="Give your agents useful ways to act on the world."
      >
        {admin(p.role) && (
          <Button variant="primary" onClick={() => setLibrary(true)}>
            <Plus size={16} />
            Add tool
          </Button>
        )}
      </PageHeader>
      {data?.length ? (
        <div className="card-grid">
          {data.map((t) => {
            const Icon = icons[t.kind] || Plug;
            return (
              <article className="tool-card panel" key={t.id}>
                <div className="card-top">
                  <div className="icon-tile blue">
                    <Icon size={22} />
                  </div>
                  <Badge status="ready">Configured</Badge>
                </div>
                <h3>{t.name}</h3>
                <p>{catalog?.tools.find((x: any) => x.kind === t.kind)?.description}</p>
                <code className="endpoint">
                  {t.config.url || t.config.query || `Workspace files · ${t.config.operation}`}
                </code>
                <footer>
                  <Button
                    disabled={!admin(p.role)}
                    onClick={() => {
                      setTest(t);
                      setTestInput({});
                      setTestResult(null);
                    }}
                  >
                    <Play size={14} />
                    Test tool
                  </Button>
                  <Button variant="ghost" onClick={() => setEditing(t)} disabled={!admin(p.role)}>
                    Configure
                  </Button>
                  <Button
                    variant="icon"
                    title="Delete tool"
                    onClick={() => setDeleting(t)}
                    disabled={!admin(p.role)}
                  >
                    <Trash2 size={15} />
                  </Button>
                </footer>
              </article>
            );
          })}
        </div>
      ) : (
        <Empty
          icon={<Plug size={28} />}
          title="Every team needs the right tools"
          description="Configure an integration, test its inputs, then assign it to an agent or a workflow step."
          action={
            <Button onClick={() => setLibrary(true)} disabled={!admin(p.role)}>
              Explore integrations
              <ArrowUpRight size={15} />
            </Button>
          }
        />
      )}
      <div className="info-banner">
        <Check size={20} />
        <div>
          <strong>Available means executable.</strong>
          <p>
            Only implemented integrations are listed here. Search requires your SearXNG endpoint.
            MCP supports Streamable HTTP servers.
          </p>
        </div>
      </div>
      {library && (
        <Modal title="Choose a capability" wide onClose={() => setLibrary(false)}>
          <div className="template-grid">
            {catalog?.tools.map((t: any) => {
              const Icon = icons[t.kind] || Plug;
              return (
                <button
                  className="template-card"
                  key={t.kind}
                  onClick={() => {
                    setEditing({
                      name: t.name,
                      kind: t.kind,
                      config: structuredClone(defaults[t.kind]),
                    });
                    setLibrary(false);
                  }}
                >
                  <Icon size={24} />
                  <strong>{t.name}</strong>
                  <p>{t.description}</p>
                  <span>
                    Configure
                    <ArrowUpRight size={15} />
                  </span>
                </button>
              );
            })}
          </div>
        </Modal>
      )}
      {editing && (
        <Modal
          title={editing.id ? 'Configure tool' : 'Add tool'}
          subtitle="Credentials are selected from reusable model connections."
          onClose={() => setEditing(null)}
        >
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              try {
                await api(
                  `${p.base}/tools${editing.id ? '/' + editing.id : ''}`,
                  editing,
                  editing.id ? 'PUT' : 'POST',
                );
                setEditing(null);
                reload();
                p.notify('Tool saved');
              } catch (e) {
                p.notify((e as Error).message, true);
              }
            }}
          >
            <Field label="Tool name">
              <input
                required
                value={editing.name}
                onChange={(e) => setEditing({ ...editing, name: e.target.value })}
              />
            </Field>
            {['http', 'web', 'search', 'mcp', 'custom'].includes(editing.kind) && (
              <Field label={editing.kind === 'search' ? 'SearXNG JSON endpoint' : 'Endpoint URL'}>
                <input
                  type="url"
                  required
                  value={editing.config.url || ''}
                  onChange={(e) => cfg('url', e.target.value)}
                />
              </Field>
            )}
            {['http', 'custom'].includes(editing.kind) && (
              <Field label="Method">
                <Select
                  value={editing.config.method || 'GET'}
                  onChange={(e) => cfg('method', e.target.value)}
                >
                  {['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].map((v) => (
                    <option key={v}>{v}</option>
                  ))}
                </Select>
              </Field>
            )}
            {editing.kind === 'file' && (
              <>
                <Field label="File operation">
                  <Select
                    value={editing.config.operation || 'list'}
                    onChange={(e) => cfg('operation', e.target.value)}
                  >
                    <option value="list">List files</option>
                    <option value="read">Read artifact by ID</option>
                    <option value="write">Write workflow result</option>
                  </Select>
                </Field>
                {editing.config.operation === 'read' && (
                  <Field label="Artifact ID">
                    <input
                      value={editing.config.artifactId || ''}
                      onChange={(e) => cfg('artifactId', e.target.value)}
                    />
                  </Field>
                )}
                {editing.config.operation === 'write' && (
                  <Field label="Output filename">
                    <input
                      value={editing.config.name || ''}
                      placeholder="report.txt"
                      onChange={(e) => cfg('name', e.target.value)}
                    />
                  </Field>
                )}
              </>
            )}
            {editing.kind === 'database' && (
              <Field
                label="Read-only SQL"
                hint="The documents table includes only this workspace’s indexed sources: id, name, content, collection_id."
              >
                <textarea
                  rows={4}
                  value={editing.config.query || ''}
                  onChange={(e) => cfg('query', e.target.value)}
                />
              </Field>
            )}
            {editing.kind === 'mcp' && (
              <>
                <Field label="Operation">
                  <Select
                    value={editing.config.operation || 'list'}
                    onChange={(e) => cfg('operation', e.target.value)}
                  >
                    <option value="list">Discover tools</option>
                    <option value="call">Call tool</option>
                  </Select>
                </Field>
                {editing.config.operation === 'call' && (
                  <Field label="MCP tool name">
                    <input
                      required
                      value={editing.config.toolName || ''}
                      onChange={(e) => cfg('toolName', e.target.value)}
                    />
                  </Field>
                )}
              </>
            )}
            {['http', 'search', 'mcp', 'custom'].includes(editing.kind) && (
              <>
                <Field label="Reusable credential">
                  <Select
                    value={editing.config.connectionId || ''}
                    onChange={(e) => cfg('connectionId', e.target.value)}
                  >
                    <option value="">No authentication</option>
                    {connections?.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name}
                      </option>
                    ))}
                  </Select>
                </Field>
                <label className="checkbox">
                  <input
                    type="checkbox"
                    checked={!!editing.config.allowPrivate}
                    onChange={(e) => cfg('allowPrivate', e.target.checked)}
                  />
                  Allow local/private network requests
                </label>
              </>
            )}
            <details>
              <summary>Headers, body, and input/output schemas</summary>
              <JsonField
                key={editing.id || editing.kind}
                value={editing.config}
                onChange={(config) => setEditing({ ...editing, config })}
                hint="Use inputSchema and outputSchema for JSON schema validation. Reference credentials by connectionId."
              />
            </details>
            <label className="checkbox">
              <input
                type="checkbox"
                checked={!!editing.config.requireApproval}
                onChange={(e) => cfg('requireApproval', e.target.checked)}
              />
              Require a human decision before this tool executes
            </label>
            <div className="modal-actions">
              <Button variant="primary" type="submit">
                Save tool
              </Button>
            </div>
          </form>
        </Modal>
      )}
      {test && (
        <Modal
          title={`Test ${test.name}`}
          subtitle="This runs the real integration, including any configured external action."
          onClose={() => setTest(null)}
        >
          <JsonField value={testInput} onChange={setTestInput} label="Input payload" />
          <Button
            variant="primary"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              try {
                const r = await api(`${p.base}/tools/${test.id}/test`, { input: testInput });
                setTestResult(r.output);
                p.notify('Tool executed successfully');
              } catch (e) {
                p.notify((e as Error).message, true);
              } finally {
                setBusy(false);
              }
            }}
          >
            <Play size={15} />
            {busy ? 'Running…' : 'Execute tool'}
          </Button>
          {testResult !== null && <pre className="result-block">{pretty(testResult)}</pre>}
          {testResult?.runId && (
            <Button
              onClick={() => {
                setTest(null);
                p.go('history', testResult.runId);
              }}
            >
              Review tool approval
            </Button>
          )}
        </Modal>
      )}
      {deleting && (
        <Confirm
          title="Delete this tool?"
          description="Agents and workflow steps that reference it will need a replacement."
          onClose={() => setDeleting(null)}
          onConfirm={async () => {
            await api(`${p.base}/tools/${deleting.id}`, undefined, 'DELETE');
            setDeleting(null);
            reload();
          }}
        />
      )}
    </>
  );
}
