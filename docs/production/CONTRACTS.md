# Shared contracts — v1

Runtime validation: `server/foundation/contracts.js`. Port declarations: `server/foundation/ports.d.ts`. These are the frozen integration boundary. Implementations are asynchronous; existing SQLite SQL must not be translated by blind string replacements. Do not change v1 semantics independently; record proposed changes in your team handoff and coordinate them at integration.

## Tenant and request context

`TenantContext = {workspaceId, actor:{kind:'user'|'application'|'service',id}, requestId}`. IDs are opaque case-sensitive strings (1–128 alphanumeric, underscore or hyphen characters). Preserve imported IDs. Context comes only from verified identity + authorization, never directly from request JSON or queue delivery. `withTenant` propagates already-authorized context across asynchronous calls; it does not authenticate it. Revalidate membership/token/policy at execution and secret-resolution boundaries.

`requestId` accepts bounded safe caller correlation IDs or generates a UUID. It is diagnostic, never an authorization credential. Events must retain both run and request correlation IDs.

## Persistence

`DatabasePort.transaction(context, async session => ...)` pins one connection and transaction-local workspace setting. Session exposes parameterized `query`, `one`, `all`. SQL uses PostgreSQL `$1` placeholders and explicit column lists. Returning from the callback commits; throwing rolls back. Session and connection must not escape the callback. No external network/model call inside a database transaction. Use separate short transactions around external activity.

Production domain tables live in schema `relay`. Workspace-bound rows retain `workspace_id`; preserve existing snake_case persisted names and camelCase public API response shapes. Global account/session repositories have narrowly scoped methods, not an unrestricted pool exposed to routes. Domain repositories validate IDs, ownership and permissions before mutations.

## Queue and outbox

Job envelope: `{version:1,id:<UUID>,workspaceId,kind,resourceId,requestId}`. Kinds: `workflow.run`, `source.ingest`, `connector.sync`, `evaluation.run`, `maintenance.retention`. No additional fields, credentials, prompts or document text. A job references authoritative persisted state. Worker handler return values are discarded; Redis stores only the reference ID on completion. Handler exceptions are replaced with a generic failure before BullMQ persists its failure reason/stack. Business output and authorized error detail must be persisted through the database. Queue retention is temporary transport retention, not business history.

`enqueueInTransaction(session, job)` commits with the associated domain write. Reusing an ID with changed data is a conflict. Dispatcher state is `pending -> publishing -> published`, with owner/expiry/generation. Runtime must implement fenced publish/reconciliation and repairs for an acknowledgement lost after Redis accepted the job. Consumers check terminal state and claim business leases before any action. Redis redelivery, eviction or completed-job cleanup cannot authorize a duplicate effect.

BullMQ jobs use one transport attempt in the foundation. Runtime adds business retry scheduling through persisted state, with bounded classification and dead-letter records; do not enable both independent retry systems without a proven interaction design. Queue namespace is environment-specific; never consume test jobs on a production queue.

## Runs, approvals and actions

Retain run states `queued,running,waiting,completed,failed,cancelled`; retain skipped step state and ordered persisted event streams. Store timestamps as UTC instants, preserving API ISO strings. Monotonic event sequence is scoped to a run.

Leases contain `ownerId,generation,expiresAt`; all asynchronous result writes compare generation and state. Cancellation and actor revocation must be observed before starting additional external work. Approval stores the exact action ID, argument hash, arguments, frozen model checkpoint and policy/reviewer decision. Only authorized reviewers decide; model output cannot grant approval.

New action records normalize `prepared,started,succeeded,failed,uncertain`. Runtime must explicitly map legacy action states during import. `failed` means known failed; ambiguous network loss after a possible write is `uncertain`. Replays of uncertain writes require documented reconciliation. Provider-supported idempotency keys improve safety but do not justify a universal exactly-once claim.

## Credentials and connectors

`SecretReference = {workspaceId,connectionId,version}`. Persist ciphertext and key ID; resolve plaintext only after verifying current actor/connection scope. The new cryptographic vault binds ciphertext to all three reference fields using authenticated associated data. It supplies encryption/decryption only, not role authorization or a secret repository. Legacy three-part envelopes require an explicit security-owned migration; never relabel legacy ciphertext as a new envelope.

Connector descriptors declare semantic version, auth mode and actions with effect/read-write, idempotency capability and approval policy. `ConnectorPort.test` returns real capability status; `invoke` accepts input, secret reference, cancellation and optional idempotency key. It returns data, optional cursor and provider request ID. Errors are normalized; no raw dependency message/secret in public output. External writes always enter runtime approval/action tracking. A connector cannot bypass this by invoking its handler directly.

Credentials, OAuth scopes, provider changes, synchronization cursors and external deletion handling are connector-owned records. Never share a connection across workspaces implicitly.

## Documents, blobs and citations

`BlobPort` binds keys to an authorized workspace. Keys are immutable opaque IDs. References carry workspace ID, key, SHA-256, byte count and validated content type; backend bucket paths are not public URLs. Local filesystem adapter is development-only; production needs shared object storage. The local adapter assumes a trusted host filesystem; security must review hostile-host/symlink-race requirements before expanding its support envelope.

`DocumentPort.upsert(context,input)` returns `{sourceId,version,jobId}` after persisting a version and durable ingestion reference. Input carries collection, external source ID, name, blob/text/URL, scalar metadata and explicit workspace/restricted access. Knowledge defines and enforces mutually appropriate input combinations and document authorization. Connector synchronization calls this port, never writes chunks directly.

Citations carry workspace/collection/source IDs, source version, chunk ID, excerpt, finite relevance score and location (page, text offsets or URL). Version identifies the exact evidence used by the run. Score semantics must identify cosine/fusion/reranker mode in retrieval diagnostics; different scales are not interchangeable. Retrieval filters permissions before returning evidence. Deletion removes active chunks/vectors/blobs according to policy while saved run evidence follows explicit retention policy.

## Usage and budgets

`UsagePort.reserve` atomically reserves bounded tokens and integer micro-USD for a run; null cost means unknown. `settle` records actual model/provider usage and releases unused reservation; `release` handles known non-execution. Reconcile stranded reservations after crashes. Settlements are idempotent by reservation ID. Runtime calls this port before metered work, including fallback, tools that incur costs and child runs.

Do not interpret unknown as free, double-charge cache hits, or claim a hard dollar cap for unknown/unbounded provider charging. Security owns enforcement semantics; runtime supplies execution hooks; connectors report usage; operations exposes metrics; verification challenges concurrent reservations.

## Errors and telemetry

New public error envelope: `{error:{code,message,retryable,requestId}}`. Codes include validation, authentication, forbidden, not found, conflict, budget/rate limit, dependency unavailable and internal error. Arbitrary provider exception strings are not public messages. The existing UI currently expects a string `error`: preserve the legacy API shape until verification/UI and runtime agree on a versioned migration or compatibility serializer.

Telemetry uses allowlisted metadata. Do not log raw prompts, document bodies, plaintext keys, full authenticated URLs, cookies or email addresses. Workspace/run/request identifiers are acceptable access-controlled diagnostic attributes; avoid tenant IDs as unbounded Prometheus label values. Failed telemetry export must not block or corrupt business execution.

## Health and shutdown

Liveness is process health. Readiness checks dependencies, restricted database role, required schema version and drained/not-starting state. Dependency health alone is not production qualification. Shutdown stops accepting work, drains within a bound, aborts safe operations and preserves uncertain-action state. Operations defines endpoints/exporters; runtime owns execution draining.
