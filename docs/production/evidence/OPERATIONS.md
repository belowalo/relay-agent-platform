# Operations qualification evidence

Foundation: `76649286b51b39924261a876878efebf5e02f020`. Tested code: `050d9d6a6e09f53131b0c797fa157642ce4914c5`. [Operations CI](https://github.com/belowalo/relay-agent-platform/actions/runs/37282354663) and [baseline CI](https://github.com/belowalo/relay-agent-platform/actions/runs/37282354534) passed. Date: October 5, 2026.

The operational service is a synthetic infrastructure qualification harness. It deliberately reports `runtimeIntegrated:false` and cannot substitute for the integrated Relay release.

## Measured deployment and recovery

Linux x64 GitHub runner: 4 CPUs and 16766410752 bytes RAM. Application containers: UID 1000, read-only root, all capabilities dropped, 2 vCPU quota, 2 GiB memory and 256 PID limit. These allocations and tiny fixtures do not qualify target throughput or the larger acceptance corpus.

All 15 drills passed: clean image/service build, startup rejection, TLS/private exposure, API/job/provider/tool/retrieval trace correlation and redaction, provider/quota faults, real bounded tmpfs exhaustion, database outage, queue outage, worker SIGKILL/stuck queue, transactional failed migration, graceful shutdown, encrypted backup, wrong key, archive tampering, isolated restore and captured-image restart. Prometheus configuration and four alert rules passed promtool tests. TLS uses a test private CA; production DNS/certificate issuance and cookies await integration.

Recovery from empty database provisioning through integrity checks and API readiness took **14.683 seconds**. pg_restore plus object verification took 144 ms within that interval. Backup creation took 152 ms; encrypted archive size 10745 bytes, one object. Verified the completed synthetic database row, pgvector value, blob SHA-256 and actual AES-GCM credential decryption. An unrelated vault key failed; keys recovered from the encrypted snapshot restored successful decryption. A changed authentication tag and wrong backup key were rejected. Image rollback is a same-image restart against compatible restored state, not cross-version domain rollback.

Snapshot RPO target is <=1 hour only when the 45-minute schedule completes and independently verifies off-host copies within 15 minutes. Actual data loss equals the age of the latest recoverable snapshot; failed/missed backups invalidate the target. The tiny fixture had no writes after quiescence. No off-host service or escrow account was assumed. Buffered tooling is limited to 256 MiB aggregate and 32 MiB per object.

## Checks and artifact locations

Local: npm ci; npm run check (52 passed, 2 service tests skipped because no local daemon); foundation types; 4 operations unit tests; formatting/diff checks; shell syntax checks. CI: full build/regression, 8 browser tests, real PostgreSQL/RLS and Redis/BullMQ foundation service checks, npm audit, secret scan, container build/start/fault/restore checks, strict application-image scan and release artifacts.

The final distroless application image has **zero reported HIGH/CRITICAL vulnerabilities without ignoring unfixed findings** in this run. Image identity: `sha256:99bc09ffaeee7ef158ced3ff20300ae88bd88c0b4d876331d5d27cad5e324f7f`. The earlier Debian slim image produced fixed npm/PCRE findings and unfixed OS findings; it was replaced. This scan is time-specific and does not certify the platform. Separate infrastructure-image reports are collected for security review; remaining infrastructure findings must be triaged before production release.

Small evidence: operations-report.json, operations-traces.json and operations-metrics.prom in this directory. CI also publishes `operations-evidence-COMMIT` for logs, metrics, digests, SBOM and scanner JSON, and `production-operations-COMMIT` for the source deployment archive, importable app/proxy/backup images and SHA256SUMS. Artifacts expire after 14 days; preserve approved releases in your existing controlled repository. Exact final pushed SHA and its CI status are reported in chat.

## Remaining release gates

Actual production bootstrap/domain migrations and full schema readiness; runtime drain/action/outbox semantics; all composition hooks and authoritative aggregate metrics; legacy credentials and all key versions; scoped S3 and reviewed migration/backup/dispatcher roles; independent off-host backup/escrow/alert delivery; target two-API/two-worker topology, one-hour load and representative document corpus; true previous-release rollback; infrastructure-image vulnerability triage. See OPERATIONS.md, OPERATIONS-RUNBOOKS.md and the operations handoff.

Local Docker Desktop failed at its stale inference socket. Automatic approval review rejected removing the socket; it remains untouched. Actual container execution and restoration ran on GitHub's clean Linux runner. No external staging, paid infrastructure, main merge or private data export occurred.
