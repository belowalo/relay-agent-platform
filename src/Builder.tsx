import { useState, useEffect, useCallback, useRef, memo } from 'react';
import {
  ReactFlow,
  ReactFlowProvider,
  Background,
  Controls,
  MiniMap,
  Handle,
  Position,
  addEdge,
  applyNodeChanges,
  applyEdgeChanges,
  useReactFlow,
  type Node,
  type Edge,
  type NodeChange,
  type EdgeChange,
  type Connection,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import {
  ArrowLeft,
  ChevronDown,
  Play,
  Square,
  Plus,
  Search,
  Undo2,
  Redo2,
  Download,
  Upload,
  History,
  Check,
  Cloud,
  Network,
  Bot,
  Zap,
  BookOpen,
  Plug,
  GitBranch,
  Repeat,
  Layers,
  ShieldCheck,
  Braces,
  ArrowRight,
  ArrowUpRight,
  MoreHorizontal,
  X,
  Copy,
  Trash2,
  Settings,
  Activity,
  Terminal,
  Maximize2,
  MousePointer2,
  Save,
  AlertTriangle,
} from 'lucide-react';
import { api, pretty, download, type PageProps } from './api';
import { Button, Modal, Field, Select, Badge, Loading, JsonField } from './ui';
import { useData } from './pages';
import { RunDetails } from './operations';
const kindIcons: Record<string, any> = {
  input: ArrowRight,
  output: Check,
  orchestrator: Network,
  agent: Bot,
  model: Zap,
  tool: Plug,
  knowledge: BookOpen,
  condition: GitBranch,
  loop: Repeat,
  parallel: Layers,
  join: Layers,
  approval: ShieldCheck,
  transform: Braces,
  subworkflow: WorkflowIcon,
};
function WorkflowIcon(props: any) {
  return <GitBranch {...props} />;
}
const AgentNode = memo(function AgentNode({ data, selected }: any) {
  const Icon = kindIcons[data.kind] || Bot;
  const config = data.config || {};
  return (
    <div className={`canvas-node ${data.kind} ${selected ? 'selected' : ''} ${data.status || ''}`}>
      <div className="node-top">
        <span className={`node-icon ${data.kind}`}>
          <Icon size={19} />
        </span>
        <span className="node-kind">
          {data.kind === 'agent' ? 'SPECIALIST' : data.kind.toUpperCase()}
        </span>
        {data.status && <span className={`node-status-dot ${data.status}`} />}
      </div>
      <strong className="node-name">{data.label}</strong>
      <p>
        {data.kind === 'orchestrator'
          ? 'Plan, delegate, and coordinate'
          : data.kind === 'agent'
            ? config.role || 'Focused expertise. Clear purpose.'
            : data.kind === 'input'
              ? 'Start with a task or payload'
              : data.kind === 'output'
                ? 'One consolidated outcome'
                : data.kind === 'tool'
                  ? config.kind || 'Connected integration'
                  : data.kind === 'knowledge'
                    ? 'Retrieve cited context'
                    : data.kind === 'approval'
                      ? 'Pause for a human decision'
                      : 'Configure this workflow step'}
      </p>
      {['agent', 'orchestrator', 'model'].includes(data.kind) && (
        <div className="node-footer">
          <Zap size={12} />
          <span>{config.model || data.modelName || 'Development preview'}</span>
          <span className="node-tools">{config.toolIds?.length || 0} tools</span>
        </div>
      )}
      {data.kind !== 'input' && <Handle type="target" position={Position.Left} />}{' '}
      {data.kind !== 'output' && <Handle type="source" position={Position.Right} />}
    </div>
  );
});
const nodeTypes = { relay: AgentNode };
type Graph = { nodes: Node[]; edges: Edge[]; settings?: Record<string, any> };
export default function Builder(p: PageProps & { workflowId: string }) {
  return (
    <ReactFlowProvider>
      <BuilderInner {...p} />
    </ReactFlowProvider>
  );
}
function BuilderInner(p: PageProps & { workflowId: string }) {
  const { data: workflow } = useData(`${p.base}/workflows/${p.workflowId}`, p.notify);
  const { data: catalog } = useData(`${p.base}/catalog`, p.notify);
  const { data: connections } = useData<any[]>(`${p.base}/connections`, p.notify);
  const { data: tools } = useData<any[]>(`${p.base}/tools`, p.notify);
  const { data: collections } = useData<any[]>(`${p.base}/collections`, p.notify);
  const { data: prompts } = useData<any[]>(`${p.base}/prompts`, p.notify);
  const { data: agents } = useData<any[]>(`${p.base}/agents`, p.notify);
  const { data: workflows } = useData<any[]>(`${p.base}/workflows`, p.notify);
  const { data: projects } = useData<any[]>(`${p.base}/projects`, p.notify);
  const [nodes, setNodes] = useState<Node[]>([]),
    [edges, setEdges] = useState<Edge[]>([]),
    [settings, setSettings] = useState<Record<string, any>>({
      concurrency: 4,
      maxTokens: 50000,
      timeoutMs: 600000,
    }),
    [name, setName] = useState(''),
    [description, setDescription] = useState(''),
    [projectId, setProjectId] = useState(''),
    [selected, setSelected] = useState(''),
    [selectedEdge, setSelectedEdge] = useState(''),
    [library, setLibrary] = useState(true),
    [query, setQuery] = useState(''),
    [saveState, setSaveState] = useState('Saved'),
    [versions, setVersions] = useState<any[] | null>(null),
    [showSettings, setShowSettings] = useState(false),
    [showRun, setShowRun] = useState(false),
    [mode, setMode] = useState('preview'),
    [task, setTask] = useState(''),
    [taskFormat, setTaskFormat] = useState('text'),
    [runId, setRunId] = useState(''),
    [run, setRun] = useState<any>(null),
    [drawer, setDrawer] = useState(false),
    [validation, setValidation] = useState<string[] | null>(null),
    [inspectorTab, setInspectorTab] = useState('configure');
  const flow = useReactFlow(),
    revision = useRef(1),
    dirty = useRef(false),
    initialized = useRef(false),
    saveLock = useRef(false),
    editCounter = useRef(0),
    past = useRef<Graph[]>([]),
    future = useRef<Graph[]>([]),
    clipboard = useRef<Graph | null>(null),
    importRef = useRef<HTMLInputElement>(null);
  const graphRef = useRef<Graph>({ nodes, edges, settings }),
    nameRef = useRef(name),
    metaRef = useRef({ description, projectId });
  graphRef.current = { nodes, edges, settings };
  nameRef.current = name;
  metaRef.current = { description, projectId };
  const editable = p.role !== 'viewer';
  useEffect(() => {
    if (workflow && !initialized.current) {
      setNodes(workflow.graph.nodes);
      setEdges(workflow.graph.edges);
      setName(workflow.name);
      setDescription(workflow.description);
      setProjectId(workflow.project_id || '');
      setSettings(
        workflow.graph.settings || { concurrency: 4, maxTokens: 50000, timeoutMs: 600000 },
      );
      revision.current = workflow.revision;
      initialized.current = true;
      setTimeout(() => flow.fitView({ padding: 0.18 }), 120);
    }
  }, [workflow, flow]);
  function cleanGraph(g: Graph) {
    return {
      ...g,
      nodes: g.nodes.map(({ selected, dragging, measured, ...n }) => ({
        ...n,
        data: { ...n.data, status: undefined, modelName: undefined },
      })),
    };
  }
  const markDirty = useCallback(() => {
    if (!editable) return;
    dirty.current = true;
    editCounter.current++;
    setSaveState('Unsaved changes');
  }, [editable]);
  const remember = useCallback(() => {
    past.current.push(structuredClone(graphRef.current));
    if (past.current.length > 60) past.current.shift();
    future.current = [];
  }, []);
  const save = useCallback(async () => {
    if (saveLock.current || !initialized.current || !dirty.current || !editable) return;
    saveLock.current = true;
    setSaveState('Saving…');
    const counter = editCounter.current;
    try {
      const r = await api(
        `${p.base}/workflows/${p.workflowId}`,
        {
          name: nameRef.current,
          ...metaRef.current,
          graph: cleanGraph(graphRef.current),
          revision: revision.current,
        },
        'PUT',
      );
      revision.current = r.revision;
      dirty.current = editCounter.current !== counter;
      setSaveState(dirty.current ? 'Unsaved changes' : 'Saved');
    } catch (e) {
      setSaveState('Save failed');
      p.notify((e as Error).message, true);
    } finally {
      saveLock.current = false;
    }
  }, [p.base, p.workflowId, p.notify, editable]);
  useEffect(() => {
    const timer = setInterval(() => {
      if (dirty.current && saveState !== 'Save failed') void save();
    }, 2500);
    return () => clearInterval(timer);
  }, [save, saveState]);
  useEffect(() => {
    const warn = (e: BeforeUnloadEvent) => {
      if (dirty.current) {
        e.preventDefault();
        e.returnValue = '';
      }
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, []);
  function undo() {
    if (!editable || !past.current.length) return;
    future.current.push(structuredClone(graphRef.current));
    const g = past.current.pop()!;
    setNodes(g.nodes);
    setEdges(g.edges);
    setSettings(g.settings || {});
    markDirty();
  }
  function redo() {
    if (!editable || !future.current.length) return;
    past.current.push(structuredClone(graphRef.current));
    const g = future.current.pop()!;
    setNodes(g.nodes);
    setEdges(g.edges);
    setSettings(g.settings || {});
    markDirty();
  }
  function copy() {
    const ids = new Set(nodes.filter((n) => n.selected).map((n) => n.id));
    if (!ids.size && selected) ids.add(selected);
    clipboard.current = {
      nodes: nodes.filter((n) => ids.has(n.id)),
      edges: edges.filter((e) => ids.has(e.source) && ids.has(e.target)),
    };
  }
  function paste() {
    if (!editable || !clipboard.current?.nodes.length) return;
    remember();
    const map = new Map(clipboard.current.nodes.map((n) => [n.id, crypto.randomUUID()]));
    const copied = clipboard.current.nodes.map((n) => ({
      ...structuredClone(n),
      id: map.get(n.id)!,
      selected: true,
      position: { x: n.position.x + 60, y: n.position.y + 70 },
    }));
    setNodes((old) => [...old.map((n) => ({ ...n, selected: false })), ...copied]);
    setEdges((old) => [
      ...old,
      ...clipboard.current!.edges.map((e) => ({
        ...e,
        id: crypto.randomUUID(),
        source: map.get(e.source)!,
        target: map.get(e.target)!,
      })),
    ]);
    markDirty();
  }
  function duplicate() {
    copy();
    paste();
  }
  function addNode(kind: string, position?: { x: number; y: number }, agent?: any) {
    if (!editable) return;
    remember();
    const id = crypto.randomUUID(),
      item = catalog.nodes.find((n: any) => n.kind === kind);
    const config = agent
      ? { ...agent.config, agentId: agent.id }
      : ['agent', 'orchestrator', 'model'].includes(kind)
        ? { instructions: '', memory: 'none', temperature: 0.4, maxTokens: 2048, maxSteps: 5 }
        : kind === 'condition'
          ? { operator: 'contains', value: '', path: '' }
          : kind === 'loop'
            ? { maxIterations: 3, result: 'last' }
            : {};
    setNodes((old) => [
      ...old.map((n) => ({ ...n, selected: false })),
      {
        id,
        type: 'relay',
        position:
          position || flow.screenToFlowPosition({ x: innerWidth * 0.52, y: innerHeight * 0.48 }),
        data: { kind, label: agent?.name || item?.name || kind, config },
        selected: true,
      },
    ]);
    setSelected(id);
    markDirty();
  }
  const onNodesChange = useCallback(
    (changes: NodeChange[]) => {
      if (!editable) {
        setNodes((n) =>
          applyNodeChanges(
            changes.filter((c) => c.type === 'select' || c.type === 'dimensions'),
            n,
          ),
        );
        return;
      }
      const edit = changes.some((c) => ['remove', 'add', 'replace'].includes(c.type));
      if (edit) remember();
      setNodes((n) => applyNodeChanges(changes, n));
      if (edit) markDirty();
    },
    [editable, remember, markDirty],
  );
  const onEdgesChange = useCallback(
    (changes: EdgeChange[]) => {
      if (!editable) return;
      if (changes.some((c) => c.type !== 'select')) {
        remember();
        markDirty();
      }
      setEdges((e) => applyEdgeChanges(changes, e));
    },
    [editable, remember, markDirty],
  );
  const onConnect = useCallback(
    (connection: Connection) => {
      if (!editable) return;
      remember();
      setEdges((es) => addEdge({ ...connection, id: crypto.randomUUID(), data: {} }, es));
      markDirty();
    },
    [editable, remember, markDirty],
  );
  function updateConfig(key: string, value: any) {
    if (!editable) return;
    remember();
    setNodes((old) =>
      old.map((n) =>
        n.id === selected
          ? { ...n, data: { ...n.data, config: { ...(n.data.config as any), [key]: value } } }
          : n,
      ),
    );
    markDirty();
  }
  async function startRun() {
    try {
      await save();
      if (dirty.current) throw new Error('Save the workflow successfully before running');
      const r = await api(`${p.base}/workflows/${p.workflowId}/runs`, {
        input: taskFormat === 'json' ? JSON.parse(task) : task,
        mode,
        conversationId: `workflow-${p.workflowId}`,
      });
      setRunId(r.id);
      setRun(null);
      setShowRun(false);
      setDrawer(false);
      setInspectorTab('activity');
      p.notify(mode === 'preview' ? 'Development preview started' : 'Live execution started');
    } catch (e) {
      p.notify((e as Error).message, true);
    }
  }
  useEffect(() => {
    if (!runId) return;
    const s = new EventSource(`${p.base}/runs/${runId}/events`);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const refresh = () =>
      api(`${p.base}/runs/${runId}`)
        .then(setRun)
        .catch((e) => p.notify(e.message, true));
    refresh();
    s.onmessage = () => {
      if (!timer)
        timer = setTimeout(() => {
          refresh();
          timer = undefined;
        }, 120);
    };
    s.onerror = () => s.close();
    return () => {
      s.close();
      if (timer) clearTimeout(timer);
    };
  }, [runId, p.base, p.notify]);
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      const editingText = ['INPUT', 'TEXTAREA', 'SELECT'].includes(
        (e.target as HTMLElement).tagName,
      );
      const command = e.ctrlKey || e.metaKey;
      if (command && e.key === 's') {
        e.preventDefault();
        void save();
      }
      if (command && e.key === 'Enter') {
        e.preventDefault();
        setShowRun(true);
      }
      if (editingText) return;
      if (command && e.key === 'z') {
        e.preventDefault();
        e.shiftKey ? redo() : undo();
      }
      if (command && e.key === 'y') {
        e.preventDefault();
        redo();
      }
      if (command && e.key === 'c') {
        e.preventDefault();
        copy();
      }
      if (command && e.key === 'v') {
        e.preventDefault();
        paste();
      }
      if (command && e.key === 'd') {
        e.preventDefault();
        duplicate();
      }
      if (e.key.toLowerCase() === 'f' && !command) {
        e.preventDefault();
        flow.fitView({ padding: 0.18, duration: 300 });
      }
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  });
  const node = nodes.find((n) => n.id === selected),
    config = (node?.data.config as any) || {},
    kind = String(node?.data.kind || ''),
    edge = edges.find((e) => e.id === selectedEdge),
    activeStep = run?.steps.find((s: any) => s.node_id === selected);
  const liveNodes = nodes.map((n) => ({
    ...n,
    data: {
      ...n.data,
      status: run?.steps.find((s: any) => s.node_id === n.id)?.status,
      modelName: connections?.find((c) => c.id === (n.data.config as any)?.connectionId)?.model,
    },
  }));
  const liveEdges = edges.map((e) => {
    const source = run?.steps.find((s: any) => s.node_id === e.source),
      target = run?.steps.find((s: any) => s.node_id === e.target);
    const running = source?.status === 'completed' && target?.status === 'running';
    return {
      ...e,
      animated: running,
      style: {
        stroke: running ? '#b3f576' : source?.status === 'completed' ? '#64814d' : 'var(--edge)',
        strokeWidth: running ? 2.5 : 1.6,
      },
      type: 'smoothstep',
    };
  });
  if (!workflow || !catalog) return <Loading />;
  return (
    <div className="builder">
      <div className="builder-toolbar">
        <div className="builder-title">
          <Button
            variant="icon"
            title="Back to workflows"
            onClick={async () => {
              await save();
              if (dirty.current) {
                p.notify('Save failed. Resolve the error before leaving.', true);
                return;
              }
              p.go('workflows');
            }}
          >
            <ArrowLeft size={18} />
          </Button>
          <span className="workflow-logo">
            <Network size={20} />
          </span>
          <div>
            <input
              aria-label="Workflow name"
              disabled={!editable}
              value={name}
              onChange={(e) => {
                setName(e.target.value);
                markDirty();
              }}
            />
            <span>
              <span className={`save-indicator ${saveState === 'Saved' ? 'saved' : ''}`} />
              {saveState} · v{revision.current}
            </span>
          </div>
          <Badge status="draft">Draft</Badge>
        </div>
        <div className="builder-actions">
          <Button variant="icon" title="Undo (Ctrl Z)" onClick={undo} disabled={!editable}>
            <Undo2 size={17} />
          </Button>
          <Button variant="icon" title="Redo (Ctrl Shift Z)" onClick={redo} disabled={!editable}>
            <Redo2 size={17} />
          </Button>
          <span className="toolbar-divider" />
          <Button
            variant="ghost"
            title="Validate workflow"
            onClick={async () => {
              const r = await api(`${p.base}/validate`, { graph: cleanGraph(graphRef.current) });
              setValidation(r.errors);
            }}
          >
            <Check size={15} />
            Validate
          </Button>
          <Button
            variant="icon"
            title="Version history"
            onClick={async () =>
              setVersions(await api(`${p.base}/workflows/${p.workflowId}/versions`))
            }
          >
            <History size={17} />
          </Button>
          <Button variant="icon" title="Workflow settings" onClick={() => setShowSettings(true)}>
            <Settings size={17} />
          </Button>
          <Button
            variant="icon"
            title="Export workflow"
            onClick={() =>
              download(`${name}.json`, { name, description, graph: cleanGraph(graphRef.current) })
            }
          >
            <Download size={17} />
          </Button>
          <Button
            variant="icon"
            title="Import workflow"
            disabled={!editable}
            onClick={() => importRef.current?.click()}
          >
            <Upload size={17} />
          </Button>
          <Button onClick={save} disabled={!editable}>
            <Save size={15} />
            Save
          </Button>
          {['running', 'queued', 'waiting'].includes(run?.status) ? (
            <Button
              variant="danger"
              disabled={!editable}
              onClick={() =>
                api(`${p.base}/runs/${runId}/cancel`, {}).catch((e) => p.notify(e.message, true))
              }
            >
              <Square size={14} />
              Cancel now
            </Button>
          ) : (
            <Button variant="primary" disabled={!editable} onClick={() => setShowRun(true)}>
              <Play size={15} fill="currentColor" />
              Run workflow
            </Button>
          )}
        </div>
      </div>
      <input
        hidden
        type="file"
        accept=".json"
        ref={importRef}
        onChange={async (e) => {
          try {
            const file = e.target.files?.[0];
            if (!file) return;
            const imported = JSON.parse(await file.text());
            const g = imported.graph || imported;
            if (!Array.isArray(g.nodes) || !Array.isArray(g.edges))
              throw new Error('Select a Relay workflow JSON file');
            remember();
            setNodes(g.nodes);
            setEdges(g.edges);
            setSettings(g.settings || {});
            if (imported.name) setName(imported.name);
            markDirty();
            p.notify('Workflow imported into this draft');
            setTimeout(() => flow.fitView(), 100);
          } catch (e) {
            p.notify((e as Error).message, true);
          }
          e.target.value = '';
        }}
      />
      <div className="builder-body">
        {library && (
          <aside className="component-library">
            <div className="library-heading">
              <h3>Components</h3>
              <Button
                variant="icon"
                title="Hide component library"
                onClick={() => setLibrary(false)}
              >
                <X size={16} />
              </Button>
            </div>
            <p>Drag into the canvas or click to add.</p>
            <div className="search-input">
              <Search size={15} />
              <input
                aria-label="Search components"
                placeholder="Find a component…"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
            </div>
            {[...new Set<string>(catalog.nodes.map((n: any) => n.group))].map((group) => (
              <section className="component-group" key={group}>
                <span>{group}</span>
                {catalog.nodes
                  .filter(
                    (n: any) =>
                      n.group === group &&
                      (n.name + ' ' + n.description).toLowerCase().includes(query.toLowerCase()),
                  )
                  .map((n: any) => {
                    const Icon = kindIcons[n.kind] || Bot;
                    return (
                      <button
                        className="component-item"
                        key={n.kind}
                        draggable={editable}
                        onDragStart={(e) =>
                          e.dataTransfer.setData('application/relay-node', n.kind)
                        }
                        disabled={!editable}
                        onClick={() => addNode(n.kind)}
                        title={n.description}
                      >
                        <span className={`component-icon ${n.kind}`}>
                          <Icon size={16} />
                        </span>
                        {n.name}
                        <Plus size={13} />
                      </button>
                    );
                  })}
              </section>
            ))}
            {!!agents?.length && (
              <section className="component-group">
                <span>Your saved agents</span>
                {agents
                  ?.filter((a) => a.name.toLowerCase().includes(query.toLowerCase()))
                  .map((a) => (
                    <button
                      className="component-item"
                      key={a.id}
                      onClick={() => addNode('agent', undefined, a)}
                      disabled={!editable}
                    >
                      <span className="component-icon agent">
                        <Bot size={16} />
                      </span>
                      {a.name}
                      <Plus size={13} />
                    </button>
                  ))}
              </section>
            )}
            <div className="library-footer">
              <MousePointer2 size={15} />
              <span>
                Shift + drag to select
                <br />
                Ctrl / ⌘ D to duplicate
              </span>
            </div>
          </aside>
        )}
        <div
          className="canvas-wrap"
          onDragOver={(e) => {
            e.preventDefault();
            e.dataTransfer.dropEffect = 'move';
          }}
          onDrop={(e) => {
            e.preventDefault();
            const kind = e.dataTransfer.getData('application/relay-node');
            if (kind && catalog.nodes.some((n: any) => n.kind === kind))
              addNode(kind, flow.screenToFlowPosition({ x: e.clientX, y: e.clientY }));
          }}
        >
          {!library && (
            <Button className="show-library" onClick={() => setLibrary(true)}>
              <Plus size={15} />
              Components
            </Button>
          )}
          <div className="canvas-caption">
            <span className="canvas-label">
              <Network size={15} />
              AGENT WORKFLOW
            </span>
            <span>
              {nodes.length} components · {edges.length} connections
            </span>
          </div>
          <ReactFlow
            nodes={liveNodes}
            edges={liveEdges}
            nodeTypes={nodeTypes}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onConnect={onConnect}
            onNodeClick={(_, n) => {
              setSelected(n.id);
              setSelectedEdge('');
              void flow.setCenter(n.position.x + 117, n.position.y + 80, {
                zoom: Math.max(flow.getZoom(), 0.8),
                duration: 180,
              });
            }}
            onEdgeClick={(_, e) => {
              setSelectedEdge(e.id);
              setSelected('');
            }}
            onPaneClick={() => {
              setSelected('');
              setSelectedEdge('');
            }}
            onNodeDragStart={remember}
            onNodeDragStop={markDirty}
            fitView
            fitViewOptions={{ padding: 0.18 }}
            minZoom={0.2}
            maxZoom={1.8}
            nodesDraggable={editable}
            nodesConnectable={editable}
            deleteKeyCode={editable ? ['Backspace', 'Delete'] : null}
            selectionOnDrag={false}
            panOnDrag={[0, 1, 2]}
            colorMode={document.documentElement.dataset.theme === 'light' ? 'light' : 'dark'}
            proOptions={{ hideAttribution: true }}
          >
            <Background gap={24} size={1} color="var(--dot)" />
            <Controls showInteractive={false} />
            <MiniMap
              pannable
              zoomable
              nodeColor={(n) => (n.data.kind === 'orchestrator' ? '#acd77c' : '#687281')}
              maskColor="var(--minimap-mask)"
            />
          </ReactFlow>
          <div className="canvas-bottom">
            <span>
              <span className="status-dot" />{' '}
              {run
                ? run.status === 'completed'
                  ? 'Run complete'
                  : `Run ${run.status}`
                : 'Ready when you are'}
            </span>
            <span>
              {run?.mode === 'live' ? 'Live model connections' : 'Development preview available'}
            </span>
            {run && (
              <Button variant="ghost" onClick={() => setDrawer(true)}>
                Inspect run
                <ArrowUpRight size={14} />
              </Button>
            )}
          </div>
        </div>
        {(node || edge) && (
          <aside className="node-inspector">
            <div className="inspector-heading">
              <span className="eyebrow">{node ? 'COMPONENT SETTINGS' : 'CONNECTION'}</span>
              <Button
                variant="icon"
                title="Close inspector"
                onClick={() => {
                  setSelected('');
                  setSelectedEdge('');
                }}
              >
                <X size={16} />
              </Button>
            </div>
            {node ? (
              <>
                <h3>{String(node.data.label)}</h3>
                <div className="tabs">
                  <button
                    className={inspectorTab === 'configure' ? 'active' : ''}
                    onClick={() => setInspectorTab('configure')}
                  >
                    Configure
                  </button>
                  <button
                    className={inspectorTab === 'activity' ? 'active' : ''}
                    onClick={() => setInspectorTab('activity')}
                  >
                    Activity{activeStep && <span className="tab-dot" />}
                  </button>
                </div>
                {inspectorTab === 'configure' ? (
                  <div className="inspector-fields">
                    <Field label="Name">
                      <input
                        disabled={!editable}
                        value={String(node.data.label)}
                        onChange={(e) => {
                          remember();
                          setNodes((ns) =>
                            ns.map((n) =>
                              n.id === node.id
                                ? { ...n, data: { ...n.data, label: e.target.value } }
                                : n,
                            ),
                          );
                          markDirty();
                        }}
                      />
                    </Field>
                    {['agent', 'orchestrator', 'model'].includes(kind) && (
                      <>
                        <Field label="Role">
                          <input
                            value={config.role || ''}
                            disabled={!editable}
                            placeholder={kind === 'orchestrator' ? 'Team lead' : 'Specialist'}
                            onChange={(e) => updateConfig('role', e.target.value)}
                          />
                        </Field>
                        <Field label="Description">
                          <input
                            value={config.description || ''}
                            disabled={!editable}
                            placeholder="What this agent brings to the team"
                            onChange={(e) => updateConfig('description', e.target.value)}
                          />
                        </Field>
                        <Field
                          label="Use a saved prompt"
                          hint="Copies this revision into the agent instructions."
                        >
                          <Select
                            disabled={!editable}
                            value=""
                            onChange={(e) => {
                              const prompt = prompts?.find((v) => v.id === e.target.value);
                              if (prompt) updateConfig('instructions', prompt.content);
                            }}
                          >
                            <option value="">Choose a prompt revision</option>
                            {prompts?.map((prompt) => (
                              <option key={prompt.id} value={prompt.id}>
                                {prompt.name} · v{prompt.revision}
                              </option>
                            ))}
                          </Select>
                        </Field>
                        <Field label="Instructions">
                          <textarea
                            rows={6}
                            disabled={!editable}
                            placeholder="Give this agent a clear purpose…"
                            value={config.instructions || ''}
                            onChange={(e) => updateConfig('instructions', e.target.value)}
                          />
                        </Field>
                        <Field label="Model connection">
                          <Select
                            disabled={!editable}
                            value={config.connectionId || ''}
                            onChange={(e) => updateConfig('connectionId', e.target.value)}
                          >
                            <option value="">Choose a connection for live runs</option>
                            {connections
                              ?.filter((c) => c.provider !== 'credential')
                              .map((c) => (
                                <option key={c.id} value={c.id}>
                                  {c.name} · {c.model}
                                </option>
                              ))}
                          </Select>
                        </Field>
                        <small className="inspector-note">
                          Development preview runs without a model. Live runs use this connection.
                        </small>
                        <Field label="Model override">
                          <input
                            disabled={!editable}
                            value={config.model || ''}
                            onChange={(e) => updateConfig('model', e.target.value)}
                            placeholder="Use connection’s default model"
                          />
                        </Field>
                        <div className="form-grid">
                          <Field label="Temperature">
                            <input
                              type="number"
                              min="0"
                              max="2"
                              step="0.1"
                              disabled={!editable}
                              value={config.temperature ?? 0.4}
                              onChange={(e) => updateConfig('temperature', Number(e.target.value))}
                            />
                          </Field>
                          <Field label="Max output tokens">
                            <input
                              type="number"
                              min="16"
                              max="32000"
                              disabled={!editable}
                              value={config.maxTokens || 2048}
                              onChange={(e) => updateConfig('maxTokens', Number(e.target.value))}
                            />
                          </Field>
                        </div>
                        {kind !== 'model' && (
                          <>
                            <div className="assignment-list">
                              <span className="field-label">Assigned tools</span>
                              {tools?.length ? (
                                tools.map((t) => (
                                  <label className="checkbox" key={t.id}>
                                    <input
                                      type="checkbox"
                                      disabled={!editable}
                                      checked={config.toolIds?.includes(t.id) || false}
                                      onChange={(e) =>
                                        updateConfig(
                                          'toolIds',
                                          e.target.checked
                                            ? [...(config.toolIds || []), t.id]
                                            : (config.toolIds || []).filter(
                                                (x: string) => x !== t.id,
                                              ),
                                        )
                                      }
                                    />
                                    {t.name}
                                  </label>
                                ))
                              ) : (
                                <button
                                  className="resource-link"
                                  onClick={() => {
                                    void save().then(() => p.go('tools'));
                                  }}
                                >
                                  Configure a tool
                                  <ArrowUpRight size={13} />
                                </button>
                              )}
                            </div>
                            <div className="assignment-list">
                              <span className="field-label">Knowledge collections</span>
                              {collections?.length ? (
                                collections.map((c) => (
                                  <label className="checkbox" key={c.id}>
                                    <input
                                      type="checkbox"
                                      disabled={!editable}
                                      checked={config.knowledgeIds?.includes(c.id) || false}
                                      onChange={(e) =>
                                        updateConfig(
                                          'knowledgeIds',
                                          e.target.checked
                                            ? [...(config.knowledgeIds || []), c.id]
                                            : (config.knowledgeIds || []).filter(
                                                (x: string) => x !== c.id,
                                              ),
                                        )
                                      }
                                    />
                                    {c.name}
                                  </label>
                                ))
                              ) : (
                                <span className="muted">No collections yet</span>
                              )}
                            </div>
                            <Field label="Memory">
                              <Select
                                disabled={!editable}
                                value={config.memory || 'none'}
                                onChange={(e) => updateConfig('memory', e.target.value)}
                              >
                                <option value="none">No memory</option>
                                <option value="conversation">Conversation memory</option>
                                <option value="persistent">Persistent agent memory</option>
                              </Select>
                            </Field>
                          </>
                        )}
                        <details>
                          <summary>Structured output</summary>
                          <JsonField
                            key={`${node.id}-schema`}
                            label="JSON output schema"
                            value={config.outputSchema || {}}
                            onChange={(v) =>
                              updateConfig('outputSchema', Object.keys(v).length ? v : undefined)
                            }
                            hint="Validated on live model outputs. Empty schema means plain text."
                          />
                        </details>
                      </>
                    )}
                    {kind === 'knowledge' && (
                      <>
                        <Field label="Knowledge collection">
                          <Select
                            disabled={!editable}
                            value={config.collectionId || ''}
                            onChange={(e) => updateConfig('collectionId', e.target.value)}
                          >
                            <option value="">Select collection</option>
                            {collections?.map((c) => (
                              <option key={c.id} value={c.id}>
                                {c.name}
                              </option>
                            ))}
                          </Select>
                        </Field>
                        <Field label="Passages to retrieve">
                          <input
                            type="number"
                            min="1"
                            max="20"
                            value={config.topK || 4}
                            onChange={(e) => updateConfig('topK', Number(e.target.value))}
                          />
                        </Field>
                      </>
                    )}
                    {kind === 'tool' && (
                      <>
                        <Field label="Configured integration">
                          <Select
                            disabled={!editable}
                            value={config.toolId || ''}
                            onChange={(e) => updateConfig('toolId', e.target.value)}
                          >
                            <option value="">
                              {config.kind ? 'Built-in ' + config.kind : 'Choose a configured tool'}
                            </option>
                            {tools?.map((t) => (
                              <option key={t.id} value={t.id}>
                                {t.name}
                              </option>
                            ))}
                          </Select>
                        </Field>
                        {!config.toolId && config.kind && (
                          <>
                            <Field label="URL">
                              <input
                                value={config.url || ''}
                                onChange={(e) => updateConfig('url', e.target.value)}
                              />
                            </Field>
                            <Field label="Method">
                              <Select
                                value={config.method || 'GET'}
                                onChange={(e) => updateConfig('method', e.target.value)}
                              >
                                {['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].map((m) => (
                                  <option key={m}>{m}</option>
                                ))}
                              </Select>
                            </Field>
                          </>
                        )}
                      </>
                    )}
                    {kind === 'condition' && (
                      <>
                        <Field label="Input field path">
                          <input
                            value={config.path || ''}
                            onChange={(e) => updateConfig('path', e.target.value)}
                            placeholder="status or results.score"
                          />
                        </Field>
                        <Field label="Comparison">
                          <Select
                            value={config.operator || 'truthy'}
                            onChange={(e) => updateConfig('operator', e.target.value)}
                          >
                            {['truthy', 'equals', 'contains', 'gt', 'exists'].map((v) => (
                              <option key={v}>{v}</option>
                            ))}
                          </Select>
                        </Field>
                        <Field label="Compare with">
                          <input
                            value={config.value ?? ''}
                            onChange={(e) => updateConfig('value', e.target.value)}
                          />
                        </Field>
                        <div className="inspector-note">
                          Select each outgoing connection and choose its true or false branch.
                        </div>
                      </>
                    )}
                    {kind === 'approval' && (
                      <Field label="Approval prompt">
                        <textarea
                          value={config.prompt || ''}
                          rows={3}
                          onChange={(e) => updateConfig('prompt', e.target.value)}
                          placeholder="What should the reviewer check?"
                        />
                      </Field>
                    )}
                    {['loop', 'subworkflow'].includes(kind) && (
                      <>
                        <Field label="Reusable workflow">
                          <Select
                            disabled={!editable}
                            value={config.workflowId || ''}
                            onChange={(e) => updateConfig('workflowId', e.target.value)}
                          >
                            <option value="">Select workflow</option>
                            {workflows
                              ?.filter((w) => w.id !== p.workflowId)
                              .map((w) => (
                                <option key={w.id} value={w.id}>
                                  {w.name}
                                </option>
                              ))}
                          </Select>
                        </Field>
                        {kind === 'loop' && (
                          <>
                            <Field label="Maximum iterations">
                              <input
                                type="number"
                                min="1"
                                max="20"
                                value={config.maxIterations || 3}
                                onChange={(e) =>
                                  updateConfig('maxIterations', Number(e.target.value))
                                }
                              />
                            </Field>
                            <Field label="Item array path (optional)">
                              <input
                                value={config.itemsPath || ''}
                                placeholder="items"
                                onChange={(e) => updateConfig('itemsPath', e.target.value)}
                              />
                            </Field>
                            <Field label="Stop when output field is true">
                              <input
                                value={config.stopPath || ''}
                                onChange={(e) => updateConfig('stopPath', e.target.value)}
                                placeholder="approved"
                              />
                            </Field>
                            <Field label="Return">
                              <Select
                                value={config.result || 'last'}
                                onChange={(e) => updateConfig('result', e.target.value)}
                              >
                                <option value="last">Last iteration</option>
                                <option value="all">All iterations</option>
                              </Select>
                            </Field>
                          </>
                        )}
                      </>
                    )}
                    {kind === 'transform' && (
                      <>
                        <Field label="Select a field path">
                          <input
                            value={config.path || ''}
                            onChange={(e) => updateConfig('path', e.target.value)}
                            placeholder="data.result"
                          />
                        </Field>
                        <Field label="Text template">
                          <textarea
                            rows={3}
                            value={config.template || ''}
                            onChange={(e) => updateConfig('template', e.target.value)}
                            placeholder="Result: {{data.result}}"
                          />
                        </Field>
                        <JsonField
                          key={`${node.id}-mapping`}
                          label="Field mapping"
                          value={config.mapping || {}}
                          onChange={(v) =>
                            updateConfig('mapping', Object.keys(v).length ? v : undefined)
                          }
                          hint={'Map output keys to incoming field paths: {"title":"data.name"}'}
                        />
                      </>
                    )}
                    {!['input', 'output'].includes(kind) && (
                      <details>
                        <summary>Execution limits & recovery</summary>
                        <div className="form-grid">
                          <Field label="Timeout (seconds)">
                            <input
                              type="number"
                              min="1"
                              max="600"
                              value={(config.timeoutMs || 60000) / 1000}
                              onChange={(e) =>
                                updateConfig('timeoutMs', Number(e.target.value) * 1000)
                              }
                            />
                          </Field>
                          <Field label="Retries">
                            <input
                              type="number"
                              min="0"
                              max="3"
                              value={config.retries || 0}
                              onChange={(e) => updateConfig('retries', Number(e.target.value))}
                            />
                          </Field>
                        </div>
                        {['agent', 'orchestrator'].includes(kind) && (
                          <Field label="Maximum model/tool rounds">
                            <input
                              type="number"
                              min="1"
                              max="12"
                              value={config.maxSteps || 5}
                              onChange={(e) => updateConfig('maxSteps', Number(e.target.value))}
                            />
                          </Field>
                        )}
                        <label className="checkbox">
                          <input
                            type="checkbox"
                            checked={!!config.continueOnError}
                            onChange={(e) => updateConfig('continueOnError', e.target.checked)}
                          />
                          Continue when another incoming branch fails
                        </label>
                      </details>
                    )}
                    <div className="inspector-node-actions">
                      <Button onClick={duplicate} disabled={!editable}>
                        <Copy size={14} />
                        Duplicate
                      </Button>
                      <Button
                        variant="danger"
                        disabled={!editable}
                        onClick={() => {
                          remember();
                          setNodes((ns) => ns.filter((n) => n.id !== selected));
                          setEdges((es) =>
                            es.filter((e) => e.source !== selected && e.target !== selected),
                          );
                          setSelected('');
                          markDirty();
                        }}
                      >
                        <Trash2 size={14} />
                        Delete
                      </Button>
                    </div>
                  </div>
                ) : (
                  <div className="inspector-activity">
                    {activeStep ? (
                      <>
                        <Badge status={activeStep.status} />
                        {activeStep.status === 'waiting' && (
                          <div className="approval-panel">
                            <p>{config.prompt || 'Review this checkpoint'}</p>
                            <Button
                              variant="primary"
                              disabled={!editable}
                              onClick={() =>
                                api(`${p.base}/runs/${runId}/approve`, {
                                  nodeId: selected,
                                  approved: true,
                                })
                              }
                            >
                              <Check size={14} />
                              Approve & continue
                            </Button>
                            <Button
                              variant="danger"
                              disabled={!editable}
                              onClick={() =>
                                api(`${p.base}/runs/${runId}/approve`, {
                                  nodeId: selected,
                                  approved: false,
                                })
                              }
                            >
                              Reject
                            </Button>
                          </div>
                        )}
                        <h4>Input</h4>
                        <pre>{pretty(activeStep.input)}</pre>
                        <h4>Output</h4>
                        <pre>
                          {pretty(
                            activeStep.output ??
                              (run.events
                                .filter(
                                  (e: any) => e.node_id === selected && e.type === 'model.token',
                                )
                                .map((e: any) => e.data.token)
                                .join('') ||
                                'No output recorded yet.'),
                          )}
                        </pre>
                        {activeStep.error && <div className="error-banner">{activeStep.error}</div>}
                        <h4>Messages & tool activity</h4>
                        {run.events
                          .filter(
                            (e: any) => e.node_id === selected && !e.type.startsWith('model.token'),
                          )
                          .map((e: any) => (
                            <article key={e.id}>
                              <span className="eyebrow">{e.type}</span>
                              <pre>{pretty(e.data)}</pre>
                            </article>
                          ))}
                        <Button onClick={() => setDrawer(true)}>
                          Open full run
                          <ArrowUpRight size={14} />
                        </Button>
                      </>
                    ) : (
                      <div className="empty compact">
                        <Activity size={25} />
                        <h3>No activity yet</h3>
                        <p>
                          Run the workflow to inspect this step’s inputs, outputs, messages, and
                          tools.
                        </p>
                      </div>
                    )}
                  </div>
                )}
              </>
            ) : (
              <>
                <h3>Connection settings</h3>
                <div className="inspector-fields">
                  <p className="muted">
                    {String(nodes.find((n) => n.id === edge?.source)?.data.label)} →{' '}
                    {String(nodes.find((n) => n.id === edge?.target)?.data.label)}
                  </p>
                  <Field label="Branch / connection label">
                    <Select
                      value={String(edge?.data?.branch || edge?.label || '')}
                      onChange={(e) => {
                        remember();
                        setEdges((es) =>
                          es.map((x) =>
                            x.id === selectedEdge
                              ? {
                                  ...x,
                                  label: e.target.value,
                                  data: { ...x.data, branch: e.target.value },
                                }
                              : x,
                          ),
                        );
                        markDirty();
                      }}
                      disabled={!editable}
                    >
                      <option value="">Dependency (always)</option>
                      <option value="true">True branch</option>
                      <option value="false">False branch</option>
                    </Select>
                  </Field>
                  <div className="info-banner">
                    <GitBranch size={18} />
                    <p>
                      This connection controls execution and carries the source result to its
                      target.
                    </p>
                  </div>
                  <Button
                    variant="danger"
                    disabled={!editable}
                    onClick={() => {
                      remember();
                      setEdges((es) => es.filter((e) => e.id !== selectedEdge));
                      setSelectedEdge('');
                      markDirty();
                    }}
                  >
                    <Trash2 size={14} />
                    Remove connection
                  </Button>
                </div>
              </>
            )}
          </aside>
        )}
      </div>
      {run && (
        <button className="run-bar" onClick={() => setDrawer(true)}>
          <Badge status={run.status} />
          <span>
            {run.mode === 'preview' ? 'Development preview' : 'Live execution'} ·{' '}
            {run.steps.filter((s: any) => s.status === 'completed').length}/{run.steps.length} steps
            complete
          </span>
          <div className="run-bar-agent-dots">
            {run.steps.map((s: any) => (
              <span className={s.status} key={s.id} />
            ))}
          </div>
          <span>
            Open execution details
            <ChevronDown size={15} />
          </span>
        </button>
      )}
      {showRun && (
        <Modal
          title="Give your team a task"
          subtitle="Saved graph connections define the execution order and specialist handoffs."
          onClose={() => setShowRun(false)}
        >
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void startRun();
            }}
          >
            <Field label="Input format">
              <Select value={taskFormat} onChange={(e) => setTaskFormat(e.target.value)}>
                <option value="text">Text task</option>
                <option value="json">Structured JSON payload</option>
              </Select>
            </Field>
            <Field label="Task or input">
              <textarea
                autoFocus
                required
                rows={5}
                value={task}
                onChange={(e) => setTask(e.target.value)}
                placeholder="What should this team work on?"
              />
            </Field>
            <Field label="Execution mode">
              <Select value={mode} onChange={(e) => setMode(e.target.value)}>
                <option value="preview">Development preview · no model calls</option>
                <option value="live">Live · use each step’s model connection</option>
              </Select>
            </Field>
            <div className="info-banner">
              <Zap size={19} />
              <p>
                {mode === 'preview'
                  ? 'Preview runs the actual graph with deterministic agent output. Tools and knowledge nodes execute their real integrations.'
                  : 'Live execution may use your configured model credits and external tools.'}
              </p>
            </div>
            <div className="modal-actions">
              <Button variant="primary" type="submit">
                <Play size={15} />
                Start run
              </Button>
            </div>
          </form>
        </Modal>
      )}
      {validation !== null && (
        <Modal
          title={
            validation.length ? 'A few connections need attention' : 'Your workflow is connected'
          }
          subtitle={
            validation.length
              ? 'Resolve these before running or publishing.'
              : 'The graph passes component and dependency validation.'
          }
          onClose={() => setValidation(null)}
        >
          {validation.length ? (
            <ul className="validation-list">
              {validation.map((v, i) => (
                <li key={i}>
                  <AlertTriangle size={15} />
                  {v}
                </li>
              ))}
            </ul>
          ) : (
            <div className="validation-success">
              <Check size={30} />
              <p>All components are reachable and the dependency graph is valid.</p>
            </div>
          )}
        </Modal>
      )}
      {showSettings && (
        <Modal title="Workflow settings" onClose={() => setShowSettings(false)}>
          <Field label="Description">
            <textarea
              value={description}
              onChange={(e) => {
                setDescription(e.target.value);
                markDirty();
              }}
            />
          </Field>
          <Field label="Project">
            <Select
              value={projectId}
              onChange={(e) => {
                setProjectId(e.target.value);
                markDirty();
              }}
            >
              {projects?.map((pr) => (
                <option key={pr.id} value={pr.id}>
                  {pr.name}
                </option>
              ))}
            </Select>
          </Field>
          <div className="form-grid">
            <Field label="Concurrent steps">
              <input
                type="number"
                min="1"
                max="8"
                value={settings.concurrency || 4}
                onChange={(e) => {
                  remember();
                  setSettings({ ...settings, concurrency: Number(e.target.value) });
                  markDirty();
                }}
              />
            </Field>
            <Field label="Recorded token limit">
              <input
                type="number"
                min="100"
                value={settings.maxTokens || 50000}
                onChange={(e) => {
                  remember();
                  setSettings({ ...settings, maxTokens: Number(e.target.value) });
                  markDirty();
                }}
              />
            </Field>
          </div>
          <Field label="Run timeout (seconds)">
            <input
              type="number"
              min="5"
              max="3600"
              value={(settings.timeoutMs || 600000) / 1000}
              onChange={(e) => {
                remember();
                setSettings({ ...settings, timeoutMs: Number(e.target.value) * 1000 });
                markDirty();
              }}
            />
          </Field>
          <small className="muted">
            Token limits stop new model rounds after recorded usage reaches the limit. In-flight
            concurrent calls can exceed it. Cancellation aborts active requests immediately; edits
            apply to future runs.
          </small>
          <div className="modal-actions">
            <Button
              variant="primary"
              onClick={async () => {
                await save();
                setShowSettings(false);
              }}
            >
              Save settings
            </Button>
          </div>
        </Modal>
      )}
      {versions && (
        <Modal
          title="Version history"
          subtitle="Every saved revision is an immutable snapshot. Restore changes the draft only."
          wide
          onClose={() => setVersions(null)}
        >
          <div className="version-list">
            {versions.map((v, i) => {
              const previous = versions[i + 1],
                changes = previous
                  ? {
                      nodes: v.graph.nodes.length - previous.graph.nodes.length,
                      edges: v.graph.edges.length - previous.graph.edges.length,
                      changed: v.graph.nodes.filter((n: any) => {
                        const old = previous.graph.nodes.find((x: any) => x.id === n.id);
                        return old && JSON.stringify(old.data) !== JSON.stringify(n.data);
                      }).length,
                    }
                  : null;
              return (
                <div key={v.id}>
                  <span className="version-number">v{v.revision}</span>
                  <span>
                    <strong>{v.name}</strong>
                    <small>
                      {new Date(v.created_at).toLocaleString()} · {v.graph.nodes.length} nodes ·{' '}
                      {v.graph.edges.length} edges
                    </small>
                    {changes && (
                      <small>
                        {changes.changed} component configurations changed · nodes{' '}
                        {changes.nodes >= 0 ? '+' : ''}
                        {changes.nodes} · connections {changes.edges >= 0 ? '+' : ''}
                        {changes.edges}
                      </small>
                    )}
                  </span>
                  <Button
                    disabled={!editable}
                    onClick={() => {
                      remember();
                      setNodes(v.graph.nodes);
                      setEdges(v.graph.edges);
                      setSettings(v.graph.settings || {});
                      markDirty();
                      setVersions(null);
                      p.notify(`Version ${v.revision} restored to the draft`);
                    }}
                  >
                    Restore draft
                  </Button>
                  <Button
                    variant="icon"
                    title="Export version"
                    onClick={() => download(`${v.name}-v${v.revision}.json`, v)}
                  >
                    <Download size={16} />
                  </Button>
                </div>
              );
            })}
          </div>
        </Modal>
      )}
      {drawer && runId && (
        <div className="run-drawer">
          <RunDetails
            base={p.base}
            runId={runId}
            notify={p.notify}
            role={p.role}
            onClose={() => setDrawer(false)}
          />
        </div>
      )}
    </div>
  );
}
