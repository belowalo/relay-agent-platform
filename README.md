# Relay

The production upgrade teams start from the frozen `codex/production-foundation` branch. Read the [foundation handoff](docs/production/HANDOFF.md), [architecture](docs/production/ARCHITECTURE.md), [shared contracts](docs/production/CONTRACTS.md), [team ownership](docs/production/OWNERSHIP.md), and [release gates](docs/production/ACCEPTANCE.md). This foundation is a buildable integration starting point; production domain/runtime conversion and release qualification remain assigned team work.

This branch adds the production knowledge subsystem: bounded ingestion, durable jobs/versions, pgvector retrieval and validated grounded citations. See [knowledge setup](docs/production/KNOWLEDGE.md), [integration handoff](docs/production/handoffs/knowledge.md), and [measured evidence](docs/production/evidence/KNOWLEDGE.md). Runtime/security/connector composition remains required before deployment; the local app below retains its development bootstrap.

A persistent local platform for building, running, publishing and evaluating teams of AI agents. Version 0.3 adds policy guardrails, approval gates for agent-selected tools, model fallback and encrypted caching, filtered/reranked retrieval, MCP publication, JavaScript/Python clients, a CLI, calendar schedules, and opt-in history retention.

The core features run locally. Full commercial parity is not claimed: multi-host infrastructure, a broad catalog of native vendor connectors, large-corpus vector storage and production load qualification remain gaps. An authorized OpenAI connection returned exhausted API credits; successful hosted-model reasoning still needs a funded or free-tier provider connection. Development preview is deterministic and labeled. Direct tool/retrieval nodes perform real actions even in preview.

## Start

Requires Node.js 22.16+ and npm. Tested on Windows. Node 22 may print an experimental SQLite warning.

```powershell
npm ci
npm run dev
```

