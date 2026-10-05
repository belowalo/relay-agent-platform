# Production connector setup and operator guide

This branch implements connector/provider adapters and persistent synchronization state. Runtime, security and knowledge compose their owned ports at integration; this branch does not enable the production application bootstrap or replace the existing local connection UI.

## Installation and composition

Use Node 22.16+ and `npm ci`. Added production dependency: `@aws-sdk/client-s3`; added test-only dependency: `@electric-sql/pglite`. Apply append-only `0400-connectors.sql` through the foundation migration runner on an explicitly authorized database. Operations must grant the restricted application role SELECT/INSERT/UPDATE/DELETE on the three connector tables and USAGE on `relay`; table ownership and BYPASSRLS are prohibited. The migration has forced workspace RLS and composite workspace foreign keys. It stores configuration, credential references, cursors and document revision mappings, never plaintext credentials.

```js
import {
  connectorFor,
  validateConnectorConfig,
  createConnectionRepository,
  createSyncState,
  createDocumentSource,
  synchronizeDocuments,
} from './server/connectors/index.js';
import { registerConnectorRoutes } from './server/connectors/routes.js';

const connections = createConnectionRepository(database, {
  authorize: security.authorizeConnection,
  validateConfig: validateConnectorConfig,
});
const connection = await connections.get(verifiedContext, connectionId);
const connector = connectorFor(connection.kind, connection.config, {
  authorize: security.authorizeConnector, // verify current connection generation/config and actor permissions on EACH call
  secrets: security.secretPort, // shared SecretPort; current membership + version checks
  actions: runtime.connectorActions, // execute(context, intent, perform), described below
  outbound: security.connectorEgress,
});
const result = await connector.invoke(verifiedContext, {
  action: 'issues',
  input: { repository: 'acme/relay', since: '2026-10-01T00:00:00Z' },
  secretRef: connection.secretRef,
  signal: runAbortSignal,
});
```

The names `security.*` and `runtime.*` above are integration adapters, not exports supplied by this branch. Mount `registerConnectorRoutes(workspaceRouter, {contextFor, connections, portsFor})` from the runtime-owned bootstrap. `contextFor` must authenticate/authorize the request; `portsFor` must bind the connection's persisted generation and config hash. The routes expose GET capabilities, POST test and POST invoke under `/connectors/:connectionId`. Invocation JSON accepts only `{action,input}`; secrets/configuration/workspace/action keys come from authoritative services. Public errors use the new envelope, so mount these versioned routes where the UI supports that envelope. The legacy model routes keep their HTTP 400 compatibility.

## Runtime action integration

Every write descriptor requires approval. Without `actions.execute`, invocation fails before resolving a credential or sending an external write. Runtime receives immutable execution input, SHA-256 of canonical arguments, configuration hash, connector/version, credential reference and optional provider key. It must bind approval to the entire intent, current connection generation and reviewer authorization; persist `prepared/started/succeeded/failed/uncertain`; fence execution and refuse replay of uncertain writes. The `perform` closure is only for the trusted runtime adapter, never a route or model argument. Runtime generates action identities and idempotency keys; arbitrary invocation JSON cannot supply them.

GitHub and Slack actions declare no provider idempotency guarantee and receive one attempt. REST may declare a provider idempotency header; writes still receive one attempt and uncertain writes still require reconciliation. A lost response or HTTP 5xx following a write yields `outcome:'uncertain'`. Explicit provider rejections and validation failures yield known failure. Do not wrap the connector in an independent generic write retry loop.

## Configuration and scopes

Secrets are supplied only through `{workspaceId,connectionId,version}` and the security-owned encrypted vault. Ordinary API tokens are strings. The S3 and PostgreSQL credential formats below are JSON strings resolved in memory. OAuth consent, refresh, expiry, provider revocation and token persistence belong to the security credential service; these adapters consume the current access token. No OAuth client secret belongs in connector configuration.

