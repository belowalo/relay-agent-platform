# Architecture and extension points

## Data and access

React uses same-origin JSON and persisted SSE endpoints. Express checks a session, workspace membership, and role for every workspace request. Queries bind both resource IDs and workspace IDs. SQLite WAL stores accounts, projects, graphs, revisions, connections, tools, sources, chunks, memory, runs, steps, event streams, action ledgers, applications, artifacts, and audit entries.

Credential values are encrypted with AES-256-GCM. Authentication session and published application tokens are hashed. Published application tokens cannot be used as workspace sessions. API and webhook access is associated with the specific application ID, including after it publishes a newer version.

## Engine

Each run freezes a graph and its reusable workflow/tool dependencies. Each node has a persisted step. The scheduler starts a step when its incoming dependencies are terminal and at least one route is active. Model and HTTP operations are asynchronous; configured concurrency is enforced per run with a process-wide active-step bound.

Condition outputs select labeled edges. Inactive branches become skipped. Joins wait for all incoming branches and collect active results. Partial failures are visible; a component can explicitly continue with surviving incoming results. Cyclic canvas graphs fail validation. Repetition happens through bounded loop nodes invoking saved reusable workflows.

An orchestrator requests a JSON plan assigning a task to each connected specialist. The graph dispatches the assignments; downstream reviewer/agent components collect and consolidate specialist results. Model-driven tool calls run a bounded request/tool/result loop. Tool calls accept only assigned tools and their schemas. Agent inputs, assignments, outputs, tool events, token fragments, and usage are recorded in the event log.

Approval nodes persist waiting steps. Reusable workflow and loop nodes also persist waiting checkpoints while a child runs or awaits approval. No worker stays occupied during a nested approval. A persisted execution clock excludes waiting checkpoints and server downtime from run timeouts. On restart, safe unfinished steps return to the queue, completed steps are retained, and incomplete side-effect steps require reconciliation.

Idempotency is bounded by the local ledger. There is no atomic transaction spanning a model provider, external tool, and SQLite. HTTP writes include an `Idempotency-Key`, but the destination decides whether it honors it. Interrupted external actions are never automatically replayed. Local read-only calls may be retried.

## Extending components

1. Add metadata to `nodeCatalog` in `server/catalog.js` (kind, group, name, description).
2. Register a handler with `registerNode(kind, handler)` in `server/engine.js`. Handlers receive workspace/run/node/graph context, an abort signal, input, and event emitter. Return JSON-compatible output or a persisted waiting marker when implementing a checkpoint.
3. Add relevant validation and typed configuration fields in `src/Builder.tsx`. The standard node renderer supports any catalog kind; specialize its icon and presentation when useful.
4. Add an executable fixture or integration test for dependency and cancellation behavior.

## Extending providers

`registerProvider(name, handler)` registers a provider handler receiving connection, messages, generation config, tools, signal, and onToken. It returns text, token usage, and parsed tool calls. Update the connection schema/catalog and form options to make the adapter selectable. Provider secrets must be read on the server; never put them in graph data or streamed events.

## Extending tools

`toolHandlers[kind]` holds executable integrations. Add metadata to `toolCatalog`, a handler accepting context/config/input, and visual settings to `src/resources.tsx`. Declare external side-effect behavior in `isSideEffect`, and use the central `executeTool` path so validation, event logging, and action-ledger guards apply. The custom API tool already supports extension through HTTP endpoints and JSON schemas without changing the engine.

## Extending templates

Add a named template with actual nodes and edges to `templates` in `server/catalog.js`. Templates are copied into drafts. Configuration-dependent templates state their requirements: knowledge QA needs a collection; live agent templates need model connections. Preview does not pretend to retrieve evidence, reason, or run agent-selected tools.

## Known bounds

The scheduler supports multiple local processes sharing SQLite WAL. Workers atomically claim run leases and fence asynchronous results using a lease generation. Safe reads recover after expiry; uncertain writes require reconciliation. It has no multi-host database, dynamic unlimited delegation, arbitrary cyclic graphs, or exactly-once external execution guarantee. Retrieval supports FTS5, local/remote embeddings and hybrid reciprocal-rank fusion. Vector ranking scans a collection rather than using a large-scale vector service. Model credential/provider changes affect subsequent requests using those connections. Published graphs and referenced tool/subworkflow configurations are frozen. See the coverage and verification documents for tested evidence.

## Expansion services

`leases.js` manages capacity, ownership generations and heartbeat metadata. `worker.js` starts separate execution; `ENGINE_ROLE=api` disables embedded execution. Maintenance schedules interval runs and grades saved cases. Schedule advancement and run insertion share a transaction. Indexing uses independent expiring ownership and generation checks to prevent an old task overwriting a newer reindex.

`embeddings.js` runs local inference in a worker thread, preserving API responsiveness, or uses a workspace-scoped embedding connection. Vectors are normalized, dimension-checked and tied to a model identity. Source deletion cascades vectors. Failed/reindexing sources are excluded from retrieval.

`evaluations.js` freezes dataset and workflow revisions, enqueues real runs, persists judge runs, grades outcomes and includes execution/judge usage. Maintenance uses a separate evaluation lease. `platform.js` exposes scoped datasets, prompts, evaluations, schedules, reviews and operations metrics. Prompt versions are copied into instructions rather than dynamically referenced.

`security.js` handles TOTP MFA/recovery codes, password/session invalidation, SMTP recovery and OIDC. Authenticator keys use the vault; recovery links/codes and challenges are hashed; PKCE verifiers are encrypted. OIDC rejects state/nonce mismatches, unverified emails and invalid signatures/claims. Password accounts require existing credentials rather than implicit same-email linking. Organization admission is controlled by the identity provider and optional domain policy.
