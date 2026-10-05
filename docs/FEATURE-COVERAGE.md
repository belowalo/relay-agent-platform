# Feature coverage

**Status:** substantial working local platform. All 13 requested feature areas have executable implementations. This does not claim commercial production readiness or complete parity with other products. Bounds and unverified external integrations are recorded below.

**Implemented** means source and persistence exist. **Verified** means targeted automated or browser evidence exists. **Externally unverified** means local fixtures validate an adapter, but successful remote service execution has not been verified. Preview reasoning and fabricated metrics are never counted as real-provider verification.

## Official product research — October 4, 2026

| Platform | Official evidence                                                                                                                                                                                                                     | Relay design implications                                                                       |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| Flowise  | [Agentflow V2](https://docs.flowiseai.com/using-flowise/agentflowv2): explicit dependencies, supervisor/workers, persistent human checkpoints, SSE, tools/knowledge                                                                   | Executable connections, recorded delegation, durable waiting checkpoints, persisted live events |
| Langflow | [Visual editor](https://docs.langflow.org/concepts-overview), [API](https://docs.langflow.org/api): configurable components and programmatic flows                                                                                    | Component inspectors, reusable graphs, authenticated application execution                      |
| Dify     | [Quick start](https://docs.dify.ai/en/quick-start), [Knowledge creation](https://docs.dify.ai/en/cloud/use-dify/knowledge/create-knowledge/introduction): input, model, condition, iteration, retrieval; explicit publication updates | Separate drafts/publications, text ingestion pipelines, bounded control-flow nodes              |

Relay uses its own charcoal/sage design, a reusable specialist library, and inspectable agent teams. The comparison establishes requirements, not identical capabilities.

## Coverage ledger

| #   | Area                 | Implemented scope                                                                                                                                                                           | Verification                                                                       | Explicit bound                                                                                       |
| --- | -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| 1   | Interface            | Dashboard, projects/workspaces, agents, builder, knowledge, tools, connections, history, applications, team, settings; themes, search, shortcuts, onboarding                                | Browser main journey; visual inspection; backend data queries                      | Counts/statistics are stored records; empty states are honest                                        |
| 2   | Canvas               | Drag/drop, connections, zoom/pan/minimap/fit, selection, copy/paste/duplicate, undo/redo/delete, library search, inspectors, validation, save/autosave, versions/restore/import/export      | Browser edits/reload, add/undo/redo/duplicate/validation/restore                   | Cyclic edges rejected; repetition uses bounded loop bodies                                           |
| 3   | Orchestration        | Central planner, sequential agents, parallel specialists, supervisor/workers, downstream review, handoffs, reusable teams/subflows, review/revision loops                                   | Recorded plan/assignments, overlapping workers, child runs and consolidated result | Model cannot invent unlimited workers or mutate the live graph                                       |
| 4   | Live execution       | Real step/run states, active nodes/edges, streamed tokens, assignments/messages/results/tools, timing/usage, error/retry/cancel/approval, selected-step inspection                          | API events and browser run inspector                                               | Cancellation cannot undo accepted remote actions; graph edits affect future runs                     |
| 5   | Models               | Provider registry, OpenAI-compatible/Anthropic, local endpoints, reusable encrypted credentials, endpoint/model selection, testing/errors, labeled preview                                  | Streaming/tool/structured-output fixtures; ciphertext/export assertions            | Successful hosted-model execution unverified; authorized OpenAI check returned exhausted credits     |
| 6   | Tools                | SearXNG search, webpages, HTTP/custom schema tools, workspace files/documents, SQLite data queries, MCP HTTP discovery/calls, application webhooks                                          | Real local executors and MCP SDK fixture                                           | No arbitrary host files/custom code, remote SQL adapter, or MCP stdio/legacy SSE                     |
| 7   | Knowledge/memory     | Uploads/websites/collections, parsing/chunking/overlap/FTS5 index/top-K, citations/progress/errors/reindex/delete, conversation/persistent memory inspection/deletion, workspace boundaries | API upload/retrieval/deletion/isolation; browser cited retrieval                   | Keyword/semantic/hybrid and bounded crawling; no OCR, dedicated vector service or memory summarizer  |
| 8   | Publishing           | Hosted chat/widget/API/webhook, branding/access/token rotation, frozen graph/tool/subflow version, explicit republish                                                                       | API version isolation; browser hosted chat and cross-origin widget                 | Model credentials remain workspace references; no public deployment performed                        |
| 9   | Access               | Scrypt accounts/sessions, workspaces/projects, email-bound expiring invitation tokens, owner/admin/editor/viewer roles, scoped resources, audit                                             | Backend outsider/viewer/invitation/cookie-origin tests                             | Manual invitations; MFA local; OIDC/SMTP recovery fixture-verified, live services need configuration |
| 10  | Engine               | Durable dependency scheduling, concurrency, bounded loops/retries, timeout/cancel, SSE, approvals/nested checkpoints, recovery/partial failure, execution/usage limits, action ledger       | Restart, approvals, loops, timeout/retry/cancel and uncertain-action tests         | Multiple workers on one host; no multi-host queue or exactly-once external guarantee                 |
| 11  | Analytics            | Search/status-filter history, step timelines/input/output/errors, durations/usage/success counts, configurable cost estimates, structural version comparison, run/artifact downloads        | Recorded-data API/browser verification                                             | Datasets, deterministic/LLM scores and revision comparisons; no automated purge scheduler            |
| 12  | Templates/extensions | Report team, knowledge QA, orchestrator/reviewer, API enrichment, approval; node/tool/provider/catalog/template registries                                                                  | Template graph execution and documented extension points                           | QA needs a collection; live agents need connections; external API depends on network                 |
| 13  | Delivery             | Source/lockfile, SQL schema/migrations, startup/environment instructions, Docker/Compose/proxy docs, tests, coverage and limitations                                                        | Build/type-check, integration suite, browser suite                                 | Docker/host deployment unverified; successful hosted reasoning needs available credits               |

## Component and agent coverage

- [x] Input and output.
- [x] Orchestrator and specialists; direct model calls.
- [x] Tools/integrations and knowledge retrieval.
- [x] Conditions with labeled true/false routes.
- [x] Parallel dispatch and dependency-aware joins.
- [x] Bounded item/revision loops; stop fields; persisted reusable workflow bodies.
- [x] Human approval; nested approval propagation.
- [x] Structured mapping, field selection, text templates.
- [x] Subworkflows with frozen execution snapshots.
- [x] Agent name/description/role/instructions/model/generation settings.
- [x] Assigned tools and knowledge; conversation/persistent memory settings.
- [x] JSON output schema validation and step/round/timeout/retry limits.

All supported connections carry data and affect execution. There are no decorative canvas edges.

## Detailed implementation bounds

### Models and live activity

The preview executes the actual dependency scheduler with explicitly deterministic agent results. It does not pretend to perform model reasoning or choose agent tools. Direct tool/retrieval nodes perform real actions even in preview. Real OpenAI-compatible and Anthropic adapters stream text, accumulate tool arguments, validate final schemas, record usage, and continue bounded tool-result loops. They require authorized connections for real-provider verification.

Run states include queued, running, waiting, completed, failed and cancelled. Inactive routes use an additional skipped state. Cancellation is immediate for active local requests. Approvals resume between steps. Failed/uncertain external effects block retry until the user reconciles the remote result and decides whether to start a new run.

### Tools and knowledge

Only implemented integration kinds appear as available. Search requires the user's JSON-enabled SearXNG endpoint. Custom tools are HTTP adapters with schemas; file tools operate on workspace artifacts; database tools execute read-only SELECT queries over the workspace-isolated documents data view. MCP supports Streamable HTTP discovery and invocation with reusable Bearer credentials.

Upload parsing covers PDF, DOCX, TXT, Markdown, CSV, JSON and HTML. Indexing supports FTS5, local/remote embeddings and hybrid reciprocal-rank fusion with chunk overlap, progress/failures, top-K retrieval and citations. Semantic ranking scans collection vectors in SQLite. Complex or scanned documents need further corpus/OCR handling. Website crawling follows up to 20 same-origin pages and simple robots exclusions. Memory is scoped by workspace and agent, optionally conversation, with inspect/delete controls.

### Publishing and durability

Saved workflow publication freezes referenced tool and reusable workflow configurations. Draft edits cannot change those snapshots. Publishing the latest revision is an explicit action. Connection credentials/provider settings remain workspace-managed references, so rotating/deleting/updating a connection affects subsequent calls.

Hosted chat/widget access can be public or token-gated. API/webhook access always uses an application token. Tokens are shown once, hashed, rotatable, and isolated to the application. Cross-origin widget embedding is browser verified locally.

SQLite retains run graphs, steps, child runs, events, action ledgers, memory, versions, evaluations, prompts, schedules and audit. Safe incomplete steps recover after restart; human checkpoints persist without occupied workers. There is no transaction spanning SQLite and a remote side effect, no multi-host database, and no exactly-once guarantee. Recorded usage limits stop new rounds but concurrent in-flight calls can exceed them.

## Remaining unverified delivery work

- [ ] Successful hosted-provider reasoning/tool/billing tests: an authorized OpenAI connection reported exhausted API credits. Local fixture contracts pass.
- [ ] Docker build and reverse-proxy deployment test: configuration supplied; not exercised on this host.
- [ ] Public deployment: not authorized and not performed.

These remaining checks are not represented as completed or replaced with placeholder integrations. See [Verification](VERIFICATION.md), [Architecture](ARCHITECTURE.md), and [Deployment](DEPLOYMENT.md) for evidence and operational scope.

## Version 0.2 expansion and competitor gaps

| Capability            | Implemented and exercised                                                                                                                       | Remaining bound                                                                          |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| Semantic RAG          | Actual local CPU embeddings, hosted-compatible embedding adapter, keyword/semantic/hybrid search, vector deletion/isolation                     | SQLite collection scan; no dedicated external vector database or reranker                |
| Website crawling      | Bounded same-origin links and simple robots exclusions                                                                                          | 20-page bound; no full robots grammar, sitemap crawler or OCR                            |
| Evaluations           | Dataset import/export, frozen cases/revisions, exact/contains/schema/success/latency/token rules, LLM judge, baseline comparison, per-case runs | Live quality depends on configured model; not a benchmark proving competitor superiority |
| Prompts/reviews       | Prompt revisions, builder reuse, run ratings/comments                                                                                           | Instructions are copied; no dynamic prompt-variable registry                             |
| Execution scale       | Separate API and multiple shared-host workers, capacity, leases, fencing, crash recovery, cross-process cancellation                            | No PostgreSQL/Redis multi-host backend; no exactly-once remote effects                   |
| Scheduling/operations | Atomic interval enqueue, pause/delete, queue/worker metrics, recorded success and P95                                                           | Minute intervals; no timezone-aware cron or managed alert delivery                       |
| Account security      | TOTP, one-use recovery, password changes/session invalidation, OIDC PKCE/state/nonce/JWT, SMTP reset                                            | Live SSO/SMTP need configuration; no SAML/SCIM                                           |
| Providers             | Groq/OpenAI/Anthropic/Ollama/LM Studio setup, compatible model discovery                                                                        | Two protocol adapters, not 100+ native provider/vendor integrations                      |

The upgraded core includes the main visual workflow, RAG, evaluation, prompt and operations building blocks. Full commercial parity still requires wider native connectors, multi-host/storage backends, production load testing, external service qualification and ongoing security/operations work. The application does not advertise these gaps as finished features.