| Connector     | Nonsecret configuration                                                                                                                                | Minimum provider access                                                                                                                                                                                                 | Capabilities and limits                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| GitHub        | `{repositories:['owner/repo']}`; optional HTTPS Enterprise API `endpoint`                                                                              | Fine-grained PAT/App token selected repositories: Metadata read, Contents read, Issues read, Pull requests read. Issues write for `create_issue`/`comment`.                                                             | `repositories`, paged `issues` with `since`, `pulls` sorted by update with client `since` filter, selected `document` contents (base64 API files <=1 MiB), approved issue creation/comments. `cursor` is a page string; `per_page` <=100. PR mutations are not implemented.                                                                                                                                                                                                                                                                                              |
| Slack         | `{channels:['C0123','G0456']}`                                                                                                                         | `channels:history` / `groups:history` plus membership in each selected channel; `search:read` with a token type supporting search; `chat:write` for approved actions. Provider/workspace policies may add requirements. | `history` with cursor and timestamp `since`; `search` requires selected `channel` and returns only matches from it; `post_message`, `update_message`, `delete_message`. Updates/deletes need a valid `ts` and appropriate authorship. DM history is excluded. Search/history have different scopes; a passing history test does not certify search/write scopes.                                                                                                                                                                                                         |
| Google Drive  | `{files:['id'],folders:['id'],exportMimeType:'text/plain'}`; at least one selection                                                                    | `drive.readonly`, or `drive.file` for files explicitly granted to the app and accessible selections.                                                                                                                    | Selected files/direct folder children; file download and Workspace export; `start_cursor` and `changes` pagination. Explicit input `fileId`; MIME can be text/plain, text/csv, PDF, DOCX. Choose a MIME supported by the selected native file type. No recursive traversal, shortcut dereference or writes. Shared-drive flags are set; restricted shared-drive policy still applies.                                                                                                                                                                                    |
| S3 compatible | `{bucket:'relay-docs',prefix:'docs/',region:'us-east-1',endpoint:'https://objects.example',forcePathStyle:true}`                                       | Source credentials: ListBucket restricted to prefix + GetObject restricted to prefix. No write grants needed. Secret JSON `{accessKeyId,secretAccessKey,sessionToken?}`.                                                | `objects` continuation pagination and `document` with optional ETag `IfMatch`; SDK SigV4/XML, 15 MiB downloads. Incremental revision skipping scans the prefix; there is no universal S3 change cursor.                                                                                                                                                                                                                                                                                                                                                                  |
| PostgreSQL    | `{host:'db.example',database:'docs',queries:{customers:'SELECT id,name FROM reporting.customers WHERE region=$1'}}`                                    | Secret JSON `{user,password}`. Dedicated nonowner role with explicit SELECT grants on chosen reporting views/tables; no superuser/BYPASSRLS. Security must authorize host/port/database.                                | `query` takes `{queryId,parameters}`. Administrator-configured SQL only; one SELECT/WITH, parameterized, bounded rows (default100/max1000), READ ONLY transaction, statement/lock deadlines and pg_catalog search path. Tables must be qualified. TLS validates certificates; install private CA trust via Node deployment settings. No write mode. Limit access to external-effect functions/extensions through role grants.                                                                                                                                            |
| REST          | See example below                                                                                                                                      | `none`, bearer, basic (`user:password` secret string), or API key (configurable header). Credential grants must match actions.                                                                                          | Named action input/output JSON schemas, path substitution, cursor/page/Link pagination. HTTPS endpoints, no redirects; Link cursors stay on the same origin AND action path. GET/HEAD are reads; all other methods are approval-required writes. No arbitrary caller headers/URLs/methods.                                                                                                                                                                                                                                                                               |
| MCP           | `{transport:'streamable-http',url:'https://mcp.example/mcp',auth:'bearer',readTools:['lookup'],writeTools:['create'],resources:['scheme://selected']}` | Selected server token, scoped to selected resources/actions. OAuth tokens supplied by SecretPort.                                                                                                                       | SDK initialization/version negotiation, paged filtered tools/resources, resource reads, schema-validated tool calls, cancellation, session cleanup. Explicit `sse` for legacy servers; no automatic transport fallback/replay. `stdio` requires administrator-authorized executable/args/cwd, no shell, no inherited credential environment, optional credential passed as MCP_ACCESS_TOKEN; stderr discarded. SDK safe OS environment variables are inherited. Server annotations cannot grant read classification. No sampling/elicitation/roots callbacks advertised. |

