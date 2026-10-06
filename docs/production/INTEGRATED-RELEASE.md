# Integrated deployment and operating guide

This guide describes the composed production profile in `server/production`. The original team handoffs preserve branch history; they are not the current release verdict. Check [integration evidence and gates](handoffs/integration.md) before admitting company traffic. Installation commands below are the paths exercised by the Linux qualification harness; site-specific public TLS, off-host recovery and the declared two-host workload need separate evidence.

## Supported behavior and boundaries

| Area            | Production behavior                                                                                                                              | Limit or excluded claim                                                                                                                               |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| Identity        | Password/scrypt, secure sessions, MFA/recovery codes, current role/membership checks, email-bound invitations                                    | Public registration disabled; production SSO and SMTP recovery routes are not composed                                                                |
| Storage         | Restricted PostgreSQL roles, forced tenant RLS, pgvector, transactional outbox, Redis/BullMQ, shared S3                                          | Reference Compose uses one host and administrative bootstrap S3 credentials; not HA or least-privilege managed storage                                |
| Workflows       | Revisions, frozen published graph/tool/child settings, durable leases, schedules, approvals, cancellation, action ledger                         | Cancellation cannot undo an accepted remote action; uncertain writes require provider-side reconciliation                                             |
| Models          | OpenAI-compatible and Anthropic adapters, explicit credentials, reported token usage and reservations                                            | No production fallback/cache; unknown usage remains held until reconciled; provider quotas/pricing are external                                       |
| Knowledge       | Versioned text/Markdown/HTML/CSV/JSON, PDF and DOCX ingestion, 384-dimensional offline CPU embeddings, ACL-filtered lexical/vector/hybrid search | 15 MiB, 200 pages, 2M characters, parser 30 seconds; OCR/audio/hosted reranking not configured                                                        |
| Answers         | No-tool extractive grounded answers with verified quotations, current version/ACL rechecks and abstention                                        | One collection per grounded agent; semantic paraphrase verification and human correctness are not inferred from citation validation                   |
| Memory          | Writer principal, workspace, agent and optional conversation scope, enforced in queries and restrictive RLS                                      | Old memories without provenance remain quarantined; application token rotation starts a separate memory scope                                         |
| Connectors      | Native GitHub/Slack/Drive/S3/PostgreSQL/REST/MCP capability adapters with current config/credential checks                                       | Vendor accounts/scopes/resources must be qualified live individually; direct HTTP write invocation cannot bypass the action ledger                    |
| Synchronization | Queued GitHub selected paths, Drive selected files/direct folder children with changes, S3 selected prefix; per-item revision/cursor fences      | 10 pages/1,000 items/5 minutes per job; explicit resume retains destination/ACL; config rotation requires a new job; no implicit recursive expansion  |
| Publications    | Private async API, explicit resource grant, scoped token mint/rotate/revoke, maximum 30-day token/500 resources                                  | No public chat, widget, app webhook or app MCP publication                                                                                            |
| Quality         | Frozen datasets/workflow revisions and deterministic exact/contains/JSON/success/latency/token evaluators; prompt history                        | 200 cases; no integrated LLM judge; fixture scores are not live-model evidence                                                                        |
| Operations      | Private readiness/metrics, sanitized linked API/job/provider/tool/retrieval traces, lease/recovery and tenant operations views                   | Worker UI shows shared heartbeat count and tenant leases; worker count does not establish execution capacity; external alert receiver is unconfigured |
| History         | Run events, feedback, audit, artifacts and own-memory deletion                                                                                   | Automatic run-history deletion is disabled in production                                                                                              |

The default `npm run dev`/`npm start` SQLite profile has different features and durability semantics. Do not use its local UI tests to certify the distributed release.

## Install on a disposable Linux host

Requires Linux Docker Engine/Compose 2.24.4+, Node 24 for drivers, registry/npm/model-download access and adequate local disk. Allocation limits are not capacity measurements. Use a checkout at the exact reviewed commit. Initialize into a private directory outside the checkout:

```sh
ONNXRUNTIME_NODE_INSTALL=skip npm ci
node bin/operations-init.mjs /etc/relay/private
node bin/provision-embeddings.mjs /etc/relay/private/models
```

Initialization refuses existing files. Keep the private parent directory mode 0700; mounted secret files are read-only mode 0444 for the distinct non-root service UIDs. On Windows use explicit user-only NTFS ACLs. Never paste resolved Compose environments into CI/tickets. Escrow every retained vault key version and the separate backup key outside the host's failure domain.

Edit `/etc/relay/private/production.env` to set the real `RELAY_DOMAIN`, exact HTTPS `PUBLIC_ORIGIN`, queue namespace and paths. Compose publishes loopback 8443 by default. A controlled edge must forward public 443 and ACME TLS challenge traffic to this listener, or install your approved certificate/CA configuration. Public DNS/certificate issuance is an external release gate; CI only uses an internal test CA.

