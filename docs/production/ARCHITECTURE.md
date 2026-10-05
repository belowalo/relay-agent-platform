# Production architecture — foundation v1

This branch is the shared starting point for six implementation teams. It supplies real infrastructure adapters and contracts; it does **not** convert the entire application to production storage or qualify a production release. The existing local application remains executable.

## Inspected baseline

Baseline commit: `420beb3437480cda793b540fd13b0c22960e6a3b` (Relay 0.3). Express and the Node execution engine call synchronous `all/one/exec/transaction` helpers from `server/db.js`. SQLite WAL holds identity, workspaces, workflows, runs, events, credentials, documents, vectors and schedules. Leases support multiple processes on one host. Vectors are scanned per collection. Secrets use one local AES-GCM key without workspace-associated authentication data. Tools/providers and authentication already have substantial implementation and tests; they must be extended rather than replaced by placeholder controls.

The largest conversion risk is asynchronous storage: adding a PostgreSQL URL to the existing synchronous helpers cannot make them compatible. Runtime owns the complete async conversion and production bootstrap; security and knowledge own their domain repositories under the shared transaction convention. Frozen graphs, event order, approval arguments and action reconciliation must survive the conversion.

## Decisions

| Concern            | Local mode                            | Production target                                                                       | Reason / owner                                                               |
| ------------------ | ------------------------------------- | --------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| Domain persistence | Existing SQLite WAL                   | PostgreSQL, `relay` schema                                                              | Transactional state; runtime owns domain import/migrations                   |
| Job delivery       | Existing engine pump                  | BullMQ + Redis, PostgreSQL transactional outbox                                         | Avoid database/queue dual-write loss; runtime owns dispatcher/reconciliation |
| Retrieval          | FTS5 + vector scan                    | PostgreSQL full-text search + pgvector                                                  | One durable authorization/deletion boundary; knowledge owns indexes          |
| Binary storage     | Workspace directories / local adapter | S3-compatible object storage                                                            | Shared across hosts; connectors supplies BlobPort, knowledge consumes it     |
| API execution      | Existing embedded mode                | Separate API and worker entry points                                                    | Independent capacity, draining, recovery                                     |
| Credentials        | Existing envelope preserved           | Versioned AES-GCM envelopes, key IDs and scoped secret references                       | Rotation and ciphertext binding; security owns migration/key management      |
| Identity           | Existing sessions/MFA/OIDC            | Same product semantics with async repositories and distributed controls                 | Preserve users and application tokens                                        |
| Observability      | Existing local metrics                | Structured metadata logs, OpenTelemetry-compatible instrumentation and exported metrics | Operations owns adapters and deployment                                      |

No managed service subscription is required by these decisions. Self-hosted infrastructure is supported. Production object storage and model connections still need actual configuration. Do not add mandatory commercial-only queue features.

## Execution and data flow

1. Authenticate actor, resolve current membership/publication scope, authorize the operation, and construct a `TenantContext`.
2. Start one PostgreSQL transaction pinned to one client. Set `relay.workspace_id` using transaction-local configuration. Write the immutable run/source revision and its outbox reference together.
3. A narrowly privileged dispatcher leases due outbox records and publishes reference-only BullMQ jobs. A database failure before commit cannot leave an executable orphan job. A crash after publish can redeliver the same ID.
4. The consumer reauthorizes the referenced resource, claims a fenced database lease and loads the authoritative snapshot. The queue's lock is not permission to mutate business state.
5. Every checkpoint/result write must match the current lease generation. External writes also use action intent, exact reviewed arguments and provider idempotency keys where supported.
6. Waiting approvals release capacity; completion/approval enqueues fresh durable work. Polling/reconciliation repairs lost notifications. Redis loss must not erase authoritative runs or create an unsafe replay.
7. Streams read ordered persisted events. Pub/sub is an optimization, never the only copy of user-visible events.

The foundation provides `enqueueInTransaction` and the outbox table, **not** the dispatcher, worker business logic, dead-letter UI or exactly-once guarantee. Runtime implements those pieces.

## Database security and migrations

Use separate database roles: migrator/owner, restricted application role, and narrowly scoped dispatcher role. API credentials must not be superuser, BYPASSRLS, or table owner. The adapter includes `assertApplicationRole`; production startup must call it. Workspace tables require RLS policies and workspace-aware query predicates. Policies are defense in depth: the supplied context must first be authorized by the application.

Global identities/sessions are separate from workspace records. Do not invent a caller-controlled workspace context as a substitute for authentication. Cross-workspace dispatcher privileges must not be exposed to normal routes. Operations provisions roles; security reviews them; runtime supplies the dispatcher queries.

PostgreSQL migrations are append-only, four-digit names, checksum-verified, applied on one connection under a transactional advisory lock. `MIGRATION_DATABASE_URL` is only for an explicit migration command; application startup does not auto-migrate with privileged credentials. Production SQLite import must be a separate, audited runtime command with dry-run validation, row counts, secret compatibility, backups and restoration rehearsal.

## Configuration and entry points

`RELAY_PROFILE=local` is the default. The legacy `server/index.js` and `server/worker.js` still use SQLite. They reject `RELAY_PROFILE=production` **before** opening SQLite; the runtime team must replace that guard only when the actual production bootstrap exists. `NODE_ENV=production` continues to mean a local optimized build unless `RELAY_PROFILE` is explicitly selected.

`loadConfig` validates production URLs, HTTPS origin, secure-cookie setting, queue namespace, limits and key shape. It never prints configuration values. The security team should extend private-network exceptions through explicit connection policy rather than the legacy global `ALLOW_PRIVATE_NETWORK=true` production switch.

Do not point different modes at the same live directory. Do not copy private `.env` or `data` into a worktree or the repository. Disposable tests must use isolated data directories, ports and infrastructure namespaces.

## Sources and rationale

- [node-postgres transactions](https://node-postgres.com/features/transactions): all transaction statements use the same client.
- [PostgreSQL row security](https://www.postgresql.org/docs/current/ddl-rowsecurity.html): owner/superuser bypass requires deliberate role separation.
- [BullMQ connections](https://docs.bullmq.io/guide/connections) and [production guidance](https://docs.bullmq.io/guide/going-to-production): producer and worker connection policies differ; Redis persistence/eviction must be configured.
- [BullMQ stalled jobs](https://docs.bullmq.io/guide/workers/stalled-jobs): queue recovery can repeat delivery, so database fencing and action reconciliation remain necessary.
- [pgvector](https://github.com/pgvector/pgvector): exact/approximate search and filtering need representative recall and capacity tests.
- [Flowise](https://docs.flowiseai.com/) and [Langflow](https://docs.langflow.org/): integration depth, runtime access and deployment are meaningful comparison areas. Feature counts do not prove Relay's production readiness.

## Foundation scope

Implemented: configuration/guard, validated envelopes, async tenant context, PostgreSQL transaction adapter, checksummed migrations, RLS outbox, transactional enqueue, BullMQ transport, credential envelope cryptography, local blob adapter, executable tests and CI service qualification.

Contract-only, assigned to teams: existing-domain PostgreSQL repositories/import, outbox dispatcher, distributed business execution, pgvector indexing, shared object storage, authorized secret resolution, connector implementations, budget reservations, telemetry exporters and production application deployment. See `OWNERSHIP.md` and `ACCEPTANCE.md`.
