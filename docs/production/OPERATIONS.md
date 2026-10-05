# Production operations package

Starting commit: `76649286b51b39924261a876878efebf5e02f020`; branch `codex/production-operations`. This package qualifies infrastructure and operational adapters against synthetic data. The frozen foundation still rejects the real production application. Runtime, security, knowledge and connector composition plus independent acceptance qualification are release blockers. Do not route user traffic to the qualification service.

## Install and qualify

Requires Linux Docker Engine with Compose >=2.24.4, local block storage, outbound registry/npm access, and Node 24 for the test driver. The reference host needs at least 8 vCPU, 16 GiB RAM and enough disk for images, database, objects and two backup copies; those are allocation requirements, not measured throughput. All upstream images are digest-pinned. `npm ci` uses the committed dependency lock. Image digests, checksums, CycloneDX SBOM, scanner output, deployment archive and an importable application image are CI artifacts keyed by commit.

```sh
npm ci
npm run test:operations
npm run operations:qualify
```

The qualification harness builds both images, starts actual pgvector/PostgreSQL, authenticated Redis, S3-compatible RustFS, Caddy TLS, Prometheus, Alertmanager and an OTLP collector in a unique Compose project. It seeds and restores a synthetic vector, database record, encrypted credential and blob. It measures restoration time and tests faults. `OPERATIONS_PORT`, `OPERATIONS_TLS_PORT`, `OPERATIONS_RESULTS`, and `OPERATIONS_KEEP=true` are test interfaces. No live database or production namespace is used. Reports always label `runtimeIntegrated:false`.

Production deployment, after integration gates pass:

```sh
node bin/operations-init.mjs /etc/relay/private
# Review /etc/relay/private/production.env; set domain and the correct HTTPS origin/port.
docker compose --env-file /etc/relay/private/production.env -f deploy/compose.production.yaml build api backup
docker compose --env-file /etc/relay/private/production.env -f deploy/compose.production.yaml up -d --wait database queue storage
docker compose --env-file /etc/relay/private/production.env -f deploy/compose.production.yaml run --rm migrate
# Initialize the S3 bucket and bucket-scoped application identity using the selected S3 service administration tooling.
docker compose --env-file /etc/relay/private/production.env -f deploy/compose.production.yaml up -d --wait
```

Generate credentials into a private directory; initialization refuses to overwrite existing secret files. On Linux it uses mode 0700 parent directories. Compose bind-mounted secrets retain host UID and are mode 0444 under that private directory so non-root container UIDs can read them. They are mounted read-only only in granted services. On Windows, apply user-only NTFS ACLs yourself; POSIX mode bits are insufficient. Do not print resolved Compose configuration or environment values to tickets/CI logs. Production operators should use their secret manager and per-service UID/ACL mounts where available.

`DATABASE_URL_FILE`, `REDIS_URL_FILE`, `ENCRYPTION_KEY_FILE`, `METRICS_TOKEN_FILE`, `S3_ACCESS_KEY_ID_FILE` and `S3_SECRET_ACCESS_KEY_FILE` load secrets before imports. The wrapper rejects missing configuration, HTTP public origins, insecure cookies, migrator credentials in app environments and unsafe object endpoints. `S3_INTERNAL_NETWORK=true` allows HTTP only on the explicitly private reference storage network; use HTTPS for external S3. URLs/configuration and dependency exception text never enter startup logs.

The owner account used by explicit migration/backup tooling is a single-host bootstrap superuser and never mounted in applications. `relay_app` is non-owner, non-superuser and has no BYPASSRLS. Startup readiness must verify it. Security must review final domain grants, dispatcher privileges and per-table policies. Production installations should split owner, migration, backup and runtime dispatcher identities. Reference S3 credentials are administrative bootstrap credentials: bucket-only application credentials and separate backup access are mandatory before staging. RustFS is an available S3 fixture/reference service, not a claim of certified object storage or HA.

## Exposure and containers

Only Caddy is published in production, loopback port 8443 by default. Configure DNS, firewall/LB and certificate issuance before setting `TLS_BIND=0.0.0.0`; public ACME challenge routing requires your existing edge or DNS challenge configuration. `PUBLIC_ORIGIN` must match the actual HTTPS origin, including port when appropriate. Caddy disables its admin API and blocks `/health/*`, `/metrics`, `/ops/*`. Set Express proxy trust only for the controlled immediate proxy subnet, never arbitrary forwarded headers. Verify secure cookies, redirects and SSE after runtime integration. Internal test TLS uses a private CA and curl `--insecure` solely in the rehearsal; production clients must validate certificates.

Database, Redis, object console, metrics, collector and Alertmanager have no host ports. Application containers use UID 1000, a read-only root, dropped capabilities, no-new-privileges, bounded temporary space, PID/CPU/memory limits, log rotation, an init process and a 40-second stop grace. Redis uses authenticated access, AOF every second and `noeviction`; PostgreSQL is the authoritative outbox/business state. Redis AOF can lose roughly the last second on host failure; runtime reconciliation must recover deliveries from PostgreSQL, without replaying uncertain actions. Docker volumes need encrypted disks, capacity alerts, off-host backups and monitored storage. This single-host reference is not an HA deployment.

## Composition interfaces

Runtime must import these operations-owned adapters rather than replace its persistence:

