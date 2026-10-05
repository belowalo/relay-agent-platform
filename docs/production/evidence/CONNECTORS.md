# Connector verification evidence

Date: 2026-10-05 (America/Toronto). Branch: `codex/production-connectors`. Foundation: `76649286b51b39924261a876878efebf5e02f020`. Exact final commit is reported in chat. Windows host, Node/npm installed runtime; isolated worktree and disposable SQLite/browser data. No production database or external-write target used.

| Check                | Result                                        | Verification boundary                                                                                                                                                                                                                         |
| -------------------- | --------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Connector contracts  | Passed: 28 tests                              | Synthetic provider HTTP/SSE responses, real local SDK MCP HTTP/SSE/stdio servers, AWS SDK SigV4/XML fixture, embedded PostgreSQL engine, route validation, failure/permission/action/sync cases. No live Slack/Drive/S3/model/REST/MCP claim. |
| Embedded PostgreSQL  | Passed                                        | Executes 0400 DDL, RLS, connection/sync SQL, read-only queries and denied writes inside PGlite. Not TCP/TLS, pool, server-role provisioning or network cancellation verification.                                                             |
| Full Node regression | Passed: 76 passed, 2 service skips (78 total) | Two existing live PostgreSQL/Redis tests skip without service URLs. Uses RELAY_WORKER_TEST_PORT=24553. A subsequent final model fallback guard change was verified by rerunning connector and runtime suites.                                 |
| Browser regression   | Passed: 8/8                                   | Existing local product journeys; no new production connector UI/composition claim.                                                                                                                                                            |
| Build and types      | Passed                                        | Build, foundation declaration check, connector declaration check and local foundation config validation.                                                                                                                                      |
| Formatting           | Passed                                        | Repository format:check includes new connector directory.                                                                                                                                                                                     |
| Live GitHub reads    | Passed: 4/4                                   | Authorized keyring-backed reads: selected repository metadata, issues list, pull-request list, foundation README contents. No provider payload recorded.                                                                                      |
| Live writes          | Not performed                                 | No external messages/issues/comments/objects/SQL mutations were sent to test.                                                                                                                                                                 |
| Other live services  | Blocked                                       | No supplied Slack/Drive/S3/REST/MCP/model credential references; no PostgreSQL/Redis test URLs, Docker Linux engine unavailable.                                                                                                              |

Initial fixture timeout test needed a referenced test timer because AbortSignal.timeout is unreferenced by Node; fixed without changing application behavior. Initial model regression exposed legacy HTTP status compatibility; restored local HTTP 400 while keeping production normalized status. A subsequent worker regression collided with another process on the fixed baseline port; test-only override isolated the rerun. Final review added malformed-successful-write uncertainty coverage and partial tool-stream fallback coverage. These issues are preserved here so skipped/failed intermediate checks are not mistaken for live qualification.

Commands:

```powershell
npm ci
npm run foundation:config
npm run foundation:types
npm run connectors:types
npm run test:connectors
npm run build
npm run format:check
npm run test:browser
$env:RELAY_WORKER_TEST_PORT='24553'
npm test
node bin/connector-probe.mjs --github belowalo/relay-agent-platform
```

Acceptance C01/J02 remain partially blocked pending credentialed staging and integrated runtime/security/knowledge composition. Fixture and embedded-engine passes cannot close those live qualification gates.
