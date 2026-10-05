# Verification handoff

- Foundation: `76649286b51b39924261a876878efebf5e02f020`.
- Branch: `codex/production-verification`, isolated managed worktree. Exact final SHA is reported in chat after commit/push.
- No other developing team branch was merged. Main and the user's active database were not modified.

## Delivered

`tests/acceptance/**`: isolated HTTP journeys; executable five-example checks; local restoration after post-backup mutation; exact agent-selected approval/restart/rejection; strict integrated service conformance; frozen fifty-case live-quality runner and independent results-bound review scorer. Missing human review remains blocked.

`tests/load/**`: smoke/load/one-hour soak profiles, open-loop API/retrieval traffic, bounded concurrent Live protocol-fixture clients, overlapping ingestion, auth/rate/server/partial-stream faults, fixture/application latency separation, percentile/error/throughput/queue/resource manifests and explicit release-gate interpretation. The local failure drill uses separate workers, process death, lease recovery, response loss after a write, cross-process cancellation and a two-worker overdue schedule.

`tests/fixtures/business/**`: synthetic policies with archived/conflicting evidence and untrusted instructions, research brief and fifty frozen held-out questions/sources. Real-user document quality and native integrations require separate authorized live evidence.

`examples/business/**`: five executable graphs, additive setup script, expected outcomes, setup/failure/limit guide. Research joins actual internal and external outputs; the action tool has a real approval requirement; scheduling/published examples use transforms so operators can rehearse without model charges.

`src/**`: onboarding completion reflects actual collection/connection presence; Preview/Live/tool semantics are visible; connection test errors persist with actionable guidance; string/v1 structured errors render with correlation IDs; ingestion has real progress; source/chunk/version/method/score inspection is accessible; run diagnostics and waiting approval are visible; both inspectors show exact arguments and handle stale/error decisions; publication displays draft/published revisions; modal focus/Escape/return, field hints, keyboard run-inspection buttons, focus outlines and mobile wrapping improve accessibility.

## Verified on this branch

- `npm ci`: existing locked dependencies installed; audit reported zero vulnerabilities.
- `npm run foundation:types` and `npm run build`: passed.
- `npm test`: 48 passed, 2 live PostgreSQL/Redis tests skipped, 0 failed. Actual local CPU embedding inference passed; hosted models are fixtures.
- `npm run test:acceptance`: 11 passed, 0 skipped/failed.
- `npm run test:failure`: 1 passed test containing four scenarios; shared-host local evidence only.
- `PLAYWRIGHT_PORT=15377 npm run test:browser`: 11 passed, including keyboard focus, structured errors, mobile citation inspection and existing business journeys. Browser screenshots/report are ignored artifacts.
- `npm run test:load:smoke`: 20 seconds after 5 seconds warm-up, four concurrent clients, 20 documents / **320 actual chunks**, 10 API and 2 retrieval requests/sec plus ingestion/model faults; zero unexpected errors/lost jobs. Sanitized preliminary evidence is in `docs/production/evidence/VERIFICATION-SMOKE.json`. It identifies its dirty starting snapshot, not an integrated release. Exact-commit reruns are reported in chat and ignored machine artifacts.
- `npm run format:check`: passed. No dependency additions; package scripts changed only.

Strict prerequisite rejection was exercised: `test:services` rejects missing disposable PostgreSQL/Redis URLs; `test:acceptance:services` rejects a missing disposable integrated adapter; `test:acceptance:live` rejects missing live-call authorization/configuration. These nonzero prerequisites are blocked gates, not passed integration.

## Integration requirements

1. Integrate other teams first as specified in `OWNERSHIP.md`, then this branch. Preserve public API shapes or reconcile deliberate versioned changes with these tests/UI. No developing branch was declared integrated or passed.
2. Merge `package.json` script additions and retain other teams' commands. Regenerate lockfile only if combined dependency requirements change. No migrations/backend files were changed here.
3. Supply the real coordinator-owned `ACCEPTANCE_ADAPTER` described in [VERIFICATION.md](../VERIFICATION.md). It composes actual ports and disposable setup/recovery helpers; absence fails. Validate restricted roles, document ACL/versioned citations, atomic budgets, duplicate delivery, import/restore and two-host deployment. Fixture attestations cannot pass service gates.
4. Operations reports `test:operations`, `operations:qualify`, `operations-results/report.json`, `/health/live`, `/health/ready`, Bearer `/metrics`, and configurable `OPERATIONS_PORT`, `OPERATIONS_TLS_PORT`, `OPERATIONS_RESULTS`, `OPERATIONS_KEEP`. Integrate its composition hooks and run its commands. Infrastructure qualification with `runtimeIntegrated:false` cannot establish full domain/multi-host release gates. This branch has not validated its developing code.
5. Configure isolated two-host/two-API/two-worker PostgreSQL/pgvector/Redis/shared-object-storage staging, network-reachable protocol fixtures and whole-fleet monitoring. Run target load/one-hour soak. Small smoke results do not pass P01–P04 for that profile; reports expose separate `releaseGates`.
6. Run the security team's complete sensitive-endpoint/SSRF/upload/publication/key/OIDC/budget matrix and runtime stale-fence/actor-revocation checks. Local approval bodies retain `nodeId,approved,feedback`; runtime/security enforce exact action/hash/reviewer policy. If the integrated endpoint requires IDs/hashes, return the frozen decision fields and reconcile both UI handlers/API tests. V1 semantics were not independently redefined.
7. Configure tested funded models and authorized native services; run fifty held-out live answers and independent human review, then separately qualify real formats/extraction, insufficient/conflicting/adversarial evidence and native actions. Keep real documents/credentials outside Git.

## Shared changes and limitations

Shared files: `package.json` scripts; `.gitignore` verification artifacts; `playwright.config.ts` configurable local port/data directory or external origin and JSON reporter; `tests/browser/publishing.spec.ts` derived widget origin; README/verification documentation links. Verification owns TSX/CSS edits. Foundation contracts, acceptance targets, ownership, backend and migrations are unchanged. Compatibility improvement: UI accepts legacy string and structured errors so runtime can serialize v1 errors without breaking display.

External API journeys omit local process-kill/filesystem restoration; integrated fault/restore suites remain mandatory. Legacy regression ports remain fixed—run that suite serially across worktrees. `PLAYWRIGHT_BASE_URL` explicitly targets an external deployment and creates synthetic data there. Production conformance, target corpus/soak, multi-host durability, native live connectors, provider/OIDC/SMTP and independently reviewed quality remain blocked/pending. The coordinator owns the release verdict. No main merge, external deployment or private-data publication occurred.