Open [Relay](http://127.0.0.1:5173). Create an account to get a working Research studio graph and two reusable specialists. Existing accounts and data persist across upgrades. No default password is installed.

For the production build, stop the existing API server first, then:

```powershell
npm run build
npm start
```

Open [Relay production build](http://127.0.0.1:4311). The default database is `data/relay.sqlite`; keep `data/vault.key` with it when backing up.

## Build and run

Open a workflow, select an agent, and configure instructions, model, tools, knowledge, memory and limits. Connect nodes to establish data dependencies. Condition branches use `true`/`false` labels. Save a revision and run a task in Development preview or Live. Select a node or run bar to inspect streamed text, assignments, tool calls, outputs, usage and failures.

The canvas supports drag/drop, pan/zoom, minimap, selection, copy/paste, duplicate, undo/redo, validation, autosave, import/export and revision restoration. Components include input/output, orchestrators, specialists, models, tools, retrieval, conditions, parallel/join, bounded loops, approvals, transformations, policy guardrails and reusable workflows. **Test component** runs a saved component with a supplied payload and stores the real result. Human and nested checkpoints survive restarts.

Policy guardrails enforce character limits, JSON schemas and restricted phrases, or redact emails and exact phrases. They are explicit rules, not comprehensive AI moderation. Place them before models/actions or after generated text. Redaction changes the step's outgoing data; original input remains in run history and explicit `{{task}}` references. Agent instructions support `{{input.field}}` and `{{task.field}}`; missing variables fail instead of silently inserting empty text.

## Connect models and tools

In **Model connections**, use a quick provider setup for Groq, OpenAI, Anthropic, Ollama or LM Studio. Add your own key, save and test. Saved compatible connections can discover model IDs. Groq's preset uses `https://api.groq.com/openai/v1` and `openai/gpt-oss-20b`; account availability and quotas depend on the provider.

OpenAI-compatible endpoints use streaming `/chat/completions`; Anthropic uses streaming `/messages`. Specify the base URL and exact model offered by your provider. Local servers can omit a key if they allow it; administrators enable private network access per connection. Optional token prices provide estimates rather than guessed billing totals.

Credentials are encrypted on the server and omitted from API responses and workflow exports. Choose **Reusable API credential** for tool-only tokens.

In an agent's **Reliability & caching** settings, select ordered fallback connections. Eligible rate limits, server errors and network failures use the next connection's default model; authentication errors and partially streamed output do not fail over. Opt-in model caching lasts at most one day, is encrypted and workspace scoped, and is disabled when tools are assigned. Clear it in Model connections. Cache hits record zero new model tokens; fallback estimates use the actual connection's prices. Estimates exclude embedding, reranking and external tool charges.

Enable **Require a human decision** on a tool to gate direct and agent-selected actions. Inspect the exact arguments in the run inspector, then approve or reject. Model-selected calls persist before the checkpoint, so approval resumes the reviewed request without asking the model to select it again. Approval-protected tool tests create a reviewable run.

| Integration     | Supported execution                                                                        |
| --------------- | ------------------------------------------------------------------------------------------ |
| HTTP/custom API | GET/POST/PUT/PATCH/DELETE, interpolated URLs, JSON payloads, reusable credentials, schemas |
| Webpages        | Public text extraction with bounded responses and DNS/redirect checks                      |
| Search          | User-supplied JSON-enabled SearXNG endpoint                                                |
| Files           | Workspace artifact list/read/write/download                                                |
| Database        | Read-only SQL over workspace-isolated document data                                        |
| MCP             | Streamable HTTP discovery and calls through the official SDK                               |
| Webhooks        | Application triggers; outgoing actions through HTTP tools                                  |

Only implemented integration types appear as available. Custom tools are HTTP/schema adapters. They do not execute arbitrary host code or query remote databases.

## Knowledge and memory

Collections accept PDF, DOCX, TXT, Markdown, CSV, JSON and HTML uploads up to 15 MB. Same-origin crawling supports up to 20 linked pages and simple wildcard-user-agent robots exclusions. Index progress, errors, reindexing, deletion and source/chunk citations are visible.

Choose keyword, semantic or hybrid search. Local CPU embeddings produce 384-dimensional vectors; first use downloads model files, then embeddings work without API credits. Hybrid search combines semantic and FTS rankings. Collection API configuration can select an OpenAI-compatible embedding connection. Vectors currently rank by scanning a collection in SQLite; large corpora need dedicated vector storage. Scanned PDFs require external OCR.

Edit source metadata, then use **Retrieval controls** in Knowledge or a retrieval node. Supported controls include exact metadata filters, source IDs, source name fragments, per-source passage limits and semantic score thresholds. An optional workspace connection's `/rerank` endpoint uses the Cohere-compatible request/response contract; add a rerank model and optional score threshold. Hosted reranking is fixture-verified and needs your provider connection.

Agents support conversation and persistent memory. Inspect or delete it in Settings. Knowledge, vectors, memory, files and SQL data are workspace scoped.

## Quality and recurring work

**Evaluations** stores JSON datasets containing inputs and optional expected answers. Cases run against a frozen workflow revision. Rules can check exact answers, contained text, JSON schemas, execution success, latency and token limits. An optional live LLM judge scores a rubric; totals include judge usage. Execution success alone does not measure answer quality. Inspect case runs, export cases/results and compare evaluations using the same frozen cases.

**Prompt library** saves instruction revisions. Use **Use a saved prompt** in the builder to copy a revision into an agent. Library edits do not silently change workflows. Run inspection supports ratings and comments.

**Operations** shows worker capacity, queue states, seven-day success/latency/usage metrics and recent failures. Administrators choose minute intervals or five-field cron schedules with an IANA timezone, pause/delete schedules and inspect the last run. Advancement and enqueueing are atomic. After downtime, one overdue run starts rather than replaying every missed occurrence. Live evaluations and schedules consume provider quota and execute configured tools.

**Settings** offers completed-run history retention, disabled by default. Positive days enable bounded automatic deletion of expired terminal runs and their steps/events/action ledgers. Active execution trees and evaluation evidence are protected. Documents, artifacts and audit records remain; backups and SQLite free pages need separate retention policies. This is not forensic secure erasure.

## Accounts and permissions

Accounts use scrypt passwords and expiring HttpOnly, SameSite cookies. Workspace roles are owner, administrator, editor and viewer. Backend routes check membership and role. Invitations bind an expiring token to an email; share invitation links manually. Activity is recorded in audit history.

Open **Settings → security** to change a password or enable an authenticator with eight one-use recovery codes. MFA gates login with expiry, attempt limits and replay protection. Enabling MFA invalidates other sessions; password changes/resets invalidate sessions. Password resets retain MFA.

OIDC organization login and SMTP password recovery are configured through `.env.example`. OIDC uses code + PKCE, browser-bound state, nonce, signed tokens, verified email and optional domain admission. Password accounts are not automatically linked by matching email. Configure the provider callback as `PUBLIC_ORIGIN/api/auth/sso/callback`. Organization accounts initially use their identity provider; SMTP recovery can establish a local password. Real identity/email services need your configuration; local fixtures verify these implementations.

## Publish locally

Publish a saved workflow through **Applications**. Published versions freeze graph, tool and child-workflow configurations. Draft edits do not change them; republish explicitly. Model connections remain references, so deleting or rotating one affects future calls.

- Chat: `/apps/{id}`; widget snippets are provided in the application card.
- API: `POST /api/apps/{id}/invoke`; webhook: `POST /api/apps/{id}/webhook`.
- Status: `GET /api/apps/{id}/runs/{runId}`; streaming: append `/events`.
- API/webhook access requires the application Bearer token, shown once and rotatable.
- MCP: `POST /api/apps/{id}/mcp` exposes `invoke_workflow` and `get_run` over stateless Streamable HTTP, always token authenticated.

See [SDK and CLI examples](docs/SDK.md) for JavaScript, Python, command-line and MCP use.

```javascript
const response = await fetch('http://127.0.0.1:4311/api/apps/APP_ID/invoke', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Authorization: 'Bearer YOUR_APPLICATION_TOKEN' },
  body: JSON.stringify({ input: 'Your task', conversationId: 'session-id' }),
});
const run = await response.json(); // persistent run ID, 202 Accepted
```

The source repository is public at [belowalo/relay-agent-platform](https://github.com/belowalo/relay-agent-platform). Publishing an application inside Relay does not deploy it to a public server. Credentials, local databases and runtime data are excluded from Git.

## Workers and durability

The default server embeds one worker. For separate workers on one host, set `ENGINE_ROLE=api` for the API process and run `npm run worker` in additional terminals. All processes must share the same local `DATA_DIR` and encryption key. `WORKER_CAPACITY` limits active steps and `WORKER_NAME` labels workers; leave `WORKER_ID` unset for unique identities.

Run leases and generations fence ownership and asynchronous results. Safe interrupted reads recover after expiry. Human checkpoints survive downtime. Indexing has independent expiring ownership. Schedules and evaluations are persisted. SQLite WAL is a shared-host queue, not a distributed database or an NFS deployment.

External actions have a persistent ledger and idempotency keys. Uncertain side effects block automatic replay. Cancellation aborts active requests but cannot undo actions accepted by another service. There is no exactly-once remote execution guarantee. Interrupted model calls may be billed again on recovery. Recorded usage limits allow in-flight overshoot and are not hard spending caps.

Docker Compose provides an API and worker sharing a local volume; `docker compose up --build --scale worker=2` adds workers. Docker, HTTPS deployment and multi-host infrastructure remain unverified here. See [Deployment](docs/DEPLOYMENT.md).

## Verify and extend

```powershell
npm run check
npx playwright install chromium
npm run test:browser
```

Tests use isolated databases and local fixtures; they preserve your workspace. Semantic inference tests use the cached public embedding model. Screenshots go to ignored `test-results/`. See [Verification](docs/VERIFICATION.md), [Coverage](docs/FEATURE-COVERAGE.md) and [Architecture](docs/ARCHITECTURE.md).

Source lives in `src/` and `server/`; migrations live in `server/migrations/`. Catalogs and node/tool/provider registries support extensions. Test executors, schemas, cancellation and side-effect behavior when adding capabilities.
