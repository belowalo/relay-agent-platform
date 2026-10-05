# Deployment

Relay supports **multiple execution processes on one host** using a shared local SQLite WAL database, vault and model cache. Workers claim expiring run leases and fence results by generation. Do not place the database on an NFS share or treat this as multi-host infrastructure. Container configuration is supplied; a Docker runtime was not used in local verification.

## Local container

```sh
docker compose up --build -d
```

The default port binds to the host loopback interface. Open http://127.0.0.1:4311. The `relay-data` volume persists the database and automatically generated credential encryption key. The process runs as the non-root `node` user.

## HTTPS deployment preparation

1. Build and test with `npm ci`, `npm run check`, and browser tests.
2. Run an API process and one or more local workers sharing the same persistent directory with `NODE_ENV=production`, `HOST=0.0.0.0`, and a durable `DATA_DIR`.
3. Set `PUBLIC_ORIGIN` to the exact HTTPS browser origin and `COOKIE_SECURE=true`.
4. Put the process behind an HTTPS reverse proxy that supports long-lived SSE, disables proxy buffering for event endpoints, and limits request body size to at least 15 MB for uploads.
5. Restrict filesystem access to the data volume and `vault.key`. On Windows, set NTFS ACLs for the service account; POSIX creation mode alone does not enforce Windows ACLs. Alternatively set a persistent 64-hex-character `ENCRYPTION_KEY` through your host's secret manager. Never change it without migrating encrypted credentials.
6. Create your account and workspace; configure provider credentials through the application. There are no default accounts.
7. Publish application versions explicitly. Public hosted-chat/widget access is an application setting, separate from public network deployment.

Example reverse proxy (replace the hostname and upstream as appropriate):

```nginx
location / {
    proxy_pass http://127.0.0.1:4311;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_buffering off;
    proxy_read_timeout 900s;
    client_max_body_size 16m;
}
```

Local/private network requests are disabled by default. Administrators can enable them on a specific model connection or configured tool. Inline workflow tools cannot grant themselves private network access. Do not enable `ALLOW_PRIVATE_NETWORK=true` globally on an exposed server; that environment switch is used only by isolated integration fixtures. Public fetches validate and pin DNS results through the HTTP dispatcher and validate redirects.

## Backups and upgrades

Stop all API/worker processes before copying `relay.sqlite`, any active `relay.sqlite-wal` / `relay.sqlite-shm` files, and `vault.key`. A stopped server will normally checkpoint the WAL. Store backups outside the public web root and restore the database and matching key together. SQLite-native online backup is also possible, but no backup scheduler is included.

Migrations are idempotently versioned in the `migrations` table. Migration 1 creates the schema, FTS index, and constraints. Migration 2 adds frozen publication graphs, application/run association, and side-effect markers. Migration 3 adds a persisted execution clock excluding human waiting and downtime. Migration 4 adds worker leases, embeddings, datasets/evaluations, prompts, schedules and security tables. Migration 5 adds indexing leases, TOTP replay state and recovery codes. Back up before applying a new release; migrations are forward-only.

No public deployment, DNS change, cloud provisioning or Docker build was performed. An authorized OpenAI connection returned exhausted credits; successful hosted-provider execution remains unverified.

## Operational scope

- Suitable for local workspaces or carefully managed shared-host deployments.
- No multi-host PostgreSQL/Redis queue, billing, scheduled backup or automated retention policy is included. OIDC/SMTP require administrator configuration; MFA works locally.
- Account creation is open to users who can reach the server. Deploy behind your organization's access proxy if account admission needs to be restricted.
- Auth attempts and application starts have local rate limits. Reverse-proxy address handling and global admission controls need deployment-specific configuration.
- There is no sandbox for arbitrary user code because custom tools are HTTP/schema adapters. Database tools query an isolated SQLite data view, not remote production databases.
- Test the selected provider's exact model options and streaming/tool behavior with authorized credentials before relying on it in production.

## Separate workers

The default local server embeds a worker. To separate execution in PowerShell:

```powershell
$env:ENGINE_ROLE='api'
npm start
```

In separate terminals using the same working directory and data configuration:

```powershell
$env:WORKER_NAME='execution-1'
$env:WORKER_CAPACITY='24'
npm run worker
```

Each process needs a unique worker ID; omit `WORKER_ID` to generate one automatically. Do not start two processes with the same explicit ID. Leases default to five seconds. Operations treats worker heartbeats older than 15 seconds as unhealthy. An abrupt crash can appear healthy briefly until that window expires. Shared SQLite write throughput and collection vector scans limit scale; verify your workload before serving production traffic.

Compose starts the API and worker on one local volume. Use `docker compose up --build --scale worker=2` for additional workers on the same host. Stop all workers before offline backups or schema rollback. This container configuration has not been exercised locally.

## OIDC and SMTP

Configure `PUBLIC_ORIGIN`, HTTPS and secure cookies first. Add `OIDC_ISSUER`, `OIDC_CLIENT_ID`, optional `OIDC_CLIENT_SECRET` and `OIDC_EMAIL_DOMAINS`. Register callback `PUBLIC_ORIGIN/api/auth/sso/callback`. The issuer must return matching discovery metadata and RS256/ES256/PS256 ID tokens with subject, issued/expiry times, nonce and verified email. Existing password accounts use their original credentials; automatic email linking is intentionally absent. No SAML, SCIM or enterprise account migration is implemented.

Configure `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_FROM` and optional credentials to enable password-recovery email. Port 587 with `SMTP_SECURE=false` supports STARTTLS; port 465 normally uses `true`. Secrets belong in the environment/host secret manager. Password resets expire in 30 minutes and invalidate existing sessions while retaining MFA. Invite emails remain manually shared. Real identity and SMTP services have not been configured on this host.
