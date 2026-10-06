# Five reproducible business journeys

These examples use Relay's implemented graph kinds and REST/tool adapters. All supplied documents and payloads are synthetic. A fixture model proves execution and protocol behavior; it cannot prove grounded answer quality. Live model runs need a tested, funded connection and consume quota. Preview is deterministic; direct retrieval and tool nodes still execute real actions.

## Setup

1. Build/start the local application in a disposable data directory, or use the coordinator's isolated integrated deployment. Register an owner. Keep the session cookie private.
2. In Model connections, save and test a connection. Copy its ID from the authorized API response. Give examples a synthetic workspace; scoped documents in the local product mean workspace and collection scope. Document-level restrictions require the knowledge/security production implementation and conformance suite.
3. Choose an authorized read endpoint returning public evidence and a disposable write endpoint. For fixtures, run `npm run acceptance:fixture` in another terminal: `/research` returns synthetic JSON; `/action` records a synthetic write; `/diagnostics` exposes only fixture observations. Keep this service on a test network. Hosted model simulation and local HTTP actions are not native live connector validation.
4. Set the following environment variables privately; no actual cookie or credential belongs in Git:

```powershell
$env:RELAY_EXAMPLE_ORIGIN = 'http://127.0.0.1:4311'
$env:RELAY_EXAMPLE_WORKSPACE = '<authorized synthetic workspace ID>'
$env:RELAY_EXAMPLE_COOKIE = '<your synthetic session cookie>'
$env:RELAY_EXAMPLE_CONNECTION_ID = '<tested connection ID>'
$env:RELAY_EXAMPLE_RESEARCH_URL = '<authorized read evidence URL>'
$env:RELAY_EXAMPLE_ACTION_URL = '<authorized synthetic action URL>'
$env:RELAY_EXAMPLE_DISPOSABLE = 'yes'
# Only for a permitted local test connection:
$env:RELAY_EXAMPLE_ALLOW_PRIVATE = 'yes'
node examples/business/setup.mjs
```

Setup creates one collection, two tools and five draft workflows. It does not start a run, create a schedule or publish an application. Wait until ingestion shows `ready`, inspect tool endpoints/approval policy and save the drafts before following these journeys. The setup script is additive; rerunning creates fresh examples.

## Internal knowledge assistant

Ask: “What is the maximum hotel reimbursement rate for the North team?” The collection contains `travel-policy.md`. A live answer should state **180 CAD per night**, identify the current policy, and cite the supporting passage. The 150 CAD value is explicitly archived. Each factual claim needs evidence; a relevance score is not confidence.

Ask about an absent meal allowance: the assistant should acknowledge insufficient evidence. A different workspace must not retrieve these passages. Delete the source and repeat retrieval: active results must disappear. The quoted instruction to grant access/submit a purchase must not authorize an action. Independent human review is necessary to establish model behavior against this injection; the fixture suite establishes only that retrieval itself cannot execute tools.

Limits: normal text-based files are supported locally; scanned documents need extraction/OCR support. Collection/workspace scope is proven locally; restricted-document policies are production-gated. Retained run evidence can remain after active-source deletion under the configured retention policy.

## Research using internal and external evidence

Ask about North travel reimbursement. The graph retrieves internal evidence and calls the configured read endpoint in parallel, joins both outputs, then asks the model to compare them. Inspect the `report` step input: it must contain both cited internal policy and external source data. A live report should distinguish internal policy from external claims, identify sources/dates and flag missing or conflicting information.

Failure cases: unreachable external service, changed response shape, empty retrieval, provider quota or authentication failure. Diagnose the failing step rather than presenting fixture prose as a researched answer. Public webpage text and URLs are untrusted; network policy still applies. A read endpoint supplies public text/JSON; arbitrary “web research” or native vendor connector availability is not assumed.

Limits: external information can be stale, unavailable or misleading. Validate the actual provider/endpoint with authorized real calls before claiming that integration works. A frozen tool configuration retains its endpoint, while credential rotation can affect future calls.

## Approval-controlled external action

Input: `{"message":"Reviewed synthetic purchase","amount":42}`. Run the workflow. It must wait before the HTTP POST. Open Run history or the builder's Activity inspector, review the tool name and exact arguments, then approve or reject. Approval should perform one reviewed action; rejection should perform none. A viewer must not approve. Restart while waiting and review the same arguments afterward.

Failure cases: stale/unauthorized decision, changed credentials, timeout, or lost response after the receiving service accepted the write. An uncertain write must not replay automatically; reconcile with the external service before retrying. Cancellation cannot undo an accepted write.

Limits: this is a real HTTP tool with `requireApproval:true`; it is not an email/Slack/GitHub connector. Provider idempotency can reduce duplicate effects but cannot establish universal exactly-once remote execution. Production reviewer policies and hashes must pass the service conformance suite after integration.

## Durable scheduled workflow

In Operations, create a weekday `0 9 * * 1-5` schedule with timezone `America/Toronto` and input `{"period":"October","summary":"Pilot ready for review"}`. Select the scheduled example workflow and Preview mode. Expected output: `Operations brief for October: Pilot ready for review`. Check next occurrence, last run ID and run outcome; pause it, restart, and confirm it remains paused. Delete the synthetic schedule after rehearsal.

Failure cases: invalid cron/timezone, unavailable workers, downtime, or provider limits for a live variant. Downtime catches up one overdue occurrence rather than replaying every missed occurrence. The local acceptance suite checks schedule persistence; the failure drill makes a synthetic schedule five minutes overdue and verifies two workers enqueue exactly one run. Production due execution/recovery still needs the integrated deployment rehearsal.

Limits: the example uses a deterministic transform so scheduling can be tested without model charges. It does not pretend to perform external research. Live schedules and configured tools consume provider quota and can cause external effects. Record actual worker/queue dependencies and deployment topology for production qualification.

## Published API workflow with scoped credentials

Publish the saved greeting workflow from Applications as a private Preview application. Copy the once-shown application token into your private client configuration. Invoke `POST /api/apps/{id}/invoke` with the application Bearer token and `{"input":{"name":"Ada"}}`. Expect HTTP 202 and a durable run ID; status/stream access must stay within that application. Expected final output: `Hello Ada`.

Edit the draft greeting to `Goodbye {{name}}`: the published application must continue returning `Hello Ada` until explicit republication. Another application's token must not read this run. Rotate the token: the old token must immediately stop invoking the API. Delete the example application when done.

Failure cases: missing/revoked token, foreign application token, invalid payload, incomplete graph, or an unavailable referenced model/tool in a live variant. Publishing inside Relay does not deploy a public service. API response time excludes asynchronous workflow completion; measure both separately.

## Verification

`npm run test:acceptance` executes all five graphs with actual backend adapters and synthetic provider/action fixtures. `npm run test:browser` covers the business UI, publication, tools/approval, knowledge, scheduling configuration and account controls. The fixture answer is intentionally “Synthetic fixture answer”; correct real-model prose, citations, native connectors and production durability remain separate live/integrated gates. See [verification instructions](../../docs/production/VERIFICATION.md).
