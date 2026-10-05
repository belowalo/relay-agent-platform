# Production verification commands and evidence

Starting point: foundation `76649286b51b39924261a876878efebf5e02f020`. Verification owns tests, synthetic data, examples and `src/**`. It does not implement other teams' production adapters or merge their developing branches. The coordinator qualifies the exact combined commit after integration.

## Branch validation

```powershell
npm ci
npm run foundation:types
npm run build
npm test
$env:PLAYWRIGHT_PORT = '15377' # choose an unused port per worktree
npm run test:browser
npm run test:acceptance
npm run test:failure
npm run test:load:smoke
npm run format:check
```

The baseline regression suite includes two optional live foundation-service tests; their skipped status does not pass those gates. `npm run test:services` is the existing **strict** PostgreSQL/Redis entry point and must run on configured disposable services. Do not change a skipped/blocked result to passed. New acceptance/failure tests use OS-allocated ports and temporary synthetic databases; browser ports are configurable. Browser artifacts use `test-results/`; harness reports use `verification-results/` so Playwright's output cleanup cannot erase load/recovery evidence. Both are ignored.

The local suite proves the local product only. It checks registration/login, viewer denials, removed membership, workspace boundaries, actual HTTP provider adapter errors/streaming/accounting, source ingestion/reindex/deletion, citations, validation/revision conflict, frozen publication, scoped token access/revocation, agent-selected exact arguments across restart, rejection, cancellation, safe interrupted model calls, evaluations, persisted schedules, local database/key restoration and all five business example graphs.

The failure drill kills a separate worker during a real local HTTP read, waits for lease recovery, injects response loss after a synthetic write and challenges unsafe retry, then cancels across processes. It also makes a synthetic schedule five minutes overdue, starts two workers and verifies one catch-up run. It records before-run recovery/cancellation thresholds, actual hardware/topology, observed recovery and action counts. Windows process termination semantics are handled explicitly; teardown owns only spawned processes and validated temporary directories. It cannot prove multi-host recovery. Restoration checkpoints SQLite after shutdown, saves the database/key, mutates a workflow, then restores the earlier revision and verifies credential-backed execution.

## Load and soak

Profiles and thresholds are frozen in `tests/load/profiles.json`. The runner writes `manifest.json` before provisioning/measuring, including Git SHA/dirty state, actual generator hardware, topology, requested workloads/concurrency/duration and thresholds. It records actual indexed document/chunk counts rather than assuming chunk counts from input size. Generated documents contain synthetic travel policies; no private documents are loaded.

| Profile | Measurement / warm-up | Active run clients | API / retrieval rate        | Initial corpus  | Workspaces / users |
| ------- | --------------------- | ------------------ | --------------------------- | --------------- | ------------------ |
| smoke   | 20 / 5 seconds        | 4                  | 10 / 2 requests per second  | 20 documents    | 1 / 1              |
| load    | 300 / 30 seconds      | 25                 | 20 / 10 requests per second | 5,000 documents | 10 / 100           |
| soak    | 3,600 / 300 seconds   | 25                 | 20 / 10 requests per second | 5,000 documents | 10 / 100           |

Accounts created for invited members also have empty personal workspaces; only the ten workload workspaces are populated. Ingestion setup is bounded to eight simultaneous uploads, then indexing must finish. Background ingestion continues during measurement. Non-model API reads and retrieval use open-loop pacing with a bounded 100-request in-flight window; missed work and actual throughput are reported, so saturation cannot silently lower the offered rate. Workflow clients continuously submit model requests at bounded concurrency. Queue state is sampled every five seconds. Provisioning time is excluded from the measurement window.

Thresholds before qualification: authenticated API P95 <=300 ms; retrieval P95 <=1,000 ms; dispatch P95 <=2,000 ms; unexpected error rate <1%; at least 95% offered API/retrieval rate achieved with no dropped request; no unexplained lost runs or failed background ingestion. A one-hour soak needs final 30-minute average memory growth <10%, at least 300 valid resource samples, no sampled queue above 50 queued runs, and zero queued/running workload runs after drain. The queue bound is an additional verification guard for 25 active clients, not an advertised product limit. Change it only with rationale and rerun evidence.

Faults are deterministically injected at the configured interval: provider authentication, rate limit, server failure and partial stream disconnect. Expected failed runs are counted separately; unexpected statuses and lost/timeout jobs fail the run. Ordinary API/retrieval errors remain in error-rate and latency samples. Synthetic provider usage is not real billing.

`report.json` includes P50/P95/P99/max for HTTP API, retrieval, dispatch, run observation, provider service duration, application execution residual and background ingestion; error rates; throughput; fault outcomes; queue series; RSS, cumulative CPU and local disk bytes. Provider service duration is measured at the HTTP fixture and correlated through synthetic `LOAD-<UUID>` inputs. Application residual subtracts that duration from persisted step execution; it still includes network/adapter/storage overhead. End-to-end run observation includes polling and dispatch. These are distinct measures, not an inference that remote provider time is zero. External resource monitoring must aggregate all application processes, excluding the generator; the local sampler covers the embedded API/worker process only.

