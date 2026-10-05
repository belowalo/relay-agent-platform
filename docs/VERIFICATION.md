# Verification evidence

Release verification in October 2026 uses Windows locally and GitHub Actions on Ubuntu. Version 0.3: 39 passing integration tests and 8 passing browser journeys. Node.js 22.16 locally, Node 24 in CI, SQLite, React 19, React Flow 12, Express 5, Vite 8, TypeScript 7. Exact package versions are recorded in `package-lock.json`.

## Build and backend

`npm run check` performs TypeScript checking, a production bundle, and integration tests. Tests use isolated temporary databases and actual server processes, not the user's workspace.

| Journey               | Evidence                                                                                                                                       |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Document parsing      | Actual minimal PDF and DOCX files extract the expected source text                                                                             |
| Accounts and saving   | Registration, session cookie, workflow create/save/reload, revision snapshots, stale revision rejection                                        |
| Multi-agent run       | Persisted orchestrator plan, two recorded assignments, overlapping workers, downstream reviewer result                                         |
| Routing               | Selected true/false branch, skipped inactive branch, join collection, cyclic graph rejection                                                   |
| Approval recovery     | Waiting checkpoint survives shutdown/restart and resumes downstream execution                                                                  |
| Permissions           | Outsider cannot read workspace; invited viewer can read but cannot create/run/manage connections; email-bound invitation acceptance            |
| Knowledge             | Upload, chunk/index state, source citations, retrieval, reindex, deletion, cross-workspace rejection                                           |
| Database tool         | SQL runs against the isolated workspace documents data view                                                                                    |
| Publishing            | Draft change leaves published result unchanged; explicit republish updates it; authenticated API and webhook return actual runs                |
| Hosted access         | Public chat executes; private chat is token-gated; token rotation invalidates prior access                                                     |
| Provider adapters     | Local OpenAI-compatible and Anthropic fixtures stream text; function call loop, recorded usage, cost estimate and structured output validation |
| Tools and memory      | Assigned tool executes and returns results to agent; tool events recorded; persistent memory stored and inspected                              |
| Credentials           | No plaintext in connection response or workflow export; synthetic test credential absent from database bytes                                   |
| Loops/subflows        | Bounded iterations create persisted child runs and ordered outputs                                                                             |
| HTTP/search/web/files | Actual local HTTP, SearXNG-shaped search, HTML extraction, artifact write/list executors                                                       |
| Failures/cancellation | Useful missing-connection error; active cancellation; uncertain write called once with retry blocked                                           |
| Timeout/retry         | Slow read times out; safe failed read can retry; side effects remain guarded                                                                   |
| Nested approvals      | Parent suspends without an active worker; nested approval survives restart and resumes parent                                                  |
| Dependency snapshots  | Published child remains frozen after draft edit; another application cannot read its run                                                       |
| Durability            | Run history, audit and account session survive another restart                                                                                 |
| MCP                   | Official MCP SDK fixture successfully discovers and invokes a real Streamable HTTP tool                                                        |
| Network boundary      | Default private IPv4/IPv6, URL credential and non-HTTP rejection; cross-origin cookie-write rejection                                          |

A public GitHub API request through the production HTTP/DNS guard returned 200 for FlowiseAI/Flowise. An authorized OpenAI connection authenticated but reported exhausted credits. Successful hosted-model reasoning, external SearXNG and third-party MCP services remain unverified. Adapter contracts are verified locally. Exact model/provider options require an authorized real connection.

## Browser journeys

Eight Chromium journeys exercise the production build, separate port, and separate test database:

1. Account → dashboard → canvas → edit → save → reload → preview → inspect output → upload knowledge → cited retrieval → publish locally → light theme.
2. Library node addition → undo/redo → clipboard copy/paste → disconnected-node validation → saved revision → restore → duplicate → undo → complete-graph validation.
3. Reusable credential creation without a model; secret omitted from cards and edit responses.
4. Empty proxy response during connection testing produces a useful error and resets the button.
5. Authenticated API run → completed result → public hosted chat → widget script on another origin → iframe interaction → workflow result.

6. Dataset creation/evaluation, case results, prompt reuse in an agent, scheduling/pause, Groq preset, MFA setup and recovery-code login.

7. Semantic collection creation/upload retrieves a medical paraphrase that keyword search misses; switching to hybrid restores semantic retrieval using the real local model.

8. Guardrail component test redacts emails; restricted input fails; tool approval exposes exact arguments and resumes an artifact write; timezone-aware cron and history-retention settings persist. The semantic journey also checks metadata editing and filters. URL fragment navigation now updates the current page.

