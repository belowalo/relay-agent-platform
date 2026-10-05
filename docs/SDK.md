# Use a published workflow

Publish a workflow in **Applications**, copy its application ID and one-time token, and use the URL of your Relay server. Application tokens are different from model provider keys. All API and MCP calls require the application token, even when public chat is enabled. Tokens rotate in the Applications page.

## JavaScript

```js
import { RelayClient } from './sdk/javascript/relay.mjs';
const relay = new RelayClient({
  baseUrl: 'http://127.0.0.1:4311',
  applicationId: process.env.RELAY_APP_ID,
  token: process.env.RELAY_APP_TOKEN,
});
const queued = await relay.invoke({ question: 'What do our documents say?' });
const result = await relay.waitRun(queued.id);
console.log(result.status, result.output);
```

Use `relay.events(id, {after, signal})` as an async iterator for stored and live events. Use `getRun` to inspect status, steps, output, and usage. Waiting for approval returns `waiting`; make the decision inside Relay, then call `waitRun` again. A client timeout leaves the server run active.

## Python

Add `sdk/python` to your module path; no third-party package is needed.

```python
import os
from relay import RelayClient
relay = RelayClient('http://127.0.0.1:4311', os.environ['RELAY_APP_ID'], os.environ['RELAY_APP_TOKEN'])
queued = relay.invoke({'question': 'What do our documents say?'})
result = relay.wait_run(queued['id'])
print(result['status'], result['output'])
```

## Command line

Set `RELAY_BASE_URL`, `RELAY_APP_ID`, and `RELAY_APP_TOKEN` in your environment. Keep tokens out of command arguments and committed files.

```sh
node bin/relay.mjs invoke --file input.json --wait
node bin/relay.mjs status RUN_ID
node bin/relay.mjs events RUN_ID
```

The command returns exit code 1 on request errors, failed runs, or cancelled runs. A waiting run returns its status for a human to review. Example `input.json`: `{"question":"Summarize our onboarding process"}`.

## MCP

Configure your MCP client's **Streamable HTTP** transport with:

```json
{
  "url": "http://127.0.0.1:4311/api/apps/YOUR_APPLICATION_ID/mcp",
  "headers": { "Authorization": "Bearer YOUR_APPLICATION_TOKEN" }
}
```

`invoke_workflow` starts the frozen published workflow with an `input` and optional `conversationId`. `get_run` accepts its `runId` and returns status and results. These tools use the application's configured preview or live mode, rate limits, and workspace isolation. They do not expose workspace administration or approval decisions. Each POST is stateless; GET and DELETE are not supported. The same API that serves the UI serves MCP, so reverse proxies must preserve Authorization and Accept headers.
