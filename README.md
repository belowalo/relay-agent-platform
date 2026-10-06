# Relay

Relay builds and runs agent workflows, private knowledge assistants and approval-controlled automation. The six production branches are integrated on `codex/production-integration`. Production qualification remains gated by the evidence recorded in [the integration handoff](docs/production/handoffs/integration.md); do not infer readiness or supported capacity from a feature list.

## Production architecture

The production profile uses PostgreSQL/pgvector with forced tenant RLS, separate application/identity/rate/dispatch roles, a transactional outbox and Redis/BullMQ, shared S3 documents, offline CPU embeddings and an isolated PDF/DOCX parser. API instances and workers share authoritative database state. Credentials are encrypted and scoped to connection/version; workflows freeze tool and child-workflow configuration. Exact approvals and fenced action ledgers prevent automatic replay of uncertain writes. Remote exactly-once execution is not promised.

Production supports authenticated workspaces, roles, invitations, password/MFA controls, visual workflows and revisions, durable runs and schedules, collection ingestion/retrieval, extractive cited answers, private application API tokens, deterministic evaluations and prompt revisions. Native GitHub, Slack, Drive, S3, PostgreSQL, REST and MCP adapters are implemented; live vendor support is qualified separately for each configured endpoint/account. GitHub, Drive and S3 document synchronization uses durable checkpoints and queued ingestion.

Supported production publication is a private asynchronous API. Public chat, widgets, application webhooks and published MCP channels are not enabled. Production model fallback/caching, LLM judging, automatic history deletion, OCR/transcription and hosted reranking are not advertised. Details, limits and installation commands are in [the integrated operating guide](docs/production/INTEGRATED-RELEASE.md).

## Local development

```powershell
npm ci
npm run dev
```

Open [the local UI](http://127.0.0.1:5173). This default uses SQLite and a local worker. Existing ignored `data/` and `.env` files stay private. It is a development profile and has additional local features described in [the local guide](docs/LOCAL-DEVELOPMENT.md). `npm run build` builds the UI; `npm start` alone does not provision production infrastructure.

## Qualification

```sh
npm run check
npm run test:acceptance
npm run test:failure
npm run test:browser
# Disposable Linux Docker host; builds and exercises the actual production stack:
node bin/production-qualify.mjs
# One-hour actual-container workload, with separately labeled protocol fixture model:
PRODUCTION_SOAK=true node bin/production-qualify.mjs
```

CI checks out the exact integration head. Artifacts separate actual production deployment evidence, infrastructure-only drills, synthetic protocol tests and live-provider quality. [Release targets](docs/production/ACCEPTANCE.md) are not capacity claims. A blocked release gate keeps the PR unmerged. The public source is [belowalo/relay-agent-platform](https://github.com/belowalo/relay-agent-platform).
