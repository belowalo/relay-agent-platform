export const nodeCatalog = [
  {
    kind: 'input',
    group: 'Input & output',
    name: 'Task input',
    description: 'The starting task or structured payload.',
  },
  {
    kind: 'output',
    group: 'Input & output',
    name: 'Final output',
    description: 'Collect and return a workflow result.',
  },
  {
    kind: 'orchestrator',
    group: 'Agents',
    name: 'Orchestrator',
    description: 'Plan and assign tasks to connected specialists.',
  },
  {
    kind: 'agent',
    group: 'Agents',
    name: 'Specialist agent',
    description: 'Execute a role with tools, knowledge, and memory.',
  },
  {
    kind: 'model',
    group: 'Agents',
    name: 'Model call',
    description: 'A direct model call with configurable generation.',
  },
  {
    kind: 'tool',
    group: 'Tools & knowledge',
    name: 'Tool action',
    description: 'Execute a configured integration.',
  },
  {
    kind: 'knowledge',
    group: 'Tools & knowledge',
    name: 'Knowledge retrieval',
    description: 'Search indexed workspace documents with citations.',
  },
  {
    kind: 'condition',
    group: 'Control flow',
    name: 'Condition',
    description: 'Route true and false branches from a JSON field.',
  },
  {
    kind: 'parallel',
    group: 'Control flow',
    name: 'Parallel branches',
    description: 'Dispatch the input to concurrent branches.',
  },
  {
    kind: 'join',
    group: 'Control flow',
    name: 'Join results',
    description: 'Collect all active incoming branches.',
  },
  {
    kind: 'loop',
    group: 'Control flow',
    name: 'Bounded loop',
    description: 'Run a reusable workflow for each item or revision.',
  },
  {
    kind: 'approval',
    group: 'Control flow',
    name: 'Human approval',
    description: 'Persist a checkpoint until approved or rejected.',
  },
  {
    kind: 'transform',
    group: 'Data',
    name: 'Data transformation',
    description: 'Map fields, select a path, or format a template.',
  },
  {
    kind: 'guardrail',
    group: 'Data',
    name: 'Policy guardrail',
    description: 'Validate payloads, block restricted phrases, and redact sensitive text.',
  },
  {
    kind: 'subworkflow',
    group: 'Data',
    name: 'Subworkflow',
    description: 'Execute a version snapshot of a reusable workflow.',
  },
];
export const toolCatalog = [
  {
    kind: 'http',
    name: 'HTTP request',
    description: 'GET, POST, PUT, PATCH, DELETE with schema validation.',
  },
  {
    kind: 'web',
    name: 'Webpage retrieval',
    description: 'Fetch a public webpage and extract readable text.',
  },
  {
    kind: 'search',
    name: 'Web search (SearXNG)',
    description: 'Search through your JSON-enabled SearXNG endpoint.',
  },
  {
    kind: 'file',
    name: 'Workspace files',
    description: 'Read, list, and write workspace artifacts.',
  },
  {
    kind: 'database',
    name: 'SQLite query',
    description: 'Read a workspace-isolated database of indexed knowledge.',
  },
  { kind: 'mcp', name: 'MCP server', description: 'Discover and call tools over Streamable HTTP.' },
  {
    kind: 'custom',
    name: 'Custom API tool',
    description: 'HTTP tools with JSON input and output schemas.',
  },
];
const n = (nid, kind, label, x, y, config = {}) => ({
  id: nid,
  type: 'relay',
  position: { x, y },
  data: { kind, label, config },
});
const e = (source, target, label) => ({
  id: `${source}-${target}`,
  source,
  target,
  ...(label ? { label, data: { branch: label } } : {}),
});
export const templates = [
  {
    id: 'team',
    name: 'Research studio',
    tag: 'Multi-agent team',
    description:
      'An orchestrator delegates to two parallel specialists, then a reviewer synthesizes their findings.',
    graph: {
      nodes: [
        n('input', 'input', 'Research brief', 40, 240),
        n('lead', 'orchestrator', 'Research lead', 330, 240, {
          instructions:
            'Plan a research assignment for each specialist. Separate evidence from assumptions.',
        }),
        n('research', 'agent', 'Research analyst', 640, 100, {
          instructions: 'Investigate the assigned task. Cite only sources you actually received.',
          role: 'Research analyst',
        }),
        n('strategy', 'agent', 'Strategy analyst', 640, 380, {
          instructions: 'Analyze tradeoffs, opportunities, and uncertainties.',
          role: 'Strategy analyst',
        }),
        n('review', 'agent', 'Editorial reviewer', 950, 240, {
          instructions:
            'Review all specialist outputs, identify missing evidence, and consolidate a clear report.',
          role: 'Reviewer',
        }),
        n('output', 'output', 'Research report', 1260, 240),
      ],
      edges: [
        e('input', 'lead'),
        e('lead', 'research'),
        e('lead', 'strategy'),
        e('research', 'review'),
        e('strategy', 'review'),
        e('review', 'output'),
      ],
    },
  },
  {
    id: 'report',
    name: 'Brief to report',
    tag: 'Sequential',
    description: 'Research, draft, and review a report in sequence.',
    graph: {
      nodes: [
        n('input', 'input', 'Brief', 40, 180),
        n('research', 'agent', 'Researcher', 330, 180, {
          instructions: 'Research the brief using assigned sources and tools.',
        }),
        n('draft', 'agent', 'Writer', 620, 180, {
          instructions: 'Turn the evidence into a clear report.',
        }),
        n('review', 'agent', 'Reviewer', 910, 180, {
          instructions: 'Review and revise the report for accuracy and clarity.',
        }),
        n('output', 'output', 'Report', 1200, 180),
      ],
      edges: [
        e('input', 'research'),
        e('research', 'draft'),
        e('draft', 'review'),
        e('review', 'output'),
      ],
    },
  },
  {
    id: 'knowledge',
    name: 'Knowledge assistant',
    tag: 'Retrieval',
    description:
      'Retrieve cited context from a collection and answer a question. Select your collection before running.',
    graph: {
      nodes: [
        n('input', 'input', 'Question', 40, 180),
        n('retrieve', 'knowledge', 'Retrieve sources', 340, 180, { collectionId: '', topK: 4 }),
        n('answer', 'agent', 'Knowledge assistant', 640, 180, {
          instructions:
            'Answer only from retrieved context. Include the provided source citations. Say when evidence is missing.',
        }),
        n('output', 'output', 'Cited answer', 940, 180),
      ],
      edges: [e('input', 'retrieve'), e('retrieve', 'answer'), e('answer', 'output')],
    },
  },
  {
    id: 'api',
    name: 'API enrichment',
    tag: 'Integration',
    description: 'Fetch a public API and map its response. Uses the built-in HTTP executor.',
    graph: {
      nodes: [
        n('input', 'input', 'Request', 40, 180),
        n('api', 'tool', 'Fetch API', 340, 180, {
          kind: 'http',
          url: 'https://api.github.com/repos/FlowiseAI/Flowise',
          method: 'GET',
        }),
        n('map', 'transform', 'Extract repository', 640, 180, {
          mapping: { name: 'full_name', stars: 'stargazers_count', description: 'description' },
        }),
        n('output', 'output', 'API result', 940, 180),
      ],
      edges: [e('input', 'api'), e('api', 'map'), e('map', 'output')],
    },
  },
  {
    id: 'approval',
    name: 'Human-reviewed draft',
    tag: 'Approval',
    description: 'Draft an answer, pause for review, then return the approved result.',
    graph: {
      nodes: [
        n('input', 'input', 'Task', 40, 180),
        n('draft', 'agent', 'Drafting agent', 340, 180, {
          instructions: 'Create a concise draft for human review.',
        }),
        n('approve', 'approval', 'Approve draft', 640, 180, {
          prompt: 'Review this draft before releasing it.',
        }),
        n('output', 'output', 'Approved result', 940, 180),
      ],
      edges: [e('input', 'draft'), e('draft', 'approve'), e('approve', 'output')],
    },
  },
];
export function validateGraph(graph) {
  const errors = [];
  if (!graph || !Array.isArray(graph.nodes) || !Array.isArray(graph.edges))
    return ['A workflow needs nodes and connections'];
  if (graph.nodes.length > 100 || graph.edges.length > 300)
    return ['Limit workflows to 100 nodes and 300 connections'];
  const ids = new Set(graph.nodes.map((n) => n.id));
  if (ids.size !== graph.nodes.length) errors.push('Node identifiers must be unique');
  if (graph.nodes.filter((n) => n.data?.kind === 'input').length !== 1)
    errors.push('Add exactly one task input');
  if (!graph.nodes.some((n) => n.data?.kind === 'output')) errors.push('Add a final output');
  for (const n of graph.nodes) {
    if (!nodeCatalog.some((x) => x.kind === n.data?.kind))
      errors.push(`Unsupported component: ${n.id}`);
    if (!n.data?.label) errors.push(`Name node ${n.id}`);
    if (n.data?.kind === 'knowledge' && !n.data.config?.collectionId)
      errors.push(`${n.data.label}: select a knowledge collection`);
    if (['loop', 'subworkflow'].includes(n.data?.kind) && !n.data.config?.workflowId)
      errors.push(`${n.data.label}: select a reusable workflow`);
    if (n.data?.kind === 'tool' && !n.data.config?.toolId && !n.data.config?.kind)
      errors.push(`${n.data.label}: select a tool`);
    if (n.data?.kind === 'condition') {
      const labels = graph.edges
        .filter((e) => e.source === n.id)
        .map((e) => e.data?.branch || e.label);
      if (!labels.includes('true') || !labels.includes('false'))
        errors.push(`${n.data.label}: connect and label true and false branches`);
    }
  }
  for (const e of graph.edges) {
    if (!ids.has(e.source) || !ids.has(e.target))
      errors.push(`Connection ${e.id} has a missing node`);
    if (e.source === e.target) errors.push('Use a bounded loop component for repetition');
  }
  const visited = new Set(),
    active = new Set();
  function walk(x) {
    if (active.has(x)) {
      errors.push('Cycles need a bounded loop component');
      return;
    }
    if (visited.has(x)) return;
    active.add(x);
    for (const e of graph.edges.filter((e) => e.source === x)) walk(e.target);
    active.delete(x);
    visited.add(x);
  }
  for (const n of graph.nodes) walk(n.id);
  const reached = new Set();
  function reach(x) {
    if (reached.has(x)) return;
    reached.add(x);
    for (const e of graph.edges.filter((e) => e.source === x)) reach(e.target);
  }
  graph.nodes.filter((n) => n.data?.kind === 'input').forEach((n) => reach(n.id));
  for (const n of graph.nodes)
    if (!reached.has(n.id))
      errors.push(`${n.data?.label || n.id}: connect this component to the task input`);
  return [...new Set(errors)];
}