`thresholdChecks` evaluates only the chosen manifest. `releaseGates` remains blocked for a local/small/short run and pending broader ACL/quality/service evidence even when target load thresholds pass. A 20-second smoke run cannot pass the one-hour/50,000-chunk/multi-host release profile. There is no capacity or SLA claim from branch smoke results.

For the actual integrated staging system:

```powershell
$env:ACCEPTANCE_ORIGIN = 'https://<disposable integrated staging origin>'
$env:ACCEPTANCE_DISPOSABLE = 'yes'
$env:ACCEPTANCE_FIXTURE_URL = 'http://<test-network reachable synthetic fixture>'
$env:LOAD_TOPOLOGY = '<JSON with actual API/worker hosts, CPU/RAM, PG, Redis and object-storage allocations; no secrets>'
$env:LOAD_RESOURCE_FILE = '<operator-collected aggregate resource JSON path>'
$env:LOAD_OUTPUT = 'verification-results/staging-soak'
npm run test:soak
```

Start the standalone fixture with `npm run acceptance:fixture`; its allocated port is printed. The current fixture binds loopback, so expose it through an isolated staging test-network proxy for remote workers rather than a public service. `/diagnostics` supplies synthetic timings/action observations. Resource-file records are `{at:<ISO UTC>,scope:"application-total",rssBytes:<integer>,cpuSeconds:<cumulative number>}` at five-second intervals; collect across the API/worker fleet. Generator `hardware` is not the fleet allocation—record actual fleet resources in `LOAD_TOPOLOGY`. Include database/Redis/storage CPU, memory, I/O and space in the operator's companion report; this Node harness cannot observe remote infrastructure itself. `LOAD_OUTPUT` can contain sensitive topology, so keep raw reports private unless sanitized.

Do not run 5,000-document or one-hour qualification against private/production workspaces. Registration creates isolated synthetic identities, schedules are cleaned up, and local directories are removed; external synthetic account/workspace cleanup belongs to the deployment operator. Preserve artifacts before teardown.

## Strict production conformance seam

```powershell
$env:ACCEPTANCE_DISPOSABLE = 'yes'
$env:ACCEPTANCE_ADAPTER = '<absolute coordinator-owned integrated adapter module.mjs>'
npm run test:acceptance:services
```

This command fails when the adapter/services are missing. It is **contract-based work awaiting integration**, not a fake database/queue implementation. The adapter must export `openAcceptanceServices()` and return real async ports from the merged runtime/security/knowledge/connectors/operations system. No boolean fixture may stand in for a real migration/deployment. Preserve underlying command outputs and service evidence for review.

