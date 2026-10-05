import { useState, useEffect } from 'react';
import {
  Plus,
  Play,
  ClipboardCheck,
  BookText,
  Activity,
  Download,
  ArrowRight,
  Trash2,
  Clock,
} from 'lucide-react';
import { api, pretty, download, type PageProps } from './api';
import { useData } from './pages';
import { Button, PageHeader, Field, Select, Modal, Empty, Badge, Loading } from './ui';
const edit = (role: string) => role !== 'viewer',
  admin = (role: string) => ['owner', 'administrator'].includes(role);
export function Evaluations(p: PageProps) {
  const { data: datasets, reload: loadDatasets } = useData<any[]>(`${p.base}/datasets`, p.notify);
  const { data: evaluations, reload: loadEvaluations } = useData<any[]>(
    `${p.base}/evaluations`,
    p.notify,
  );
  const { data: workflows } = useData<any[]>(`${p.base}/workflows`, p.notify);
  const { data: connections } = useData<any[]>(`${p.base}/connections`, p.notify);
  const [tab, setTab] = useState('runs'),
    [dataset, setDataset] = useState<any>(null),
    [cases, setCases] = useState(''),
    [running, setRunning] = useState(false),
    [selected, setSelected] = useState(''),
    [detail, setDetail] = useState<any>(null),
    [baseline, setBaseline] = useState(''),
    [comparison, setComparison] = useState<any>(null),
    [busy, setBusy] = useState(false);
  useEffect(() => {
    const t = setInterval(loadEvaluations, 2000);
    return () => clearInterval(t);
  }, [loadEvaluations]);
  useEffect(() => {
    setDetail(null);
    if (!selected) return;
    let current = true;
    const load = () =>
      api(`${p.base}/evaluations/${selected}`)
        .then((value) => {
          if (current) setDetail(value);
        })
        .catch((e) => {
          if (current) p.notify(e.message, true);
        });
    void load();
    const t = setInterval(load, 1500);
    return () => {
      current = false;
      clearInterval(t);
    };
  }, [selected, p.base, p.notify]);
  async function compare(value: string) {
    setBaseline(value);
    setComparison(null);
    if (value)
      try {
        setComparison(await api(`${p.base}/evaluations/${selected}/compare/${value}`));
      } catch (e) {
        p.notify((e as Error).message, true);
      }
  }
  return (
    <>
      <PageHeader
        eyebrow="MEASURE BEFORE YOU SHIP"
        title="Evaluations"
        description="Test your workflows on saved cases. Compare quality, usage, and revisions."
      >
        <Button
          disabled={!edit(p.role)}
          onClick={() => {
            setDataset({
              name: '',
              description: '',
              cases: [{ input: 'Your test input', expected: 'Expected answer' }],
            });
            setCases('[\n  {"input": "Your test input", "expected": "Expected answer"}\n]');
          }}
        >
          <Plus size={15} />
          New dataset
        </Button>
        <Button
          variant="primary"
          disabled={!edit(p.role) || !datasets?.length || !workflows?.length}
          onClick={() => setRunning(true)}
        >
          <Play size={15} />
          Run evaluation
        </Button>
      </PageHeader>
      <div className="tabs">
        <button className={tab === 'runs' ? 'active' : ''} onClick={() => setTab('runs')}>
          Evaluation runs
        </button>
        <button className={tab === 'datasets' ? 'active' : ''} onClick={() => setTab('datasets')}>
          Datasets
        </button>
      </div>
      {tab === 'datasets' ? (
        <div className="card-grid">
          {datasets?.map((d) => (
            <article className="panel quality-card" key={d.id}>
              <BookText size={22} />
              <h3>{d.name}</h3>
              <p>{d.description || 'Reusable workflow test cases'}</p>
              <span className="muted">
                {d.cases.length} cases · revision {d.revision}
              </span>
              <footer>
                <Button
                  disabled={!edit(p.role)}
                  onClick={() => {
                    setDataset(d);
                    setCases(pretty(d.cases));
                  }}
                >
                  Edit dataset
                </Button>
                <Button onClick={() => download(`${d.name}.json`, d.cases)}>
                  <Download size={14} />
                  Export
                </Button>
                <Button
                  variant="icon"
                  aria-label={`Delete dataset ${d.name}`}
                  disabled={!edit(p.role)}
                  onClick={async () => {
                    try {
                      await api(`${p.base}/datasets/${d.id}`, undefined, 'DELETE');
                      loadDatasets();
                    } catch (error) {
                      p.notify((error as Error).message, true);
                    }
                  }}
                >
                  <Trash2 size={14} />
                </Button>
              </footer>
            </article>
          ))}
          {!datasets?.length && (
            <Empty
              title="Start with a test dataset"
              description="Save inputs and expected outputs, then check each workflow revision against the same cases."
            />
          )}
        </div>
      ) : (
        <div className="quality-layout">
          <div className="panel quality-list">
            {evaluations?.length ? (
              evaluations.map((entry) => {
                const e = detail?.id === entry.id ? detail : entry;
                return (
                  <button
                    key={e.id}
                    className={selected === e.id ? 'active' : ''}
                    onClick={() => {
                      setSelected(e.id);
                      setBaseline('');
                      setComparison(null);
                    }}
                  >
                    <strong>{e.name}</strong>
                    <span>
                      <Badge status={e.status} />
                      <small>
                        {Math.round((e.summary.meanScore || 0) * 100)}% · {e.summary.completed || 0}
                        /{e.summary.total || 0} cases · {e.config.mode}
                      </small>
                    </span>
                  </button>
                );
              })
            ) : (
              <Empty
                title="Your quality history starts here"
                description="Run an evaluation to record scores and inspect each answer."
                icon={<ClipboardCheck size={25} />}
              />
            )}
          </div>
          <div>
            {!detail ? (
              <div className="panel quality-intro">
                <ClipboardCheck size={36} />
                <h2>Confidence comes from evidence.</h2>
                <p>
                  Keep repeatable tests for the tasks your agents perform. Development preview
                  checks the workflow structure; Live evaluates your connected models.
                </p>
                <p>
                  Success-only checks measure execution, not answer quality. Add expected answers or
                  scoring rules to measure correctness.
                </p>
              </div>
            ) : (
              <>
                <section className="panel quality-card">
                  <div className="section-heading">
                    <div>
                      <h2>{detail.name}</h2>
                      <p>
                        Workflow revision {detail.workflow_revision} ·{' '}
                        {detail.config.mode === 'preview'
                          ? 'Development preview'
                          : 'Live model evaluation'}
                      </p>
                    </div>
                    <Badge status={detail.status} />
                  </div>
                  <div className="quality-metrics">
                    <div>
                      <strong>{Math.round((detail.summary.meanScore || 0) * 100)}%</strong>
                      <small>Mean score</small>
                    </div>
                    <div>
                      <strong>
                        {detail.summary.passed || 0}/{detail.summary.total || 0}
                      </strong>
                      <small>Passed at threshold</small>
                    </div>
                    <div>
                      <strong>
                        {(detail.summary.inputTokens || 0) + (detail.summary.outputTokens || 0)}
                      </strong>
                      <small>Model tokens</small>
                    </div>
                    <div>
                      <strong>
                        {detail.summary.costConfigured === false
                          ? '—'
                          : `$${(detail.summary.estimatedCost || 0).toFixed(4)}`}
                      </strong>
                      <small>
                        {detail.summary.costConfigured === false
                          ? 'Prices not configured'
                          : 'Estimated cost'}
                      </small>
                    </div>
                  </div>
                  <div className="inline-actions">
                    <Button onClick={() => download('evaluation.json', detail)}>
                      <Download size={14} />
                      Export results
                    </Button>
                    {detail.status === 'running' && (
                      <Button
                        disabled={!edit(p.role)}
                        onClick={async () => {
                          await api(`${p.base}/evaluations/${selected}/cancel`, {});
                          loadEvaluations();
                        }}
                      >
                        Cancel evaluation
                      </Button>
                    )}
                  </div>
                  <Field label="Compare with a previous evaluation">
                    <Select value={baseline} onChange={(e) => void compare(e.target.value)}>
                      <option value="">Choose a baseline</option>
                      {evaluations
                        ?.filter((e) => e.id !== selected && e.status === 'completed')
                        .map((e) => (
                          <option key={e.id} value={e.id}>
                            {e.name} · revision {e.workflow_revision}
                          </option>
                        ))}
                    </Select>
                  </Field>
                  {comparison && (
                    <p className="comparison-note">
                      Score change: {comparison.scoreDelta >= 0 ? '+' : ''}
                      {(comparison.scoreDelta * 100).toFixed(1)} percentage points · estimated cost
                      change:{' '}
                      {comparison.costDelta == null
                        ? 'prices not configured'
                        : `$${comparison.costDelta.toFixed(4)}`}
                    </p>
                  )}
                </section>
                <section className="panel quality-cases">
                  <h3>Case results</h3>
                  {detail.cases.map((c: any) => (
                    <details key={c.id}>
                      <summary>
                        <strong>Case {c.ordinal + 1}</strong>
                        <Badge
                          status={
                            c.status === 'graded'
                              ? c.score >= (detail.config.threshold ?? 1)
                                ? 'completed'
                                : 'failed'
                              : c.status
                          }
                        />
                        <span>{c.score == null ? 'Pending' : `${Math.round(c.score * 100)}%`}</span>
                      </summary>
                      <div className="form-grid">
                        <div>
                          <span className="eyebrow">INPUT</span>
                          <pre>{pretty(c.input)}</pre>
                        </div>
                        <div>
                          <span className="eyebrow">EXPECTED</span>
                          <pre>{pretty(c.expected)}</pre>
                        </div>
                      </div>
                      <span className="eyebrow">ACTUAL OUTPUT</span>
                      <pre>{pretty(c.output)}</pre>
                      {c.error && <p className="error-text">{c.error}</p>}
                      {c.result && <pre>{pretty(c.result)}</pre>}
                      <Button onClick={() => p.go('history', c.run_id)}>
                        Inspect workflow run
                        <ArrowRight size={14} />
                      </Button>
                    </details>
                  ))}
                </section>
              </>
            )}
          </div>
        </div>
      )}
      {dataset && (
        <Modal
          wide
          title={dataset.id ? 'Edit dataset' : 'New evaluation dataset'}
          onClose={() => setDataset(null)}
        >
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              setBusy(true);
              try {
                await api(
                  `${p.base}/datasets${dataset.id ? '/' + dataset.id : ''}`,
                  { ...dataset, cases: JSON.parse(cases) },
                  dataset.id ? 'PUT' : 'POST',
                );
                setDataset(null);
                loadDatasets();
                p.notify('Dataset saved');
              } catch (error) {
                p.notify((error as Error).message, true);
              } finally {
                setBusy(false);
              }
            }}
          >
            <Field label="Dataset name">
              <input
                required
                value={dataset.name}
                onChange={(e) => setDataset({ ...dataset, name: e.target.value })}
              />
            </Field>
            <Field label="Description">
              <input
                value={dataset.description}
                onChange={(e) => setDataset({ ...dataset, description: e.target.value })}
              />
            </Field>
            <Field
              label="Test cases (JSON)"
              hint="Each case has input and an optional expected output. Up to 100 cases."
            >
              <textarea
                rows={12}
                value={cases}
                onChange={(e) => setCases(e.target.value)}
                spellCheck={false}
              />
            </Field>
            <Field label="Import JSON dataset">
              <input
                type="file"
                accept=".json"
                onChange={async (e) => {
                  if (e.target.files?.[0]) setCases(await e.target.files[0].text());
                }}
              />
            </Field>
            <div className="modal-actions">
              <Button variant="primary" disabled={busy}>
                Save dataset
              </Button>
            </div>
          </form>
        </Modal>
      )}
      {running && (
        <Modal title="Run an evaluation" wide onClose={() => setRunning(false)}>
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              const f = new FormData(e.currentTarget);
              setBusy(true);
              try {
                const r = await api(`${p.base}/evaluations`, {
                  name: f.get('name'),
                  datasetId: f.get('dataset'),
                  workflowId: f.get('workflow'),
                  mode: f.get('mode'),
                  threshold: Number(f.get('threshold')),
                  rules: JSON.parse(String(f.get('rules') || '[]')),
                  judgeConnectionId: f.get('judge') || undefined,
                  rubric: f.get('rubric') || undefined,
                });
                setRunning(false);
                setTab('runs');
                setSelected(r.id);
                loadEvaluations();
                p.notify('Evaluation started');
              } catch (error) {
                p.notify((error as Error).message, true);
              } finally {
                setBusy(false);
              }
            }}
          >
            <Field label="Evaluation name">
              <input name="name" required placeholder="Release candidate" />
            </Field>
            <div className="form-grid">
              <Field label="Dataset">
                <Select name="dataset">
                  {datasets?.map((d) => (
                    <option key={d.id} value={d.id}>
                      {d.name}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Workflow">
                <Select name="workflow">
                  {workflows?.map((w) => (
                    <option key={w.id} value={w.id}>
                      {w.name}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Execution mode">
                <Select name="mode">
                  <option value="preview">Development preview</option>
                  <option value="live">Live</option>
                </Select>
              </Field>
              <Field label="Pass threshold">
                <input
                  name="threshold"
                  type="number"
                  min="0"
                  max="1"
                  step="0.05"
                  defaultValue="1"
                />
              </Field>
            </div>
            <Field
              label="Scoring rules (JSON)"
              hint={
                'Leave [] to compare with each expected answer, or check success if no expected answer exists. Example: [{"type":"contains","path":"text","value":"answer"}]'
              }
            >
              <textarea name="rules" rows={4} defaultValue="[]" />
            </Field>
            <Field label="Optional LLM judge">
              <Select name="judge">
                <option value="">Use deterministic scoring only</option>
                {connections
                  ?.filter((c) => c.provider !== 'credential')
                  .map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
              </Select>
            </Field>
            <Field label="Judge rubric">
              <textarea name="rubric" rows={2} placeholder="Accuracy, relevance and completeness" />
            </Field>
            <p className="muted">
              Live evaluations and LLM judging use your provider quota. Workflow tools can perform
              their configured actions.
            </p>
            <div className="modal-actions">
              <Button variant="primary" disabled={busy}>
                Start evaluation
              </Button>
            </div>
          </form>
        </Modal>
      )}
    </>
  );
}
export function Prompts(p: PageProps) {
  const { data, reload } = useData<any[]>(`${p.base}/prompts`, p.notify);
  const [editing, setEditing] = useState<any>(null),
    [versions, setVersions] = useState<any[]>([]);
  async function open(prompt: any) {
    setEditing(prompt);
    setVersions(prompt.id ? await api(`${p.base}/prompts/${prompt.id}/versions`) : []);
  }
  return (
    <>
      <PageHeader
        eyebrow="REUSABLE INSTRUCTIONS"
        title="Prompt library"
        description="Keep instructions versioned. Apply a saved revision to any agent."
      >
        <Button
          variant="primary"
          disabled={!edit(p.role)}
          onClick={() => void open({ name: '', description: '', content: '' })}
        >
          <Plus size={15} />
          New prompt
        </Button>
      </PageHeader>
      <div className="card-grid">
        {data?.map((prompt) => (
          <article key={prompt.id} className="panel quality-card">
            <BookText size={23} />
            <h3>{prompt.name}</h3>
            <p>{prompt.description}</p>
            <pre className="prompt-preview">{prompt.content}</pre>
            <footer>
              <Badge>Revision {prompt.revision}</Badge>
              <Button onClick={() => void open(prompt)}>Open prompt</Button>
              <Button
                variant="icon"
                aria-label={`Delete prompt ${prompt.name}`}
                disabled={!edit(p.role)}
                onClick={async () => {
                  try {
                    await api(`${p.base}/prompts/${prompt.id}`, undefined, 'DELETE');
                    reload();
                  } catch (error) {
                    p.notify((error as Error).message, true);
                  }
                }}
              >
                <Trash2 size={14} />
              </Button>
            </footer>
          </article>
        ))}
      </div>
      {!data?.length && (
        <Empty
          title="Instructions worth reusing"
          description="Save your successful agent prompts here and keep a history of every revision."
        />
      )}
      {editing && (
        <Modal
          title={editing.id ? 'Edit prompt' : 'New prompt'}
          wide
          onClose={() => setEditing(null)}
        >
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              try {
                await api(
                  `${p.base}/prompts${editing.id ? '/' + editing.id : ''}`,
                  editing,
                  editing.id ? 'PUT' : 'POST',
                );
                setEditing(null);
                reload();
                p.notify('Prompt revision saved');
              } catch (error) {
                p.notify((error as Error).message, true);
              }
            }}
          >
            <Field label="Prompt name">
              <input
                required
                value={editing.name}
                onChange={(e) => setEditing({ ...editing, name: e.target.value })}
              />
            </Field>
            <Field label="Description">
              <input
                value={editing.description}
                onChange={(e) => setEditing({ ...editing, description: e.target.value })}
              />
            </Field>
            <Field label="Instructions">
              <textarea
                required
                rows={12}
                value={editing.content}
                onChange={(e) => setEditing({ ...editing, content: e.target.value })}
              />
            </Field>
            {versions.length > 0 && (
              <Field label="Load a saved revision">
                <Select
                  defaultValue=""
                  onChange={(e) => {
                    const v = versions.find((v) => v.id === e.target.value);
                    if (v) setEditing({ ...editing, content: v.content });
                  }}
                >
                  <option value="">Choose a revision</option>
                  {versions.map((v) => (
                    <option key={v.id} value={v.id}>
                      Revision {v.revision}
                    </option>
                  ))}
                </Select>
              </Field>
            )}
            <div className="modal-actions">
              <Button variant="primary" disabled={!edit(p.role)}>
                Save prompt revision
              </Button>
            </div>
          </form>
        </Modal>
      )}
    </>
  );
}
export function Operations(p: PageProps) {
  const { data, reload } = useData<any>(`${p.base}/operations`, p.notify),
    { data: schedules, reload: loadSchedules } = useData<any[]>(`${p.base}/schedules`, p.notify),
    { data: workflows } = useData<any[]>(`${p.base}/workflows`, p.notify);
  const [modal, setModal] = useState(false);
  useEffect(() => {
    if (!admin(p.role)) return;
    const t = setInterval(reload, 2500);
    return () => clearInterval(t);
  }, [reload, p.role]);
  if (!admin(p.role))
    return (
      <Empty
        title="Administrator access required"
        description="Workspace administrators manage workers and scheduled runs."
      />
    );
  return (
    <>
      <PageHeader
        eyebrow="WORK THAT KEEPS MOVING"
        title="Operations"
        description="Monitor execution capacity, failures, and recurring workflow runs."
      >
        <Button variant="primary" onClick={() => setModal(true)} disabled={!workflows?.length}>
          <Plus size={15} />
          Schedule workflow
        </Button>
      </PageHeader>
      {!data ? (
        <Loading />
      ) : (
        <>
          <section className="quality-metrics panel">
            <div>
              <strong>{data.workers.length}</strong>
              <small>Healthy workers</small>
            </div>
            <div>
              <strong>{data.metrics.runs}</strong>
              <small>Runs in 7 days</small>
            </div>
            <div>
              <strong>{Math.round(data.metrics.successRate * 100)}%</strong>
              <small>Terminal-run success</small>
            </div>
            <div>
              <strong>{(data.metrics.p95Ms / 1000).toFixed(1)}s</strong>
              <small>P95 execution time</small>
            </div>
          </section>
          <div className="form-grid">
            <section className="panel quality-card">
              <h3>Execution workers</h3>
              {data.workers.map((w: any) => (
                <div className="quality-row" key={w.id}>
                  <Activity size={17} />
                  <span>{w.name}</span>
                  <Badge status="ready">
                    {w.active}/{w.capacity} active steps
                  </Badge>
                </div>
              ))}
              {!data.workers.length && (
                <p>No healthy worker is connected. Queued runs wait for a worker.</p>
              )}
            </section>
            <section className="panel quality-card">
              <h3>Workspace run states</h3>
              {data.queue.map((q: any) => (
                <div className="quality-row" key={q.status}>
                  <Badge status={q.status} />
                  <strong>{q.count}</strong>
                </div>
              ))}
            </section>
          </div>
          <section className="panel quality-card">
            <h3>Scheduled workflows</h3>
            {schedules?.length ? (
              schedules.map((s) => (
                <div className="quality-row" key={s.id}>
                  <Clock size={17} />
                  <div className="grow">
                    <strong>{s.name}</strong>
                    <small>
                      {s.workflow} · every {s.interval_minutes} minutes · {s.mode}
                      <br />
                      Next: {new Date(s.next_at).toLocaleString()}
                    </small>
                  </div>
                  <Button
                    onClick={async () => {
                      await api(`${p.base}/schedules/${s.id}`, { enabled: !s.enabled }, 'PUT');
                      loadSchedules();
                    }}
                  >
                    {s.enabled ? 'Pause' : 'Enable'}
                  </Button>
                  {s.last_run_id && (
                    <Button onClick={() => p.go('history', s.last_run_id)}>Last run</Button>
                  )}
                  <Button
                    aria-label={`Delete schedule ${s.name}`}
                    variant="icon"
                    onClick={async () => {
                      await api(`${p.base}/schedules/${s.id}`, undefined, 'DELETE');
                      loadSchedules();
                    }}
                  >
                    <Trash2 size={15} />
                  </Button>
                </div>
              ))
            ) : (
              <p className="muted">No recurring workflows scheduled yet.</p>
            )}
          </section>
          <section className="panel quality-card">
            <h3>Recent failures</h3>
            {data.failures.map((r: any) => (
              <div className="quality-row" key={r.id}>
                <span className="grow">{r.error}</span>
                <Button onClick={() => p.go('history', r.id)}>Inspect run</Button>
              </div>
            ))}
            {!data.failures.length && <p className="muted">No recorded failures.</p>}
          </section>
        </>
      )}
      {modal && (
        <Modal title="Schedule a workflow" onClose={() => setModal(false)}>
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              const f = new FormData(e.currentTarget);
              try {
                await api(`${p.base}/schedules`, {
                  name: f.get('name'),
                  workflowId: f.get('workflow'),
                  intervalMinutes: Number(f.get('interval')),
                  input: f.get('input'),
                  mode: f.get('mode'),
                });
                setModal(false);
                loadSchedules();
                p.notify('Workflow scheduled');
              } catch (error) {
                p.notify((error as Error).message, true);
              }
            }}
          >
            <Field label="Schedule name">
              <input name="name" required placeholder="Daily research briefing" />
            </Field>
            <Field label="Workflow">
              <Select name="workflow">
                {workflows?.map((w) => (
                  <option key={w.id} value={w.id}>
                    {w.name}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Repeat every (minutes)">
              <input
                name="interval"
                type="number"
                min="1"
                max="525600"
                defaultValue="1440"
                required
              />
            </Field>
            <Field label="Task input">
              <textarea name="input" rows={3} required />
            </Field>
            <Field label="Execution mode">
              <Select name="mode">
                <option value="preview">Development preview</option>
                <option value="live">Live</option>
              </Select>
            </Field>
            <p className="muted">
              Live schedules use provider quota and execute configured workflow actions each time.
            </p>
            <div className="modal-actions">
              <Button variant="primary">Save schedule</Button>
            </div>
          </form>
        </Modal>
      )}
    </>
  );
}
