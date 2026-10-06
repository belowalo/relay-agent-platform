# Operator runbooks and rehearsal scope

Use `docker compose --env-file /etc/relay/private/production.env -f deploy/compose.production.yaml` below as `compose`. Keep sanitized request/run IDs and timestamps in incidents. Never paste keys, authenticated URLs, provider bodies or document contents. Record start/end, last verified backup time, affected tenant scope and reconciliation decisions. The executable `npm run operations:qualify` emits each drill and duration; it uses synthetic fixtures, real dependencies and isolated namespaces. Integrated workflow/business semantics remain separately testable by verification/runtime.

## Provider outage

Trigger: provider error ratio/latency or repeated dependency failures. Inspect correlated provider spans and persisted authorized run errors; distinguish network/5xx from authentication and quota. Pause affected live schedules; route only policy-authorized eligible calls to a configured fallback. Respect partial-stream and uncertain external-write boundaries. Do not force-retry billable calls without budget reservation/reconciliation. Recover by a capability probe, one controlled run, then gradual resume and backlog observation. Rehearsal injects 503, verifies sanitized errors and retry/error metrics; it does not validate a live provider fallback.

## Quota exhaustion

Trigger: rate/budget code or provider 429. Stop new billable work for the affected connection/workspace, inspect authoritative reservations and configured provider/account limits, and preserve queued/waiting work. Honor bounded retry-after and jitter through runtime policy; do not raise budgets or purchase quota automatically. Operator-approved credential/account changes need a capability probe and recorded spend limits. Rehearsal injects 429 and records a normalized code; real funding, rate-window and concurrent-budget semantics await security/runtime tests.

## Database/queue outage

Trigger: readiness 503, dependency alert, queue errors. Liveness should remain responsive. Stop intake/drain workers; identify database availability, connection limits, locks, volume capacity and Redis persistence/noeviction before restarting. Do not delete Redis or duplicate jobs manually. After recovery verify restricted role/schema readiness, outbox reconciliation and fenced run ownership. A lost Redis delivery must be recreated from authoritative state; uncertain actions require reviewer reconciliation. Rehearsal stops actual database/queue containers independently, checks readiness failure and liveness success, and restarts them. Full outbox replay/reconciliation is runtime-owned.

## Worker crash

Trigger: failed scrape, stale heartbeat, missing throughput or container exit. Keep API live, inspect sanitized exit/resource indicators, then restart worker with its existing queue namespace. Verify lease-generation fencing and runtime stale-job recovery before accepting business-state claims. Never mark an uncertain write safe solely because a worker restarted. Rehearsal sends SIGKILL, holds worker stopped, enqueues reference-only work and restarts; completed output is synthetic. Mid-action crash safety belongs to runtime acceptance.

## Disk exhaustion

Trigger: free disk <1 GiB or ENOSPC. Stop ingestion and intake, preserve database/vault data, examine volume and log sizes, increase approved capacity or remove only expired verified backup/log artifacts under retention policy. Do not delete database/WAL, Redis AOF, unknown object data or keys. Check filesystem integrity and restart dependencies only after space is available. Rehearsal fills the API's bounded tmpfs, captures a sanitized storage failure, removes only its fixture, and verifies recovery. Host-volume exhaustion remains a dedicated infrastructure drill to avoid damaging this host.

## Stuck jobs

Trigger: oldest queue age >120s, no progress, active jobs with expired leases. Identify whether workers are absent, capacity is saturated, dependency/budget backoff is active, or a human checkpoint is waiting. Inspect authorized run/action ledger, not just Redis state. Resume workers/dependency or make the existing approval decision; safely reconcile expired leases through runtime tooling. Never reset a lease generation or replay ambiguous external actions by hand. Rehearsal observes actual BullMQ waiting age while workers are stopped, then restarts them. Business dead-letter repair command is an integration requirement.

## Failed migration

Trigger: explicit migration command exits nonzero or readiness schema/version fails. Leave traffic on the previous compatible release or stopped. Verify checksum history, lock timeout, database extension and candidate compatibility. Transactional failed migration should leave no new objects/version row. Fix by a new reviewed append-only migration, not editing applied history. For an incompatible partially applied external/manual migration, restore the pre-upgrade snapshot in isolation. Rehearsal creates a table then executes invalid SQL under the actual migrator and asserts the table is rolled back.

## Credential compromise

Trigger: leaked provider/storage/vault material or anomalous authenticated activity. Revoke the compromised provider/connector token at its issuer and stop affected automation. Revoke sessions/application tokens under security tooling and rotate scoped credentials. Preserve incident metadata privately. Vault-key compromise requires security's re-encryption/rotation protocol, retention of old decryption dependencies for valid backups, separate backup-key rotation and re-sealed snapshots. Do not destroy sole old keys before restore verification. Rehearsal proves a wrong backup key fails authentication and a wrong vault key cannot decrypt restored credentials; recovered key material from the encrypted snapshot restores decryption. Issuer revocation and production re-encryption are security integration gates.

## Restoration

Trigger: corruption/host loss or recovery rehearsal. Identify the newest independently verified archive and its exact image/schema, backup-key escrow and all vault key versions. Provision isolated empty targets, block external side effects, restore database/objects transactionally where possible, then re-provision keys and reviewed roles. Validate counts, IDs, vectors, object SHA-256 and actual credential decryption before promoting. Rebuild queue references from PostgreSQL and reconcile uncertain actions. Measure from isolated-target creation through restored application readiness plus integrity success. The report records this measured small-fixture duration and snapshot timestamp; it is not an estimate for a larger deployment.

## Rollback

Trigger: candidate fails readiness, migration or representative flow. Stop candidate intake, capture sanitized diagnosis, restore the recorded image if schema compatibility is proven, otherwise follow restoration with the pre-upgrade archive/image. Verify health, credentials, vectors, blobs, waiting approvals and a controlled run before traffic. Disclose lost writes since the chosen snapshot. The integrated harness rebuilds application commit 555a53c on the current hardened base, verifies it against the restored current schema, and returns to the candidate. Count this as evidence only when the exact-commit report records the prior-code rollback drill as passed. Migrations are not reversed; a physical cross-libc PostgreSQL volume upgrade is unsupported.

## Escalation and closure

Page the configured authenticated Alertmanager receiver for persistent critical conditions. The shipped receiver is deliberately empty: configuring and exercising real delivery is required. Close an incident only after integrity checks, dependency readiness, resumed bounded throughput and a fresh off-host verified backup. Record uncertain actions requiring manual review separately; do not erase them to make queue metrics green.
