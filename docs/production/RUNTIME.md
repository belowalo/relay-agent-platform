# Runtime operating guide

Foundation: `76649286b51b39924261a876878efebf5e02f020`. Production runtime uses PostgreSQL authoritative state and reference-only BullMQ delivery. Local mode retains the original SQLite application. Selecting production never opens SQLite or creates a local vault.

## Composition and start

Apply migrations explicitly with `npm run foundation:migrate` using a dedicated `MIGRATION_DATABASE_URL`. Runtime versions are `0100`–`0103`; never edit an applied migration. Application startup checks schema readiness and refuses table-owning/superuser/BYPASSRLS credentials.

Run `RELAY_PROFILE=production` with the foundation configuration, then `npm run start:api` or `npm run worker`. Use a separate restricted application `DATABASE_URL` and dispatcher `RUNTIME_DISPATCH_DATABASE_URL`. The worker starts dispatcher, scheduler and BullMQ consumer; API does not execute work. Set `RUNTIME_LEASE_MS` (default 30000, 200–120000), `WORKER_CAPACITY`, and `SHUTDOWN_TIMEOUT_MS`. Each environment needs its own `QUEUE_PREFIX`.

`RUNTIME_ADAPTER_MODULE` is an absolute path to a trusted ES module exporting `createRuntimePorts({config})`. This composition requirement deliberately fails closed until the security, connector and knowledge implementations are wired. Do not use fixture adapters in production. Return:

- `authenticate(req) -> TenantContext`: verify session/application identity and workspace membership; do not copy request JSON into context.
- `authorize(context, operation) -> boolean`: current authorization at API, execute, schedule, approve, reconcile, recover and admin boundaries. Reviewer and recovery authorization must inspect the referenced persisted resource.
- `usage`: the frozen UsagePort. Runtime reserves before metered execution, settles returned usage, releases only known non-execution, and checkpoints stranded reservation IDs. Security must reconcile those IDs before permitting recovery. Unknown cost stays null.
- `model.call(context,{config,messages,tools,signal,mode,meteredCall})`: every provider attempt, including fallback, must run through `meteredCall({maximumTokens,maximumCostMicros}, async invoke)`. Return `{text,toolCalls,usage,provider,model}`; each tool call has `{id,name,arguments}`. Provider failure classification is allowlisted; raw exception text is not persisted.
- `tools.describe(context,tool) -> {effect:'read'|'write',requiresApproval,idempotency,inputSchema,metered,maximumTokens,maximumCostMicros}` and `tools.invoke(context,{tool,input,signal,idempotencyKey,actionId}) -> {data,providerRequestId,usage}`. The adapter must authorize current connection/secret scope and reject private endpoints according to security policy. Default write approval is required. An explicit policy-approved false may waive human approval while retaining action tracking. `knownNotExecuted:true` is a strong adapter assertion, never inferred from a timeout.
- `knowledge.retrieve(context, query)` and `memory.read/write(context, request)` for those configured nodes. Missing configured capabilities fail visibly. `telemetry.event/timing` use metadata only. `registerRoutes(app,{repository,scheduler})` installs security and other domain API modules. `close()` closes adapter resources.

Do not import `server/providers.js`, `tools.js`, `auth.js`, or `knowledge.js` directly into the production composition: those legacy modules import synchronous SQLite. Production uses explicit async ports. The workflow/run/schedule/recovery API is implemented here; legacy account, connection, document, evaluation, publication/chat/widget and UI response compatibility still require domain route composition at integration. This branch alone does not qualify the complete product for company use.

## Database privileges

Grant the application role USAGE on `relay`, SELECT on `schema_migrations`, necessary tenant domain SELECT/INSERT/UPDATE/DELETE, and sequence USAGE/SELECT. Do not grant unrestricted global identity/session repositories to arbitrary route code. All tenant tables have forced RLS, explicit workspace predicates and tenant-consistent foreign keys. Operations/security should narrow grants per API and worker role. No application credential may own tables or bypass RLS.