1. `createTelemetry({service, exporter:otlpExporter(endpoint, service)})`; attach `requestTelemetry(telemetry)` before application routes. Use `telemetry.span('provider'|'tool'|'retrieval'|'database'|'queue', allowlistedMetadata, callback)` and `telemetry.retry(kind)` at actual classified retry boundaries.
2. Persist `telemetry.headers().traceparent` beside authoritative run state. The frozen v1 queue envelope cannot acquire new fields. On execution, load that authorized run record and call `telemetry.job(job, traceparent, callback)`. Send trace headers only to trusted internal services; do not forward credentials, arbitrary baggage or caller-supplied metadata. API/job/provider/tool/retrieval spans share the trace; async contexts isolate concurrent requests.
3. `createHealth({integrated, probes, timeoutMs})` needs database restricted-role, exact migration checksums/required domain version, Redis, S3 and worker/dispatcher probes. Set `integrated:true` only when actual production bootstrap exists. Call `health.start()` after all consumers initialize and `registerOperations(app,{health,telemetry,metricsToken})`. Liveness is process availability; readiness fails dependencies, startup or drain. The fixture schema probe verifies only foundation presence; it is not the integrated migration-version gate.
4. `installShutdown` needs runtime `stopAccepting`, `drain` and `close` callbacks. Stop intake/dispatcher, await fenced in-flight work, preserve waiting approvals and uncertain action states, then close dependencies. Deadline exits nonzero for supervisor restart; runtime owns safe abort semantics.
5. `startOperationsSampler` receives authorized aggregate queue and worker counters, dependency readiness, verified off-host backup timestamp and storage free bytes. Never put tenant/run/request IDs in metric labels. Exporter errors are isolated, pending export is bounded, dropped spans are counted. Metrics are authenticated privately; IDs in logs/traces remain access-controlled diagnostics.

Logging/tracing admits bounded identifiers, status, code, timing and counters only. Raw requests, prompts, document content, cookies, email, authenticated URLs, arbitrary exception messages and keys are discarded. The default collector exports sanitized spans to rotated container logs; configure your approved encrypted trace backend and retention before staging. Alertmanager has an empty external receiver. Supply a private authenticated `webhook_configs` replacement and test delivery before relying on on-call notification. Prometheus rules and `promtool` tests cover dependency loss, API errors/P95, queue age, stale worker, retries, stale backups, low disk and exporter drops. Missing aggregate hooks are integration blockers, not healthy zero values.

## Backup, restore and upgrades

`bin/backup.mjs create|verify|restore NAME.relay-backup` executes PostgreSQL 16 dump/restore tooling, lists all active bucket keys, verifies SHA-256 and seals the complete snapshot plus versioned vault keyring using AES-256-GCM under a separate backup key. Backups fail unless `BACKUP_QUIESCED=true`. Stop all writers, including scheduled jobs, ingestion, connector synchronization and outbox dispatch. The reference script stops all API/worker services; independently deployed writers must also be stopped. Do not claim database/blob consistency without this write boundary.

This first tool supports <=256 MiB unencoded database+object payload and <=32 MiB per object, <=100,000 active objects, and one bucket. It restores current objects, not historical versions. It is a buffered small-deployment tool; larger corpora require streaming backup/object replication/PITR tooling and a new recovery rehearsal. It is not qualified for the acceptance plan's 50,000 chunks. Retain the encrypted archive, checksum, release image/migrations, every referenced vault key version, legacy key dependencies from security import, and a separately escrowed BACKUP_KEY. Key loss is permanent data loss. A restored plaintext keyring is emitted mode 0600 in the private backup directory for explicit re-provisioning; remove it after secure import.

Install `deploy/systemd/relay-backup.*` and `deploy/backup.sh` at `/opt/relay` after adapting the env-file path. The timer runs every 45 minutes; backups must finish and be independently copied/verified within 15 minutes to support a <=1-hour snapshot data-loss window. Missed/failed backups or missing off-host copy invalidate that target. Local snapshots alone cannot recover host loss. The site-owned `/etc/relay/copy-backup-offhost` must upload only encrypted files, verify the remote checksum and update the monitored timestamp. Retain at least 24 hourly and 7 daily snapshots; implement retention on the independent repository and verify before deleting any local copy. The separate escrow must not share the backup-storage credentials/failure domain.

Restore into an isolated **empty** database and empty bucket, with applications stopped. Provision roles/extensions compatible with the captured release; call backup `restore` with `RESTORE_ALLOW_EMPTY_TARGET=true`, `PGDATABASE` for the isolated target and its S3 bucket. The tool uses transactional `pg_restore`, no `--clean`, so existing objects fail instead of being overwritten. Restore domain grants under security review, re-provision keyring keys, then verify authorized credential decryption, database counts, vectors and blob hashes before changing traffic. Redis is reconstructed from authoritative PostgreSQL outbox/business state; do not restore Redis as authorization to replay actions. Run the new release's exact checksum migration probe and reconciliation, with external writes gated.

Before upgrade, record the immutable current image/schema, quiesce and take a verified off-host snapshot. Run the candidate's explicit migration command once, start candidate API/workers privately, verify readiness and representative provider/tool/retrieval/approval flows, then switch traffic. Migrations are transactional, advisory-locked and checksum-checked. Never edit an applied file or blindly run down migrations. Roll back the image only if its schema compatibility is demonstrated. Otherwise restore the pre-upgrade snapshot into isolated dependencies, provision its keys, start the captured image and switch traffic after integrity checks. Post-snapshot writes are lost on restore; disclose that window. This branch rehearses restarting the same captured image with compatible restored state; genuine previous-version domain rollback awaits integrated releases.

External staging requires an existing authorized account, host, DNS/TLS, storage, secret escrow, alert receiver and spending authorization. None is assumed or created by this package.

Sources: [Docker service limits/secrets](https://docs.docker.com/reference/compose-file/services/), [PostgreSQL consistent dumps](https://www.postgresql.org/docs/current/app-pgdump.html), [OpenTelemetry propagation](https://opentelemetry.io/docs/languages/js/propagation/), [RustFS secret-file configuration](https://github.com/rustfs/docs.rustfs.com/blob/main/content/en/reference/environment-variables.md).
