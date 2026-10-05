# Runtime evidence — 2026-10-05

Foundation: `76649286b51b39924261a876878efebf5e02f020`. Branch: `codex/production-runtime`. Executable code and benchmark metadata qualified at `26a5143114b7f04358231277e0a772effb0fccd7`; subsequent delivery changes document these results. Final delivery SHA and its CI run are reported in the chat. No main merge or external deployment occurred.

Primary service evidence: [GitHub CI run 37282586412](https://github.com/belowalo/relay-agent-platform/actions/runs/37282586412), [service job](https://github.com/belowalo/relay-agent-platform/actions/runs/37282586412/job/111673863063). Tests create an isolated PostgreSQL database, restricted random login, synthetic SQLite backup and random Redis prefix, then destroy only those disposable resources.

## Checks

| Command                    | Observed result                                                                    | Scope                                                                                                                               |
| -------------------------- | ---------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `npm run build`            | Passed locally and CI                                                              | TypeScript/Vite build                                                                                                               |
| `npm run foundation:types` | Passed locally and CI                                                              | Frozen async port declarations                                                                                                      |
| `npm run test:runtime`     | 7 passed locally                                                                   | Argument hashing, error privacy, serialization, telemetry failure isolation, limits/graph planning, read-only representative backup |
| `npm test`                 | CI application regression passes; 3 service tests deliberately skipped in this job | Local-mode application behavior plus pure runtime tests; service job supplies the missing live checks                               |
| `npm run test:browser`     | 8 passed locally and CI                                                            | Existing complete local-mode UI journeys; local run used PLAYWRIGHT_PORT=14430 to avoid another server                              |
| `npm run format:check`     | Passed                                                                             | Includes server/runtime and operating/handoff documents                                                                             |
| `npm run test:services`    | 21 passed, 0 failed, 0 skipped                                                     | Actual PostgreSQL/Redis, foundation and runtime fault/migration/transport qualification                                             |

## Fault and migration observations

Passed observations include atomic simultaneous claims, shared tenant capacity, heartbeat/expiry fencing, stale-result rejection, multi-process worker termination/replacement, durable application bootstrap close/restart, cancellation across consumers, duplicate delivery, persisted bounded retries/backoff/dead letters, node timeout/drain, conditional parallel joins/skipped branches, loop child resumption, immutable run/revision triggers, revision-conflict rejection, exact approval hashes/stale decisions, interrupted agent approval without regenerating reviewed arguments, and uncertain remote writes requiring reconciliation.

The killed-write fixture increments an HTTP server effect counter before its worker is terminated. Recovery marks the action uncertain, refuses automatic retry, and observes one effect. Reconciliation of a separate successful-but-ambiguous action reuses the stored result rather than issuing another write. These observations do not establish universal exactly-once delivery.

Outbox tests inject acknowledgement loss and delete only the isolated test Redis prefix after a published job. PostgreSQL reconciliation emits a fresh reference and completes the authoritative queued run. Queue payload checks verify references without graph/input text. Publication never relies solely on a Redis completion record. Tenant dispatch tests observe at most one reference per workspace per sweep, and a second run is rejected under a max_queued=1 tenant policy.

Import uses synthetic accounts, membership, graph/revision, active run/step/event/action, encrypted connection, document collection/source/chunk/serialized embedding, publication snapshot and halted schedule. Dry-run leaves PostgreSQL empty. Apply preserves IDs, counts and verified legacy ciphertext; it maps interrupted writes to uncertain, clears run leases, reconstructs sequence ordering and refuses an occupied destination. The disposable destination is truncated through its explicit fixture relationships and restored from the same untouched backup, then checked again. The user's database, .env, vault key and documents were never read or copied. Organization-specific data and full binary/credential restoration remain cutover prerequisites.

Usage tests demonstrate reservation/settlement hooks and stranded reservation checkpoint/reconciliation. They use a synthetic UsagePort and do not qualify security's concurrent token/dollar enforcement. Null cost remains unknown. Production does not have a separate runtime budget implementation.

Earlier service runs exposed missing action relationships and a PL/pgSQL trigger row-shape error. Those were fixed with append-only 0104/0105 migrations; the tests were retained. A benchmark run using the deliberately short 400ms fault-test lease expired under CI contention. Benchmark configuration now matches the production 30s lease, while worker-kill/stale tests retain the 400ms injection setting. No acceptance threshold was reduced.

## Measurements

30 serial three-node model workflows passed through workflow publication, committed outbox, real Redis/BullMQ, a 250ms dispatcher sweep and the PostgreSQL worker. The model was an in-process deterministic fixture with a nominal 20ms delay and synthetic usage. No real provider credential or charge was involved.

| Measurement                                                            |       P95 |
| ---------------------------------------------------------------------- | --------: |
| Complete create/publish/outbox/queue/worker journey                    | 378.59 ms |
| Journey minus measured provider wait (includes dispatcher and polling) | 358.38 ms |
| Worker execution minus measured provider wait                          | 148.38 ms |
| Persisted queued event to running claim                                |    250 ms |

Host metadata from this run: Node v24.21.0, Linux, 4 logical CPUs, 15,990 MiB host memory; test-process RSS after the workload was 179.39 MiB. PostgreSQL pgvector:pg16 and Redis:7.4 were service containers sharing the GitHub runner. The benchmark used one BullMQ consumer, queue concurrency 2, serial requested workload; fault tests used two child consumers. Dedicated database/container allocations were not set. Percentiles for different components are independent and must not be added. Host contention affects results; a prior complete-path sample measured 332.84ms wall / 250ms dispatch.

This sample observes the <=2s dispatch target with available capacity, but does not qualify the target two-host topology, 25 concurrent runs, 20-request/sec API target, 50,000-chunk retrieval, one-hour soak, steady memory growth, live reasoning quality or backup RPO/RTO. Those remain integrated staging gates.

## Integration limitations

Security must supply real identity/authorization/UsagePort and credential migration. Connectors must supply authorized provider/tool/secret ports, fallback metering and shared BlobPort. Knowledge must supply retrieval/memory, binary migration and rebuilt search indexes. Operations must provision restricted application/dispatcher roles, shared binaries, process resource limits and production health/telemetry deployment. Legacy publication/chat/widget, evaluation, account/document/connection routes and full UI compatibility need async domain composition. Missing ports/kind handlers fail explicitly; no placeholder production identity or free-budget adapter is installed.

Offline import memory scales with backup contents. Limits cap persisted payloads, node/agent work and duration, not arbitrary hostile-code memory. Provider response limits and container enforcement remain adapter/operations requirements. A composed, supervised staging qualification is required before a company-use verdict.
