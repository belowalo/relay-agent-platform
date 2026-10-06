# Chat 1 handoff — foundation v1

Branch: `codex/production-foundation`. The exact frozen SHA is reported by the coordinator after CI finishes. All teams must fetch and record that SHA before starting. Do not start from `main` or a previously created team worktree containing unrelated changes.

## Starting each implementation chat

Use the existing Chat 2–7 prompts, plus: read the four production contract documents, this handoff, and your ownership row. Create an isolated managed worktree from the frozen foundation commit. Create your assigned `codex/production-*` branch inside it. Do not share or modify the active `E:/Users/belal/Documents/ChatGPT/orchestrator` checkout.

Use the Codex managed worktree tool when available, specifying `ref: origin/codex/production-foundation`. The tool may return pending; wait for its actual path before executing commands. If unavailable, a normal Git worktree is acceptable. Inspect existing branch/worktree state before creating one; never reset someone else's work.

Read first:

1. `docs/production/ARCHITECTURE.md`
2. `docs/production/CONTRACTS.md`
3. `docs/production/OWNERSHIP.md`
4. `docs/production/ACCEPTANCE.md`
5. `server/foundation/ports.d.ts` and relevant executable schemas/adapters.

## Commands

```powershell
npm ci
npm run foundation:config
npm run foundation:types
npm run test:foundation
npm run build
npm test
npm run test:browser
npm run format:check
```

Local application: `npm run dev` (4311 API / 5173 Vite); isolated worktrees need different ports and data directories if multiple servers run concurrently. Browser tests use 14322 and their own disposable directory; coordinate runs because the baseline fixed browser port collides between chats. Do not stop the user's active application or redirect tests at its private database. Verification should make test port allocation configurable.

Foundation infrastructure commands:

```powershell
npm run foundation:config
npm run foundation:migrate
npm run foundation:probe
npm run test:services
```

`foundation:migrate` requires explicit `MIGRATION_DATABASE_URL` for a disposable/staging database and is never an automatic application-start operation. `foundation:probe` requires a restricted `DATABASE_URL` role plus `REDIS_URL`. It reports dependency readiness and `runtimeIntegrated:false`; it is not an application health or production-readiness claim. `test:services` requires both test URLs and refuses to silently skip qualification. The PostgreSQL test database name must begin `relay_foundation_test`; the test creates disposable roles and applies only the shipped foundation migrations.

See `.env.production.example` for commented **nonsecret** configuration. Local development does not need model credentials for foundation tests. Production model/connector/OIDC credentials are requested only by the relevant teams and kept out of Git.

## Implemented foundation versus team work

The branch includes actual Postgres transactions/migrations, RLS outbox enqueue, BullMQ transport, versioned secret-envelope encryption, local blob storage, runtime validation and async context propagation. The original application's synchronous domain repositories remain local. Domain conversion, outbox dispatch/recovery, vector indexes, shared object storage, policy-authorized secret resolution, budgets, native connectors and observability exporters are assigned work, not finished features.

The foundation also fixes the SPA fallback in `server/index.js` to anchor `index.html` at its trusted distribution root. Absolute `sendFile` paths beneath hidden parent directories such as `.codex` were rejected by Express's dotfile handling, breaking hosted chat/widget pages in managed worktrees. Preserve this fix when converting the production bootstrap.

Docker CLI is installed on the inspected Windows host, but its Linux engine was unavailable during initial inspection. Infrastructure tests are also run using PostgreSQL/Redis GitHub CI services. Operations owns enabling and exercising a complete deployment; no paid resources or external application deployment were created by the foundation work.

## Integration responsibilities

Runtime: async domain conversion and production bootstrap, existing-data import, outbox dispatcher and fenced workers. Preserve local mode and all existing tests.

Connectors: native integrations/provider compatibility and production BlobPort. Route writes through runtime approval/action contracts; source sync through DocumentPort.

Knowledge: extraction/OCR/transcription, pgvector/full-text storage and authorized retrieval; implement DocumentPort behind shared contracts.

Security: identity/permissions, outbound policy, authorized SecretPort, key migration, budgets and production role review.

Operations: tested deployment, restricted-role provisioning, shared storage/backup, metrics/traces/alerts, CI and runbooks.

Verification: user-facing integration, independent acceptance/load/soak/quality suites, business examples and end-to-end evidence.

Every team pushes its own branch and supplies `docs/production/handoffs/<team>.md`. Coordinator integrates on `codex/production-integration`; `main` stays unchanged until the integrated release is reviewable and verified.
