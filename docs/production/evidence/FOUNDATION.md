# Foundation verification evidence

Scope: shared Chat 1 infrastructure and contracts, not integrated production qualification. Baseline application: `420beb3437480cda793b540fd13b0c22960e6a3b`. This record is shipped with the final foundation revision; GitHub Actions associates each verification run with its exact SHA.

## Local checks

- Node.js 22.16, Windows, isolated managed worktree under `.codex`.
- Production React build succeeds; foundation declaration type check succeeds with the repository's TypeScript 7 compiler.
- Existing 39 backend tests passed in the full regression run; initial seven foundation tests also passed. Nine final foundation tests cover production configuration, async tenant isolation, credential binding/rotation, queue/connector/citation envelopes, scoped immutable blobs, public error handling, pinned transaction rollback, Redis outage normalization and pre-SQLite production entry-point rejection.
- The ordinary local backend command skips the two external-service tests when test services are not configured. `npm run test:services` instead fails when either required test URL is absent; skipped checks are not represented as live validation.
- Browser regression exposed an Express absolute-path/dotfile issue in managed worktrees. Anchoring the fallback filename to its trusted `dist` root fixed it; all eight browser tests passed against the corrected source (53.2 seconds). The public hosted chat/API/cross-origin widget journey also passed separately after the fix.
- Formatting and `git diff --check` pass. Production dependency audit reports zero known vulnerabilities at the time of the check; this is not a security audit or certification.
- The initial publication scan checked 107 tracked files against actual private credential values in memory: zero private runtime paths and zero credential matches. Private databases/env files were not copied into the worktree or Git.

## Actual infrastructure checks

GitHub service job on foundation implementation commit `183db160dd3cc5d7ea8c701ef1ef12b3b5f85b57`: [run 37264732340](https://github.com/belowalo/relay-agent-platform/actions/runs/37264732340), successful application and `foundation-services` jobs. The final branch CI reruns the same qualification on its exact head.

- PostgreSQL 16 service image with actual pgvector extension; migration applied and repeat application is a no-op.
- Restricted, non-owner application role; privileged-role rejection.
- Workspace row isolation, foreign insert denial, pooled transaction context reset.
- Transaction rollback removes an enqueued job; same-ID changed-content enqueue is rejected.
- Failing migration rolls back schema changes; checksum drift is rejected.
- Redis 7.4 and BullMQ 6.3.11 deliver actual jobs to a worker, suppress duplicate IDs while retained, reject extra secret-bearing fields and shut down cleanly.

These checks do not prove a distributed business runtime, provider integration quality, deployment readiness, backup restoration or load capacity. Their assigned teams must implement and qualify those systems. The outbox dispatcher and business fencing are not supplied by queue duplicate suppression.

## External bounds

The local Docker engine was unavailable, so no local container deployment is claimed. No external application deployment, paid resource or successful hosted-model reasoning call was performed by Chat 1. Existing user data and the active `main` checkout were left intact.