```js
const restConfig = {
  endpoint: 'https://api.example.com/v1',
  auth: 'api-key',
  authHeader: 'X-API-Key',
  actions: {
    list: {
      path: '/tickets',
      inputSchema: { type: 'object' },
      outputSchema: { type: 'object' },
      pagination: { mode: 'cursor', parameter: 'cursor', nextPath: 'meta.next' },
    },
    update: {
      path: '/tickets/{id}',
      method: 'PATCH',
      inputSchema: {
        type: 'object',
        required: ['id', 'status'],
        properties: { id: { type: 'string' }, status: { type: 'string' } },
      },
      outputSchema: { type: 'object' },
      idempotencyHeader: 'Idempotency-Key',
    },
  },
};
```

REST connection tests use the first read action; supply trusted factory `options.testInput` when its schema requires arguments. A write-only REST configuration is rejected. Each health test makes a real read request and reports only the capabilities exercised; descriptor support does not certify credential scopes. Data is returned only to the authorized caller; logs/probes contain allowlisted status metadata.

## Documents and synchronization

Create the source record with `connections.initializeSync(context, syncId, connectionId)`. Compose `createSyncState(database,{authorize})`, `createDocumentSource(kind,spec,{blobs,collectionId,access})` and `synchronizeDocuments`. `access` is mandatory: `{mode:'workspace'|'restricted',principalIds:[...]}`. Run as a reauthorized `connector.sync` reference-only job, never put document text/credentials/cursors in Redis envelopes.

```js
const loaders = createDocumentSource(
  'google-drive',
  {},
  {
    blobs,
    collectionId,
    access: { mode: 'restricted', principalIds: ['approved_group'] },
  },
);
await synchronizeDocuments(context, {
  connector,
  secretRef: connection.secretRef,
  documents: documentPort,
  state: createSyncState(database, { authorize: security.authorizeSync }),
  sourceId: syncId,
  signal,
  ...loaders,
});
```

Drive captures a start token before initial enumeration, then persists incremental change cursors. Removed/trashed files or files moved outside selection delete only previously mapped DocumentPort source IDs. Unselected change records are reduced to ID tombstones; their contents are never imported. Each page commits its cursor after all item operations. Each item records its source/revision after DocumentPort succeeds; reruns skip completed revisions. Knowledge must deduplicate external ID + revision to recover a crash between upsert and checkpoint. GitHub source spec is `{repository,paths:['README.md'],ref?}`; it rereads contents/SHA and skips unchanged revisions. S3 source spec includes `{bucket}` and compares ETags during a prefix scan.

The lease defaults to 60 seconds and renews at fenced state operations; it does not hold a database transaction during external work. If a document operation exceeds the lease, checkpointing fails and recovery relies on idempotent DocumentPort. Set a longer bounded lease for known parser queues (max 5 minutes); do not call inline unbounded parsing. Binary blobs receive immutable UUID keys. Knowledge/retention must garbage-collect uploaded blobs left by interrupted upserts or deduplicated revisions.

There is no deletion inference from incomplete GitHub/S3 listings or inaccessible files. Use provider-confirmed tombstones through a custom page loader or explicit authorized removal. Full snapshot deletion reconciliation and object notifications are not implemented. Changing the selection requires an explicit source reset/reconciliation; retaining a Drive cursor after changing selected folders can miss preexisting files. Disconnect preserves mapping/cursor data for audit; retention/purge is a separately authorized operation.

## Providers, retries and accounting

`createModelAdapter` exposes pure production OpenAI-compatible Chat Completions and Anthropic Messages streaming. The legacy provider registry delegates to the same parsers. Runtime supplies authorized connection/default model, SecretReference, tools, cancellation and budget reservation hooks. Providers report input/output/cache/reasoning usage where present, provider request ID, finish reason, validated structured output and tool arguments. Unknown usage is `{inputTokens:null,outputTokens:null,known:false}`; it is never evidence of free execution. Anthropic cache read/create counts are separate.