```sh
docker compose --env-file /etc/relay/private/production.env -f deploy/compose.production.yaml build api database backup proxy alertmanager
docker compose --env-file /etc/relay/private/production.env -f deploy/compose.production.yaml up -d --wait database queue storage collector
docker compose --env-file /etc/relay/private/production.env -f deploy/compose.production.yaml run --rm migrate
```

Provision the configured S3 bucket through the selected service's administration tooling. Replace bootstrap admin access with a bucket-scoped runtime identity and separate backup access before staging. Application credentials require list/head/get/put/delete only on the configured bucket; the provider policy must prevent access to other buckets. The reference service's admin credentials and bucket policy have not been qualified as least privilege.

Create the first owner on the private migration network. Put a chosen password of at least ten characters in a private parent directory, readable through its read-only mount. Do not put it in a command argument or environment variable:

```sh
docker compose --env-file /etc/relay/private/production.env -f deploy/compose.production.yaml run --rm -v /etc/relay/private/owner-password:/run/owner-password:ro -e PROVISION_EMAIL=owner@example.com -e PROVISION_NAME='Workspace owner' -e PROVISION_PASSWORD_FILE=/run/owner-password migrate node bin/production-admin.mjs create-owner
docker compose --env-file /etc/relay/private/production.env -f deploy/compose.production.yaml up -d --wait --scale api=2 --scale worker=2 api worker parser proxy prometheus alertmanager
```

Remove the provisioning password file securely after login/password-manager storage. Enable MFA, invite members and configure a workspace budget. With registration disabled, invitees need privately provisioned accounts; this CLI creates an account and an owned workspace, after which the account can accept an email-bound invitation to another workspace. Automatic mail delivery is not composed.

The API/worker never receives migration credentials. Identity and rate access use distinct database logins; workers use the restricted tenant app role plus a narrow dispatcher function. The parser receives only its own token, a bounded scratch filesystem and an internal no-egress network. Public routing blocks operational endpoints. Application readiness checks all shipped migration checksums and configured database/queue/storage/parser dependencies.

## Connect and run

Store a provider credential through Model connections or the authenticated connection API. Use the exact provider base endpoint and model ID. Set real per-token pricing if enforcing a cost ceiling; do not invent prices. Workspace owners configure `PUT /api/w/{workspace}/budget` with `periodId`, `tokenLimit`, `costLimitMicros`, `allowUnknownCost`, `maxConcurrent` and `maxReservedTokens`. Unknown costs cannot be paired with a dollar cap.

Save the workflow, select Live for a metered call, inspect its persistent run ID and events, and approve the exact recorded arguments for a write. Preview performs no production model or external tool action. Use private application tokens through `POST /api/apps/{id}/invoke`, then poll `GET /api/apps/{id}/runs/{runId}`. Never embed a key in a workflow or prompt. Caller-supplied snapshots, secrets, tenant IDs or service actors do not grant authority.

