# Team ownership and merge protocol

All teams start from the same frozen `origin/codex/production-foundation` commit in **separate worktrees**. Do not edit the user's active `main` checkout. Do not merge another team's changing branch into your own during development. Record the starting SHA and final SHA in your handoff.

| Chat / branch                     | Primary ownership                                                                                                                               | PostgreSQL migration range   | Integration seams                                                                    |
| --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------- | ------------------------------------------------------------------------------------ |
| 1 `codex/production-foundation`   | `server/foundation`, shared contract documents, initial tooling/CI                                                                              | `0001`–`0099`                | Frozen after handoff; coordinator resolves final shared changes                      |
| 2 `codex/production-runtime`      | `server/runtime/**`, engine/leases/schedules/maintenance/evaluations persistence, `server/db.js`, production bootstrap and async API conversion | `0100`–`0199`                | Auth/knowledge repository calls; usage reservations; telemetry; outbox dispatcher    |
| 3 `codex/production-connectors`   | `server/connectors/**`, provider/tool adapters, shared object-storage adapter, connector source synchronization                                 | `0400`–`0499`                | SecretPort, DocumentPort, action/approval runtime, usage reporting                   |
| 4 `codex/production-knowledge`    | `server/knowledge/**`, legacy knowledge/embedding/retrieval modules, document processing and pgvector repositories                              | `0300`–`0399`                | BlobPort, connector document ingest, security access policy, background jobs         |
| 5 `codex/production-security`     | `server/security/**`, legacy auth/security/network modules, identity repositories, credentials, authorization and budgets                       | `0200`–`0299`                | Runtime identity calls, restricted DB roles, secret resolution, outbound policy      |
| 6 `codex/production-operations`   | `deploy/**`, `server/observability/**`, deployment/backup scripts, health/telemetry adapters, operational CI                                    | `0500`–`0599` only if needed | Runtime draining, role provisioning, document/blob backups, test harness integration |
| 7 `codex/production-verification` | `tests/acceptance/**`, `tests/load/**`, fixture corpus, `src/**`, examples and user guides                                                      | None                         | Backend contracts and documented acceptance criteria                                 |

Ranges reserve unique append-only filenames, not permission to change previously applied migrations. Foundation `0001` includes the infrastructure outbox only. Runtime `0100` owns the initial PostgreSQL translation of legacy domain tables, preserving imported IDs and secret envelopes; security and knowledge extend their domains with subsequent migrations. New `relay` domain tables require RLS, proper references and indexes. Never port SQLite FTS virtual-table SQL directly to PostgreSQL.

## Shared-file changes

- `server/index.js`: runtime owns conversion/composition. Other teams expose route/middleware registration modules and document the required calls. A small necessary existing-route change is allowed on your branch but must be listed for reconciliation.
- `server/platform.js`, `server/catalog.js`, `server/tools.js`: runtime owns persistence/composition; connector/knowledge/security additions must use explicit adapters or explain shared diffs.
- `src/**`: verification owns product UI; other teams provide API examples, field requirements and error cases.
- `package.json` / lockfile: additions are permitted in isolated branches. Name requirements in handoffs. Coordinator merges manifest requirements then regenerates the lockfile with npm; do not choose a lockfile side blindly.
- `.github/workflows/**`: operations owns infrastructure/release workflow changes; verification provides commands. Preserve both baseline regression and foundation service tests.
- `.env.example`: operations composes settings. Other teams provide nonsecret examples in team docs. Never add actual key/password values.
- `docs/production/ARCHITECTURE.md`, `CONTRACTS.md`, `OWNERSHIP.md`, `ACCEPTANCE.md`: frozen boundary. Propose necessary amendments in your team handoff rather than independently redefining them.

Do not restructure unrelated modules or overwrite another team's domain. A required cross-cutting change should be narrowly scoped and clearly documented; worktrees permit reviewable conflicts, not automatic conflict-free integration.

## Handoff requirements

Each team writes `docs/production/handoffs/<runtime|connectors|knowledge|security|operations|verification>.md` with:

1. Foundation SHA, team branch, final commit (report final SHA in chat if embedding it would require another commit).
2. Implemented features versus interfaces still awaiting integration.
3. Exact commands and test evidence, including skipped/live checks.
4. Required composition calls, environment variables, migrations and dependencies.
5. Shared-file changes and proposed contract amendments.
6. Failure/recovery semantics and known security/operational limitations.
7. Missing credentials/infrastructure and actions needed to unblock them.

Teams push branches; they do **not** merge into `main`, deploy externally, change the active private database, or create paid resources without the relevant authorization. No credentials, user documents or private workspace exports in handoffs.

## Integration sequence

Coordinator creates `codex/production-integration` from the frozen foundation. Integrate runtime first, then security, knowledge, connectors, operations, and verification. This is an integration order, not an instruction to delay parallel development. Resolve dependencies/contract changes, run migrations on disposable services and qualify the combined system. Re-run affected suites after material fixes. Final release gates apply to the exact integrated commit, not the separate team branch results.