Required values: `profile:'production'`; authorized `contextA`, `contextB`, and `contextRestrictedPeer` (different principals; the peer is in A's workspace but excluded from a restricted document); `collectionA`; eight persisted synthetic `runIds`; and real `database`, `queue`, `blobs`, `documents`, `usage` ports from `server/foundation/ports.d.ts`. Startup calls restricted-role verification. Helpers are test composition, not new public product routes:

| Adapter helper                                                                         | Required actual behavior                                                                                                                                                                                                                                                           |
| -------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `waitForRetrieval(ctx,collection,query)` / `retrieve(ctx,collection,query)`            | Await real ingestion; return contract-v1 citations; apply document/workspace permissions before evidence; deny foreign collections as empty evidence for this test seam                                                                                                            |
| `setBudget(ctx,{maximumTokens,maximumCostMicros,allowUnknownCost})` / `readUsage(ctx)` | Configure disposable policy; read actual persisted `tokens,costMicros,reservedTokens`; challenge concurrent and idempotent reservations                                                                                                                                            |
| `prepareApprovedAction(ctx,input)`                                                     | Persist a reviewed exact action through runtime and return `job,runId`; never invoke a connector handler outside action tracking                                                                                                                                                   |
| `readExternalWriteCount()` / `waitForRun(id)` / `waitForQuiescence()`                  | Read a synthetic receiving service; drain authoritative queue/run state, prove duplicate delivery does not create duplicate writes                                                                                                                                                 |
| `migrateAndRestoreSyntheticData()`                                                     | Run actual dry-run/import/backup/restore in disposable services; return source/imported/restored table counts, ID preservation, credential decryptability, vector/blob hash integrity, isolation observations and measured `rpoMs,restoreMs`; attach raw sanitized commands/hashes |
| `deploymentSmoke()`                                                                    | Execute HTTPS/proxy, dependency-loss readiness, drain and rollback rehearsals; return actual host IDs, instance/worker counts, PostgreSQL/shared-storage identity and observed checks                                                                                              |
| `close()`                                                                              | Close resources and clean up only the adapter's uniquely named disposable infrastructure                                                                                                                                                                                           |

Table reports must include positive counts for users, members, workflows, runs, connections, sources and chunks. Restore targets are <=1 hour RPO/RTO. Deployment requires two actual hosts, two API instances and at least two workers; two containers on one host do not establish D02. Queue entries are validated against the exact foundation job schema; citations must include source version and location. Operations reports `npm run test:operations`, `npm run operations:qualify`, `/health/live`, `/health/ready`, private Bearer `/metrics` and `operations-results/report.json` on its branch, with configurable `OPERATIONS_PORT`, `OPERATIONS_TLS_PORT`, `OPERATIONS_RESULTS`, `OPERATIONS_KEEP`. Integrate its documented composition hooks and run those commands before adapting deployment/restore evidence. This verification branch has not merged or validated that developing branch. Its infrastructure fixture preserves `runtimeIntegrated:false`, so it cannot pass full domain or two-host acceptance by itself.

External `test:acceptance` can target preserved public API shapes using `ACCEPTANCE_ORIGIN`, disposable acknowledgement and a reachable fixture. Its local process-kill/filesystem sections are excluded; the local restoration case is explicitly skipped. Therefore it cannot pass production restart/restore or exactly-once claims. Run strict conformance and the operations/runtime fault/recovery suites alongside it. Final S01/S02 coverage also requires the security team's sensitive-endpoint matrix and negative suite; these business journeys are not a comprehensive security audit.

## Real-model quality and remaining live checks

```powershell
$env:ACCEPTANCE_ORIGIN = 'https://<disposable integrated staging origin>'
$env:ACCEPTANCE_DISPOSABLE = 'yes'
$env:LIVE_ALLOW_MODEL_CALLS = 'yes' # authorize these model charges explicitly
$env:LIVE_WORKSPACE_ID = '<synthetic workspace ID>'
$env:LIVE_SESSION_COOKIE = '<private authorized session cookie>'
$env:LIVE_CONNECTION_ID = '<tested funded real model connection ID>'
$env:LIVE_RETRIEVAL = 'hybrid'
npm run test:acceptance:live
```

The runner freezes thresholds/settings/benchmark hash before calls, uploads fifty held-out synthetic policy documents, retrieves top five, executes actual Live agent answers, replays streamed events and records actual usage and per-case evidence. Record provider, exact model/version, embedding model and settings in the companion evidence; a connection ID alone is not sufficient provenance. These frozen questions are for evaluation only—do not tune prompts/indexing on them and reuse the score as held-out quality. Synthetic facts are not real-document quality certification. The runner returns a nonzero **blocked** result until independent human review is supplied.

Review `verification-results/live-quality/cases.json` against evidence and expected answers. Review format:

```json
{
  "benchmarkHash": "<manifest hash>",
  "resultsHash": "<exact saved cases hash>",
  "reviewer": "<independent reviewer identifier>",
  "reviewedAt": "<ISO UTC>",
  "cases": [
    { "id": "question-1", "answerCorrect": true, "citationsTotal": 1, "citationsSupported": 1 }
  ]
}
```

Include every case exactly once and count **all** cited factual claims, including unsupported claims. At least one cited claim per answer is needed; an uncited answer cannot pass grounded-answer precision. `resultsHash` prevents a review of old answers from approving a new run. Score without paying for another model run:

```powershell
$env:LIVE_REVIEW_FILE = '<private independent-review JSON path>'
npm run acceptance:quality:score
```

K03 requires recall@5 >=85%, citation-support precision >=95%, human-reviewed correctness >=85%, successful live streams and actual model usage. Missing review/calls stay blocked; invalid or stale review fails. Run separate adversarial/insufficient/conflicting-evidence live cases and authorized normal/corrupt/oversized/scanned format fixtures for K01/K04. `travel-policy.md` includes an explicit injection and archived conflicting rate for this purpose. Real-user documents require separate authorization and must remain private.

Live blockers on this branch: funded provider connection; actual PostgreSQL/pgvector, Redis and S3 services; restricted roles and migration permissions; integrated runtime/identity/document/action/budget adapters; two-host staging with HTTPS/proxy and monitoring; actual key/backup restoration dependencies; authorized OIDC/SMTP and native GitHub/Slack/Drive/S3/PostgreSQL/MCP integrations; independent human review. Fixture protocol checks do not pass those live gates.

## Final integration sequence

After merging teams on the coordinator's integration branch, record the exact SHA and topology. Run build/types, baseline tests, foundation services, business acceptance, browser journeys, production conformance, runtime/security/connectors/knowledge/operations suites, migration/restore/deployment rehearsals, target load/soak, then real-model/document/native-integration samples and independent review. Retain sanitized per-case results and command exit codes. No unfinished team branch is reported as having passed final integration. The coordinator owns the release verdict under `ACCEPTANCE.md`.