OpenAI-compatible JSON-schema calls use a complete, bounded JSON response, validate it before publishing content and settle reported usage. Ordinary text/tool calls stream. Groq schema calls must have no simultaneous tools, as described in its [structured-output requirements](https://console.groq.com/docs/structured-outputs). Individual provider/model support still requires a live capability check; an OpenAI-compatible endpoint alone does not establish support.

The component-test endpoint `/workflows/{id}/nodes/{nodeId}/test` runs a node from the saved, frozen version with the same worker, permissions, budgeting and approval boundaries. Input/output nodes and topology-dependent orchestrator/parallel/join nodes require testing their complete workflow. Version restoration strips execution snapshots before updating the draft; publication captures current authorized dependencies again. Run JSON exports are under `/runs/{id}/download`. Dashboard/history token totals come from the persisted usage ledger.

Connection tests create durable billable probe records. Administrators inspect `GET /api/w/{workspace}/connection-probes`; the owner resolves an uncertain or five-minute-expired probe using `POST /connection-probes/{id}/reconcile` with `{actual:{tokens,costMicros,provider,model},evidence}`. Obtain actual counts from the provider or independently confirm no execution before recording zero. Reconciliation never calls the provider again. Repeating the identical resolution is idempotent; different evidence/counts conflict. Only an evidence hash and reviewer/target IDs enter audit logs. Keep the supporting provider export privately. Workflow reservations continue to use the documented run-step reconciliation endpoint.

Private metrics include shared Redis worker heartbeats and live worker count, independently of tenant run leases. A stopped/killed fleet reports zero workers after heartbeat expiry and triggers the stale-worker rule. Host disk and independently verified off-host backup timestamp hooks are not composed; configure and exercise them with your monitoring system before relying on those alerts. An absent metric is not evidence of healthy disk or backups.

Outbound policy belongs to the deployment administrator. Default DNS/redirect/private-address checks stay enforced. Add exact trusted origins/private CIDRs through `OUTBOUND_POLICY_JSON` only for an authorized internal endpoint; a tenant's `allowPrivate` setting cannot widen the policy.

Native connection configuration is under `/api/w/{workspace}/connectors`. Changing the credential destination requires a replacement credential; existing secrets cannot be redirected by a configuration-only update. Start document ingestion with `POST /connectors/{connectionId}/sync` and `{collectionId,access,repository?,paths?,ref?}`. Access must explicitly be workspace-wide with no principals or restricted with allowed principal IDs. Poll `/connector-sync/{jobId}` and resume with `/connector-sync/{jobId}/resume` and an empty object. Config/credential generations and original actor membership are rechecked during work. Repeated GitHub/S3 scans do not infer deletions; Drive's removal feed applies mapped tombstones. Recovery retries crashed jobs at most three times after the six-minute job deadline; failed jobs need an explicit operator resume. The five-minute task budget and one-minute cursor lease prevent unbounded work.

## Migration, backup and rollback

Follow [SQLite migration](MIGRATION-RUNTIME.md) using a consistent authorized offline copy and an empty disposable PostgreSQL target. Default dry-run inserts then rolls back; `--apply` commits atomically. Validate counts/IDs/decryption, source ACLs, parser/retrieval and binary-object transfer before cutover. Legacy live work is halted; never invent a principal to resume unowned actions. Preserve the original data/key privately. Embedded rehearsals on the user's current copy do not replace a real target/cutover rehearsal.

Quiesce all API/workers, schedules, ingestion, synchronization and other writers. Use the `backup` Compose tool with `BACKUP_QUIESCED=true`:

```sh
docker compose --env-file /etc/relay/private/production.env -f deploy/compose.production.yaml stop api worker
docker compose --env-file /etc/relay/private/production.env -f deploy/compose.production.yaml run --rm -e BACKUP_QUIESCED=true backup create release.relay-backup
docker compose --env-file /etc/relay/private/production.env -f deploy/compose.production.yaml run --rm backup verify release.relay-backup
```

The encrypted archive contains a consistent DB dump, current bucket objects and the retained vault keyring. The buffered tool is limited to 256 MiB aggregate unencoded payload, 32 MiB/object and one bucket. It does not qualify the 50,000-chunk target or PITR. Copy encrypted archives off-host, verify remote checksums and prove access with separately escrowed keys. Local backup timing alone does not establish host-loss RPO.

Restore only into an empty isolated database/bucket. Set the backup tool's `PGDATABASE`, `S3_BUCKET` and `RESTORE_ALLOW_EMPTY_TARGET=true`, then run `restore release.relay-backup`. Reprovision the restored private keyring, all app/identity/rate/dispatch URLs and S3 bucket. Run `migrate` to validate history/regrant roles. Start API/workers privately; verify sessions, credential resolution, documents and action states before switching traffic. Never restore Redis as authority for replaying uncertain actions.

Record the current immutable image, configuration and pre-upgrade backup. Apply append-only migrations with migration credentials, start candidate privately and qualify it before traffic switch. An image rollback is allowed only against a demonstrated compatible schema. The integrated harness switches to specified prior application code against the restored schema, then returns to the candidate; it does not reverse migrations or reconcile real vendor writes. Memory RLS fails closed for code that omits the new principal context. Otherwise restore the old snapshot/image into isolated dependencies and disclose lost post-snapshot writes. SQLite reverse migration is not implemented.

## Incidents and qualification

Read private `/health/ready`, `/health/live` and authenticated `/metrics` from the internal management network. Readiness failure should remove an instance from intake; liveness alone proves no dependency health. Search sanitized logs by request/run/trace ID, inspect queue age and ledger states, and inspect provider account history before resolving an uncertain write. Do not retry it merely because a worker restarted. Resolve action success/failure with observed provider evidence using the administrator action reconciliation API. Reconcile usage through the failed step's usage-reconcile endpoint using actual provider usage; held unknown calls must not be guessed away.

Prometheus rules and `promtool` tests are provided. Supply an approved encrypted trace backend/retention, monitored off-host backup completion/disk capacity, an authenticated Alertmanager receiver and an actual delivery test. The default empty receiver cannot notify an operator. Shared fleet heartbeat metrics are composed; off-host backup/disk hooks remain gaps, and absent metrics must never be interpreted as healthy zero.

```sh
node bin/production-qualify.mjs
PRODUCTION_SOAK=true node bin/production-qualify.mjs
```

These commands create their own disposable project, secrets and data; they never use the current local user's database. Reports include the source commit, topology, resource caps, workload/errors/p95, recovery outcomes and evidence scope. Model/action protocol fixtures test the application, not vendor quality. A separate authorized live-model/document run and independent human review are required. The acceptance profile remains two hosts, 10 workspaces, 100 users, 25 active runs and 50,000 chunks; a small single-host CI result must not be represented as that capacity. Required CI and every release gate must pass on the exact candidate before merging main.

The integrated CI workload offers 20 API requests/sec and 10 hybrid retrievals/sec with eight read-load users, plus one sequential workflow issuer every ten seconds. It measures dispatch to the first persisted step, reported failures and terminal runs, sampled queue depth, and final-half-hour memory growth for all four API/worker containers. The small corpus and single workflow issuer do not qualify the declared corpus or 25 concurrent runs. The default two workers have eight slots each; a 25-active-run target requires a suitable capacity configuration and a separate measurement.