The only cross-workspace discovery surface is `relay.runtime_workspaces()`, a SECURITY DEFINER function with fixed search_path, no caller parameters and EXECUTE revoked from PUBLIC. Grant EXECUTE only to the dispatcher login. Its owner must be a dedicated non-login migration/service owner capable of reading forced-RLS tenant rows (BYPASSRLS); never use that owner's credential in the application. The dispatcher login needs no cross-workspace table grants. Publishing and business writes still use tenant transactions through the application database. Review these grants with security before deployment.

## Execution and recovery

Run creation writes immutable graph/input/actor/limits, initial steps, ordered event and outbox reference in one transaction. Publication freezes recursively resolved child graphs and configured tool records. Credentials are resolved at execution, never captured as plaintext. Graphs have at most 50 nodes; defaults bound duration to 15 active minutes, model rounds to 5 (max 12), tool calls to 30 (max 100), child depth to 5, parallel nodes to 4 (max 8), and output/checkpoint payloads to 1 MiB (max 10 MiB).

Claims lock workspace capacity and the run. Database clock controls lease expiry; every checkpoint, event/result, heartbeat and action outcome requires the current generation, owner, running status and unexpired lease. Expired workers cannot finish newer work. Waiting approvals/children release run capacity. Cancellation invalidates running authority and cascades to descendants; heartbeat observes it before further external execution. An already-started remote effect cannot be revoked by local cancellation.

Transient read failures use persisted exponential backoff (250 ms base, at most 3 configured retries); BullMQ remains one transport attempt. Crashed run recovery is bounded by max_attempts (default 4). Exhaustion creates a durable dead letter. Retry/recovery endpoints require authorization. They retain completed checkpoints and active duration; retry cannot reset the execution budget or bypass uncertain actions. Approval decisions require the exact stored argument hash and a still-pending approval on a waiting run. Restart resumes the frozen model result and selected tool arguments.

Every write records `prepared -> started -> succeeded|failed|uncertain`, a per-occurrence identity, canonical argument hash and stable provider idempotency key. Only a provider-supported descriptor sends that key. Network loss, timeout, cancellation or worker death after start is uncertain. `POST /api/w/:wid/actions/:id/reconcile` requires a privileged actor, evidence note, known outcome and result. Confirm externally before choosing succeeded/failed; never infer failed from missing response. A reconciled succeeded result is reused without invoking the action again. Known-failed action records are not automatically reissued; use a deliberately reviewed new run when another effect is intended. No universal exactly-once guarantee is claimed.

Dispatcher claims are fenced and acknowledgement loss republishes the same ID after expiry. Reconciliation creates fresh reference IDs for due runnable work after five seconds, repairing transport retention/Redis loss. One reference per workspace per sweep and last-claim ordering provide tenant fairness; workspace max_running/max_queued enforce shared capacity/backpressure. These are bounded fair sweeps, not a weighted service-level fairness guarantee across arbitrarily many tenants. Scheduler locks due records, inserts a unique schedule/due occurrence and run/outbox atomically, and advances next_at in that transaction. Downtime is coalesced into one execution rather than a backlog of missed intervals.

On SIGINT/SIGTERM the API closes requests; workers stop accepting work, allow a bounded drain, then abort remaining work. Lease and action records survive abrupt termination. Configure orchestration termination grace above SHUTDOWN_TIMEOUT_MS plus dependency timeouts. Readiness `/api/health` checks DB/queue and marks draining. Worker-only process readiness should be composed with operations health lifecycle adapters.

## API surfaces

All paths below are scoped beneath `/api/w/:wid`: workflows CRUD/publish/versions; runs create/list/detail/events/cancel/retry; run approvals/actions; approval decision; action reconciliation; dead letters; schedules create/list/disable; runtime capacity update. Events use a persisted run-scoped `sequence` cursor (`?after=N`), limited to 1000 per read. API errors retain the existing string `error` with safe `code` and requestId; arbitrary dependency messages are never returned.

## Qualification

`npm run test:runtime` exercises pure scheduling rules and a synthetic SQLite backup. `npm run test:services` refuses to run without disposable FOUNDATION_TEST_DATABASE_URL/FOUNDATION_TEST_REDIS_URL. Runtime tests create and destroy an isolated `relay_foundation_test_<random>` database, restricted random role and queue namespace. No private source data or keys are needed. See the runtime evidence and handoff for observed results and remaining release gates.
