# Verification evidence

Verified locally on Windows, October 4, 2026. Version 0.2 integration suite: 30 passing tests; browser suite: 7 passing journeys. Node.js 22.16, SQLite 3.49.1, React 19, React Flow 12, Express 5, Vite 8, TypeScript 7. Exact versions are recorded in `package-lock.json`.

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

Seven Chromium journeys pass against the production build, separate port, and separate test database:

1. Account → dashboard → canvas → edit → save → reload → preview → inspect output → upload knowledge → cited retrieval → publish locally → light theme.
2. Library node addition → undo/redo → clipboard copy/paste → disconnected-node validation → saved revision → restore → duplicate → undo → complete-graph validation.
3. Reusable credential creation without a model; secret omitted from cards and edit responses.
4. Empty proxy response during connection testing produces a useful error and resets the button.
5. Authenticated API run → completed result → public hosted chat → widget script on another origin → iframe interaction → workflow result.

6. Dataset creation/evaluation, case results, prompt reuse in an agent, scheduling/pause, Groq preset, MFA setup and recovery-code login.

7. Semantic collection creation/upload retrieves a medical paraphrase that keyword search misses; switching to hybrid restores semantic retrieval using the real local model.

The main and expansion journeys check JavaScript page errors. Screenshots are saved under ignored `test-results/`: `dashboard-dark.png`, `builder-dark.png`, `dashboard-light.png`, `widget.png`. Dashboard, canvas, theme, evaluation and operations screenshots are visually inspected. Metrics come from stored records; empty history is shown honestly.

## Unverified and bounded behavior

- No successful hosted-provider reasoning or billing verification; the authorized OpenAI connection reported exhausted API credits.
- Docker build and reverse-proxy deployment are prepared but untested here; nothing was published publicly.
- Semantic and hybrid search are implemented; vector ranking scans SQLite collections. No OCR, dedicated vector service or unrestricted crawler.
- Multiple execution workers on one shared host are verified; no PostgreSQL/Redis multi-host backend or production load qualification.
- External side-effect guards prevent automatic uncertain replay, not exactly-once remote execution.
- Recorded usage limits allow in-flight overshoot; they are not hard spending caps.
- Display queries bound historical rows/events while retaining underlying database history. No automated retention/purge scheduler.
- Invitations remain manually shared. MFA is verified locally; OIDC/SMTP recovery are fixture-verified and need live administrator configuration.

See the feature checklist for implementation coverage and deployment instructions for operational bounds. Relay is not claimed to match every production capability of Flowise, Langflow, or Dify.

## Expansion evidence

- Local CPU inference returns 384-dimensional embeddings without API credentials. A medical paraphrase ranks above an unrelated mechanical passage by more than 0.15 cosine similarity. The public model is cached; tests isolate their databases.
- Semantic/hybrid indexing retrieves paraphrases, rejects outsiders, and excludes deleted source vectors. A local embedding fixture validates the compatible API contract separately from actual local inference.
- Two separate worker processes share run capacity. Killing an owning process allows the surviving worker to reclaim the read and complete it with a higher generation. Cancellation arrives through the API process and remains cancelled after the remote delay. Eight writes execute eight times under competing workers; a due schedule creates one additional run atomically. This is bounded test evidence, not an exactly-once remote guarantee.
- Frozen datasets reveal a changed workflow's score regression, retain original cases after edits, and compare revision scores. LLM judging persists a real fixture-generated grade and includes judge tokens. Missing token prices remain unknown rather than reported as free. Prompt revisions reject stale saves; run feedback persists.
- MFA requires an authenticator/recovery code, rejects replay and supports one-use recovery. Password change invalidates old sessions. OIDC fixture verifies browser state, PKCE, signatures, nonce and returning identity. SMTP fixture receives a password-reset message; the one-use reset changes the password and invalidates sessions.
- Build/type checking and the full seven-journey Chromium suite pass. `npm audit` reports zero package vulnerabilities at the verified lockfile; this is dependency evidence, not a security audit.

No paid performance comparison or competitor-superiority benchmark was run. Docker, public deployment, production load qualification and live OIDC/SMTP configuration remain outside verified delivery.
