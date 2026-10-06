# Relay integration and release qualification

Status: **release qualification remains blocked; do not merge main**. The exact candidate commit, final CI links and deployment results are emitted in qualification artifacts. This record captures verified checkpoints and the remaining release criteria.

## Integrated branches

| Team         | Actual source head                       |
| ------------ | ---------------------------------------- |
| Runtime      | da1699d116cad8adf70a09b1732881f909f82b15 |
| Connectors   | 0c2912761cd2caf88a3ece7e37229761e718de32 |
| Knowledge    | bd2cbf2e0dda35eb19e190ee84ae520104f525b2 |
| Security     | 85319812d8bd4328aa95330753803b982e29f073 |
| Operations   | 06e1cd56446f392c904baf98697f3750f1314c19 |
| Verification | cbcd551204ece8e6bc3f14d0ad785f34c664d34b |

Integration uses the separate `codex/production-integration` worktree and [draft review](https://github.com/belowalo/relay-agent-platform/pull/1). Main remains at the original baseline until release gates pass.

## Implemented composition and repairs

The production entrypoint composes PostgreSQL tenant repositories, distinct restricted identity/rate/dispatch logins, forced tenant RLS, current membership/MFA/token authorization, encrypted credential references, durable BullMQ notifications and PostgreSQL outbox/lease recovery. Worker services expose no business HTTP API. Private publications freeze graph dependencies, issue scoped expiring tokens and recheck grants/current principals during execution.

Writes use exact input hashes, reviewer decisions, configuration/credential generations and lease fences. Ambiguous accepted writes stop as uncertain and require reconciliation. Native connector results echoing resolved credential values are withheld. Model connection destination changes require a replacement credential. Model calls reserve budgets and settle reported usage; connection probes and workflow reservations have separate durable reconciliation paths. Dashboard/history report the persisted usage ledger. OpenAI-compatible schema output uses bounded complete JSON with validation; ordinary text/tool output streams.

S3 blobs, an isolated authenticated no-egress parser, actual CPU embeddings and versioned ACL-filtered lexical/vector/hybrid retrieval are composed. PDF/DOCX parsing runs under the production UID/limits with a stripped environment. Extractive answers require exact supported quotations and current ACL/version checks. Memories have restrictive RLS and writer-principal scope; unowned imported memories stay quarantined. Queued document synchronization preserves destinations/ACLs and rechecks configuration generations, actor permissions, cursor fences and item revisions on resume.

Production workspace/project/history/feedback/artifact APIs, saved component tests, prompt/dataset revisions, deterministic evaluations, scheduled runs and private application APIs are composed. The UI reflects unsupported public surfaces and retention features. Version restore removes execution snapshots before draft save. Preview avoids model calls and external tool actions.

Operations include sanitized linked API/job/provider/tool/retrieval traces, private readiness/metrics, actual shared worker heartbeats, hardened images, explicit migrations, keyring backup/restore and a prior-code rollback drill. Installation and recovery instructions are in [the integrated operating guide](../INTEGRATED-RELEASE.md). Branch-era reports and infrastructure fixtures have narrower historical scopes.

## Verified checkpoints, including failures

At `a4b5f49a193628cf8ab5b1346e4b4a985b8ee4d1`, actual Linux CI deployed two API and two worker containers with PostgreSQL/pgvector, Redis, S3, isolated parser, Caddy and CPU embeddings. TLS used an internal test CA. Build/migrate/start, owner provisioning, sessions/budgets/model protocol, S3 Markdown and PDF/DOCX ingestion, and mid-write SIGKILL recovery passed. The endpoint accepted one write and recovery observed one total action with an uncertain ledger entry. Retrieval load then failed because viewer query POSTs incorrectly required write permission; that boundary was repaired.

At `f3433b3b2ccf7596821037c8952230de86cdcba6`, the actual container workload passed 120 seconds at 20 authenticated API requests/sec and 10 hybrid retrievals/sec: API p95 **35.26 ms**, retrieval p95 **159.43 ms**, unexpected errors **0**. It used one 4-CPU/16-GiB runner, eight load users and three ingested documents. This does not qualify two hosts, 100 users, 25 active runs or 50,000 chunks. Browser verification then failed on a selector matching both a heading and button; it was repaired. That run did not reach expanded restore/rollback. Its infrastructure recovery and strict scans passed; all nine scanned images had zero HIGH/CRITICAL findings. Scans are time/image-specific and do not replace a security assessment.

Earlier `555a53c` evidence exercised a small integrated quiesced encrypted backup and restore: 283,918-byte archive, one object, 182-ms backup, 381-ms restore tooling and 10,094-ms end-to-end recovery. Additional documents/state require a new report; historical timings do not establish final candidate recovery.

The real Groq `openai/gpt-oss-20b` grounding run at `a4b5f49` completed **50/50** fixed synthetic document cases, **100% recall@5**, **100% automated expected-text matches**, **42,822 reported tokens**. Benchmark hash: `c74f6c1f59a3e9be597289bb0df61e153940d3cd812fdcf2b82caf2ac6fbd96d`; result hash: `ddc77178bfae2cf57fdf2460eb7305308af2a2f95b804eff2e9cca306b9f47fe`. This used real provider calls, embedded PostgreSQL and actual CPU retrieval. Earlier failures are retained privately; the repaired contract accepts a literal claim shorter than its literal quotation and still rejects unverified paraphrases. Automated text matching does not establish human citation precision/correctness. Independent human review and deployed company-document tests remain blocked.

The original user's SQLite data/key were preserved. A consistent read-only private copy passed the embedded integrated migration rehearsal; no private database or credential was uploaded to CI. Strict service CI now includes a synthetic actual-PostgreSQL import rehearsal covering rollback, source SHA preservation, ACLs, session revocation and credential AAD rewrapping. A cutover rehearsal of the private data on its actual PostgreSQL/S3 target remains required.

## Exact remaining release actions

1. Pass required CI and deployed browser/business/recovery/rollback tests on the final release commit. Complete the hour soak with offered rates, errors, queue/memory and dispatch observations. Short tests do not pass the hour gate.
2. Supply a disposable **two-host** deployment matching the frozen profile: 10 workspaces, 100 users, 25 concurrent runs, 5,000 documents/50,000 chunks and declared application/database allocations. Meet dispatch p95 <=2 seconds and unchanged API/retrieval/error/queue/memory targets. One-host containers do not substitute for another failure domain.
3. Configure public DNS/CA/ingress and verify deployment/draining/rollback there. Replace S3 bootstrap admin credentials with bucket-scoped runtime and separate backup identities and prove unrelated-bucket denial.
4. Configure independently verified off-host encrypted backups, separate key escrow and monitored backup/disk timestamps; deliver a real alert and rehearse host loss/restoration within <=1-hour RPO/RTO. Local snapshots and an empty receiver do not pass. The buffered tool is bounded to 256 MiB total/32 MiB per object; larger corpora need suitable streaming/PITR/object recovery and another rehearsal.
5. Qualify the deployed provider/model and each enabled connector with disposable authorized vendor resources/scopes and approved writes. Test quota/rate errors, revocation, sync and accepted-write recovery without duplicates. Fixtures and an OS GitHub read probe are not deployed live-vendor quality evidence.
6. Supply held-out company documents/questions and independent review bound to exact answers/citations: recall >=85%, human citation precision >=95%, human correctness >=85%. Rehearse migration/binary transfer on the actual target. Keep private data and credentials out of GitHub artifacts.

The implementation profile is private/self-hosted. No company capacity or production-ready verdict is claimed until the specified deployment/workload gates pass. OCR/audio, public hosted surfaces, composed SSO/mail, automatic history deletion, semantic paraphrase verification and production model fallback/cache remain unsupported in this profile and require separate qualification.