The main and expansion journeys check JavaScript page errors. Screenshots are saved under ignored `test-results/`: `dashboard-dark.png`, `builder-dark.png`, `dashboard-light.png`, `widget.png`. Dashboard, canvas, theme, evaluation and operations screenshots are visually inspected. Metrics come from stored records; empty history is shown honestly.

## Unverified and bounded behavior

- No successful hosted-provider reasoning or billing verification; the authorized OpenAI connection reported exhausted API credits.
- Docker build and reverse-proxy deployment are prepared but untested here; the source repository is public, while the running application remains local.
- Semantic and hybrid search are implemented; vector ranking scans SQLite collections. No OCR, dedicated vector service or unrestricted crawler.
- Multiple execution workers on one shared host are verified; no PostgreSQL/Redis multi-host backend or production load qualification.
- External side-effect guards prevent automatic uncertain replay, not exactly-once remote execution.
- Recorded usage limits allow in-flight overshoot; they are not hard spending caps.
- Opt-in history retention purges expired terminal runs while preserving active/evaluation execution trees. Artifacts, documents, audit and backups require separate retention.
- Invitations remain manually shared. MFA is verified locally; OIDC/SMTP recovery are fixture-verified and need live administrator configuration.

See the feature checklist for implementation coverage and deployment instructions for operational bounds. Relay is not claimed to match every production capability of Flowise, Langflow, or Dify.

## Expansion evidence

- Local CPU inference returns 384-dimensional embeddings without API credentials. A medical paraphrase ranks above an unrelated mechanical passage by more than 0.15 cosine similarity. The public model is cached; tests isolate their databases.
- Semantic/hybrid indexing retrieves paraphrases, rejects outsiders, and excludes deleted source vectors. A local embedding fixture validates the compatible API contract separately from actual local inference.
- Two separate worker processes share run capacity. Killing an owning process allows the surviving worker to reclaim the read and complete it with a higher generation. Cancellation arrives through the API process and remains cancelled after the remote delay. Eight writes execute eight times under competing workers; a due schedule creates one additional run atomically. This is bounded test evidence, not an exactly-once remote guarantee.
- Frozen datasets reveal a changed workflow's score regression, retain original cases after edits, and compare revision scores. LLM judging persists a real fixture-generated grade and includes judge tokens. Missing token prices remain unknown rather than reported as free. Prompt revisions reject stale saves; run feedback persists.
- MFA requires an authenticator/recovery code, rejects replay and supports one-use recovery. Password change invalidates old sessions. OIDC fixture verifies browser state, PKCE, signatures, nonce and returning identity. SMTP fixture receives a password-reset message; the one-use reset changes the password and invalidates sessions.
- Build/type checking and the full eight-journey Chromium suite pass. `npm audit` reports zero package vulnerabilities at the verified lockfile; this is dependency evidence, not a security audit.

No paid performance comparison or competitor-superiority benchmark was run. Docker, public application deployment, production load qualification and live OIDC/SMTP configuration remain outside verified delivery.

## Version 0.3 evidence

Nine additional runtime integration tests use a separate API process/database and actual local HTTP/MCP providers:

- Guardrails fail before an external action and validate/redact structured payloads.
- Rate-limited model fallback renders prompt variables and prices the actual connection. Encrypted cache hits cause no second provider call. Cache deletion restores calls. Authentication and partial streams never fall back.
- Source metadata/ID/name filters, semantic thresholds, per-source caps and the Cohere-compatible rerank contract select expected evidence.
- Isolated component tests bypass other graph nodes without changing the saved workflow.
- Explicit null expectations fail on incorrect output; incomplete JSON/latency/token evaluator rules are rejected.
- Calendar parsing crosses Toronto's daylight-saving change correctly; invalid zones/expressions are rejected. Retention is off by default, purges an expired run when enabled and preserves evaluation evidence.
- Tool approval survives an API restart, resumes exact model-selected arguments once and records the expected two model calls. Rejection performs no external write.
- JavaScript, Python, CLI and the official MCP SDK invoke real published runs. Streaming yields persisted completion. Foreign application runs, missing credentials and rotated tokens are rejected.

The public repository runs build/type checking, all integration tests, all browser journeys and formatting checks in GitHub Actions. Runtime data, provider credentials, model caches, screenshots and test databases are ignored by Git. A synthetic UI screenshot may be included explicitly in documentation; no user workspace screenshot is published.
