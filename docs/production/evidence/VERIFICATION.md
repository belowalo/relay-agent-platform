# Verification branch evidence

Foundation SHA: `76649286b51b39924261a876878efebf5e02f020`. All committed data is synthetic. Final commit and exact-commit checks are reported in chat; preliminary JSON records its actual pre-commit dirty snapshot.

## Local results

Build/types and formatting passed. Regression: **48 passed, 2 live service tests skipped**. New acceptance: **11 passed**. Browser: **11 passed**. Worker failure harness: **one passed test covering four scenarios** (read recovery after kill, uncertain-write retry denial, cross-process cancel, two-worker single overdue schedule).

The [sanitized smoke report](VERIFICATION-SMOKE.json) measures one API/embedded worker on Windows, SQLite/local storage, 20 synthetic documents / 320 indexed chunks, four active clients, five seconds warm-up and twenty seconds measurement. It records percentiles, rates, errors, queue states and resources. RSS grows during this short allocation period; it does not establish stable memory. One-hour stability is unverified.

Threshold checks apply only to that manifest. **Production gates remain blocked** because target topology, duration, corpus/rates were not exercised. Provider fixture service time and application residual are separately measured. Synthetic answers/usage cannot prove hosted reasoning or billing.

## Blocked integration/live evidence

- Foundation PostgreSQL/Redis: no disposable test URLs; strict command fails and optional baseline service cases skip.
- Production conformance: actual merged adapters/services are absent; strict command fails before service assertions.
- Target load/soak: requires integrated two-host/two-API/two-worker PostgreSQL/pgvector/Redis/S3 deployment and monitoring. Harnesses delivered, qualification pending.
- Real-model/document/native quality: requires funded providers, authorized services, private sessions, exact model provenance and independent review. No real-model calls were made here.
- Security, migration, recovery/deployment gates: require domain teams' integrated checks, real role/key/blob dependencies and timed rehearsals.

No developing team branch passed final integration. The [gate tracker](VERIFICATION-GATES.json) remains pending/blocked for coordinator qualification. Reproduction and composition are in [verification instructions](../VERIFICATION.md) and the [handoff](../handoffs/verification.md).