Connection capability overrides (`streaming`, `tools`, `structuredOutputs`, `usage`) reject unsupported requests before sending. Generic compatible endpoints must have their actual model features checked by the operator; protocol-level defaults do not guarantee every model supports strict JSON schema. OpenAI uses `response_format.json_schema`; Anthropic uses `output_config.format`. Local JSON schema validation remains mandatory. Refused, truncated, malformed, unknown-tool and partial responses fail without returning executable tool calls. An accepted generation response or any stream progress, including tool fragments, blocks legacy fallback. Authentication/quota failures do not retry/fallback. An explicit pre-generation rate-limit/dependency rejection can use an explicitly configured fallback; provider adapters themselves never blindly retry metered generation. Runtime must reserve/settle separately for each fallback and reconcile unknown usage after failures. No cost is inferred from unknown usage and no universal hard dollar cap is claimed.

HTTP reads use a total 30-second default deadline, at most three attempts, bounded exponential delays, Retry-After/GitHub rate-reset handling and cancellation. Long reset delays return immediately for runtime scheduling instead of occupying a worker. SDK MCP reconnection retries are disabled. SQL requests are not automatically retried after execution. Errors expose codes and sanitized operator instructions, never dependency exception strings or raw provider error bodies.

## Rotation, disconnect and troubleshooting

Rotate through the security service, increment credential version and call repository `save` with the new reference. Every new invocation resolves its selected version after authorization. Security must reject revoked/stale references and compare the active persisted connection generation/config at every authorization call. In-flight requests already sent cannot be undone. A changed connection must invalidate waiting approvals. `disconnect` advances generation, denies repository use and invalidates sync leases; security also revokes secret resolution/OAuth access. Provider revocation may require a provider-side disconnect flow owned by security.

401: reconnect/rotate; never retry an invalid token. 403/missing_scope: check selection, provider consent, channel membership, role SELECT grants and resource sharing. 429: lower concurrency, honor reset and distinguish model billing quota from temporary rate limiting. Drive 410/invalid change token: explicitly reset/reconcile the source and capture a new token; do not silently skip changes. S3 412: immutable key conflict or object changed since listing; reconcile before retry. S3-compatible shared storage must support conditional If-None-Match; never replace it with overwrite. MCP initialization errors: choose the correct transport and verify server/version/token; tool schemas and resource selections are enforced. SQL errors: qualify tables, grant only needed reads, use TLS and inspect server limits privately.

## Verification

`npm run test:connectors` covers synthetic HTTP/SSE model fixtures, real local MCP SDK HTTP/SSE/stdio exchanges, actual AWS SDK signing/XML against a fixture, and an embedded PostgreSQL engine for SQL/RLS/repository behavior. It is not live cloud or networked PostgreSQL verification. `npm test` retains regression coverage; `npm run connectors:types`, `npm run foundation:types`, build, browser and format checks cover integration compatibility.

Operator-only live read probe: `npm run connectors:probe -- --github owner/repo` reads the GitHub CLI OS keyring in memory and exercises repository/issues/PR/README capabilities. No secret/body output and no writes. Generic probes use `--spec nonsecret-config.json` plus `RELAY_CONNECTOR_PROBE_SECRET`; the spec contains `{kind,config,reads:[{action,input}]}` and rejects write actions. The generic probe intentionally does not grant database/process authorization. Use the integrated security policy for those live checks. Model generation and external writes require separate explicit authorization; neither is performed by this probe.

Protocol references: [GitHub pagination](https://docs.github.com/en/rest/using-the-rest-api/using-pagination-in-the-rest-api), [Slack history](https://docs.slack.dev/reference/methods/conversations.history/), [Drive changes](https://developers.google.com/workspace/drive/api/guides/manage-changes), [S3 conditional writes](https://docs.aws.amazon.com/us_en/AmazonS3/latest/userguide/conditional-writes.html), [PostgreSQL READ ONLY](https://www.postgresql.org/docs/current/sql-set-transaction.html), [MCP SDK v1 client](https://ts.sdk.modelcontextprotocol.io/client), [OpenAI Chat Completions](https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create), [Anthropic streaming](https://platform.claude.com/docs/en/build-with-claude/streaming), [Anthropic structured outputs](https://platform.claude.com/docs/en/build-with-claude/structured-outputs).
