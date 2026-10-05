# Knowledge team handoff

Foundation: `76649286b51b39924261a876878efebf5e02f020`. Branch: `codex/production-knowledge`. Final commit is reported in chat after commit/push. The user's `main` checkout and private database were not changed. This branch is a working knowledge subsystem for the shared production composition, not an integrated production release.

## Implemented

- DocumentPort upsert/delete; immutable blob ownership/integrity checks; identity/content deduplication; durable document versions and extraction snapshots; refresh and reindex; stable chunk IDs and page/offset/URL provenance.
- PostgreSQL repository with tenant RLS, composite collection/source ownership, full-text GIN search, 384-dimensional pgvector HNSW, batched chunk/vector inserts and atomic index replacement. SQLite development adapter exercises the same domain operations without the user's legacy database.
- Reference-only `source.ingest` jobs and outbox writes in the document transaction. Lease/generation fencing, heartbeats, progress/phases, cancellation, persisted sanitized actionable failures, restart recovery and terminal-job suppression. Worker context is revalidated through the runtime/security composition.
- UTF-8 text, Markdown, HTML, quoted CSV, JSON, PDF and DOCX extraction in isolated child processes. Signature/type checks, ZIP declared and actual inflation limits, disabled external DOCX access, JSON/CSV/HTML validation, time/heap/text/page/chunk/pixel budgets and temporary-file cleanup. Native parser crashes are isolated from the API process.
- Configured native Tesseract OCR for PNG/JPEG and raster-only PDF pages; configured transcription callback for signature-validated WAV/MP3/OGG. Missing providers produce actionable failures. Raster-only PDF extraction/rasterization and OCR/transcription wiring are fixture-tested; actual recognition/transcription remain blocked on configuration.
- Same-origin crawling with robots allow/disallow specificity, sitemap indexes, URL canonicalization, trap exclusions, request/page/byte/time limits, conditional ETag refresh, unchanged-document reuse and HTTP 404/410 deletion propagation. A URL source with `metadata.crawlMaxPages` greater than one crawls in its ingestion worker and creates durable child document jobs. Children have independent indexing status.
- Keyword/vector/hybrid retrieval, metadata/source/ACL/resource-scope filters before ranking, optional reranking, separate cosine/rerank thresholds, source diversity, previews and score diagnostics. Candidate permissions are rechecked before reranking and before returning evidence.
- Grounded generation with untrusted evidence separated from the system instruction, an empty tool list, strict answer schema, valid exact source quotations and citations, insufficient-evidence responses and conflict reporting. Without a trusted semantic verifier, claims must themselves be exact evidence quotes. Changed/deleted/revoked evidence aborts release of generated text.
- Durable blob retirement records; deletion clears active chunks/vectors and version bodies/snapshots. Blob deletion retries through `pipeline.cleanup(context)`. Shared live references prevent premature deletion; retired keys cannot be reused. Repeated deletion of a known tombstone is idempotent. Saved run evidence is deliberately not erased by this subsystem.

## Commands and evidence

```powershell
npm ci
npm run test:knowledge
npm run knowledge:types
npm run foundation:types
npm run build
npm test
npm run test:browser
npm run format:check
$env:EMBEDDING_CACHE_DIR='<preprovisioned-model-cache>'
npm run knowledge:eval
npm run knowledge:capacity
$env:KNOWLEDGE_CAPACITY_BACKEND='pglite'
npm run knowledge:capacity
$env:KNOWLEDGE_TEST_DATABASE_URL='<disposable relay_knowledge_test database URL>'
npm run test:knowledge:services
```

Detailed final results are in [knowledge evidence](../evidence/KNOWLEDGE.md), [per-question evaluation](../evidence/knowledge-evaluation.json), [SQLite capacity](../evidence/knowledge-capacity.json), and [embedded pgvector capacity](../evidence/knowledge-pgvector-capacity.json). The 66-document / 56-question corpus includes known passages, distractors, an outdated policy, conflicting current policies, embedded hostile instructions, a restricted document and another workspace. It is authored synthetic regression evidence, not a blinded held-out human review.

Actual local MiniLM embeddings achieved recall@5 100%, MRR 0.9811, zero observed isolation leaks. Extractive fixture answers achieved 100% expected-answer checks and quote/citation checks, including abstention and conflicts. These answer metrics are **fixture-based**, not live LLM correctness or semantic-support qualification. Embedded actual PostgreSQL/pgvector 0.8.1 passes migration, RLS, ACL/metadata/resource filtering, transaction/outbox, deletion and stale-fence tests. PGlite is WASM PostgreSQL, not a multi-host PostgreSQL/Redis deployment.

Both capacity measurements use 50,000 stored chunks and fixture precomputed vectors, excluding extraction and embedding costs. Embedded PostgreSQL measured 433 chunks/second, retrieval P95 25/43/65 ms for keyword/vector/hybrid, and recall@5 100% against exact search for ten synthetic vector queries. The benchmark runs ANALYZE before querying; EXPLAIN confirms `knowledge_vectors_ann` HNSW use. SQLite measured 2,604 chunks/second and P95 81/1,129/756 ms. This is sequential, one-process evidence. It does not pass P02's 10 requests/second concurrent target or the one-hour soak gate.

## Composition requirements

See [setup and integration](../KNOWLEDGE.md) for executable composition/API examples.

1. Apply runtime's workspaces/collections migration before `0300-knowledge.sql`. It adds a tenant composite unique index to `relay.collections`, then six knowledge tables with RLS and proper references. Require pgvector >= 0.8. Grant the restricted application/worker role table CRUD and schema USAGE, never table ownership/BYPASSRLS. Do not apply this branch's complete migration set before runtime tables exist.
2. Construct the repository with the foundation DatabasePort and the pipeline with connector-owned shared BlobPort. Connectors use `pipeline.upsert` / `pipeline.delete`, not chunk tables. External identity is scoped by workspace + collection + external ID. Refreshed upstream deletion must call delete; a limited crawl cannot infer deletion from absence in its frontier.
3. Use `createKnowledgeSecurity(authorization,{documentScope})`, delegating to security team's `createAuthorization`. Compose `createKnowledgeResourceLookup(repository,collectionLookup)` into that authorization's resource lookup. It returns tombstone policy for idempotent deletion; active retrieval excludes tombstones. No role/permission system is implemented here. Security's typed principal format is `user:<id>`, `application:<id>` or `service:<id>`.
4. For applications/services, supply security-owned `documentScope` returning principal IDs and permitted source IDs; the default bridge fails closed for their retrieval. User scope follows current security-owned membership + resource policy. Scope never comes from request JSON. Blob reuse is checked against the current permissions of every referencing source and fenced against policy changes.
5. Use `createKnowledgeOutbound({safeFetch,policy})` with security team's outbound implementation/capability. It never enables private networking from document metadata and rejects redirects. Website/content ingestion uses that adapter for every request, including robots and sitemaps. Provider adapters must separately enter security SecretPort/UsagePort and outbound policy.
6. Dispatch `source.ingest` to `pipeline.handleJob(job,{resolveContext,signal})`. Its resource ID is the **persisted ingestion job ID**, not the source ID. Security/runtime must resolve the stored actor and revalidate membership/token scope; queue delivery alone never constructs authority. The pipeline checks actor and tenant match against the persisted job. The existing runtime dispatcher/reconciler must republish/reconcile queued or expired jobs; this branch does not introduce a second Redis retry scheduler.
7. Add versioned routes with `registerKnowledgeRoutes(app,{pipeline,retrieve,answer,getContext})` after identity/browser boundaries. Keep the legacy string-error API untouched. Uploaded bytes enter `pipeline.upload` through runtime's bounded multipart boundary; do not accept actor/context in JSON. The new route module does not independently mount itself in legacy `server/index.js`.
8. Runtime's grounded knowledge nodes must call `createGroundedAnswer` and persist its complete returned citations with run evidence. Streaming provider text must be buffered until citation/claim checks pass. Agent workflows that need tools continue through runtime's approval system; the grounded-answer adapter receives no tools. This branch does not modify runtime's graph execution or shared model provider modules.
9. Runtime owns business retries: classify persisted `retryable` failures and call `pipeline.reindex` within bounded attempt/dead-letter policy. Terminal job redelivery is a no-op; an expired running job can be reclaimed with a newer generation. Run periodic cleanup using a freshly authorized context with document-write authority. Collection/workspace deletion must first delete their knowledge sources and reclaim blobs before deleting the referenced parent rows; foreign keys intentionally prevent an orphan-producing parent delete. Delete/reindex/upsert compare the authorized document fingerprint inside their transaction and fail with CONFLICT if concurrent document changes invalidate that check.

No shared contract files were changed. Proposed integration clarifications: persist/resolve ingestion actor from authoritative jobs; formally standardize typed document principals and application/service document resource scope; clarify that URL ingestion's final version may advance during refresh and is obtained from job status; add collection/workspace deletion orchestration and evidence retention to the coordinator's integration plan.

## Configuration and dependencies

Production dependencies added: `parse5@8.0.1`, `csv-parse@7.0.3`. Test-only: `@electric-sql/pglite@0.5.8`, `@electric-sql/pglite-pgvector@0.0.9`. Existing PDF/DOCX/Transformers/pg dependencies remain. Coordinator should merge manifest requirements and regenerate the lockfile.

`EMBEDDING_CACHE_DIR` selects a provisioned Xenova/all-MiniLM-L6-v2 q8 cache. Production local embeddings run offline; requesting automatic download fails closed. Do not make live workers fetch model assets around the outbound contract. Use a controlled build/provisioning step or an authorized 384-dimensional embedding provider adapter. `OCR_TESSERACT_PATH` and `OCR_LANGUAGE` are suggested deployment settings consumed by composition, not automatic env reads; configure an absolute executable and installed language. Transcription, reranking and generation adapters resolve provider connections through security/runtime.

Evaluation-only settings: `KNOWLEDGE_EVAL_ADAPTER` is an administrator-selected local module exporting `generate`, optionally `verifyClaim`/`close`. Its real model adapter must implement credential/usage/outbound controls. `KNOWLEDGE_EVAL_OUTPUT` and `KNOWLEDGE_CAPACITY_OUTPUT` select synthetic report files. `KNOWLEDGE_CAPACITY_CHUNKS` defaults to 50,000; `KNOWLEDGE_CAPACITY_BACKEND=pglite` exercises embedded PostgreSQL. Service qualification requires `KNOWLEDGE_TEST_DATABASE_URL`; the explicit command fails rather than silently reporting a skipped gate.

## Shared changes and limitations

Shared-file changes: package manifest/lockfile and format inclusion for `server/knowledge`; README links setup/evidence; legacy `server/knowledge.js` delegates file parsing to the safe parser; `server/embedding-worker.js` accepts the offline model flag; `tests/foundation-services.test.js` isolates foundation-only migration qualification from later domain migrations. No production bootstrap, UI, frozen contracts, CI workflow or private environment file changes.

Limits: 15 MiB input, 2 million normalized characters, 200 PDF pages, 25 OCR pages, 32 MiB rendered image output, 20 million pixels/image, 30-second parser time, five-minute ingestion deadline, 10,000 chunks/document, 384-dimensional vectors, 16 embedding inputs/batch, at most 64 pending local embedding batches. PDF/DOCX subprocesses have a 256 MiB V8 heap cap; native allocations require OS/container limits. Parsing isolation is not an OS sandbox or malware scanner. Only UTF-8 text, PNG/JPEG images and WAV/MP3/OGG audio are claimed. Password-protected PDFs, handwriting guarantees, Javascript-rendered websites, authenticated crawls, compressed sitemaps and arbitrary media formats are not supported.

Version snapshots and raw blob references remain until document deletion; retention/archival policy must be configured before large long-lived deployments. Deletion clears active evidence and snapshot bodies but retains tombstone identity/access/fingerprints and operational records. Physically deleting collection/workspace parents additionally requires the coordinator's authorized retention-aware purge of those tombstones and dependent job/version records; the DocumentPort alone does not perform that lifecycle purge. It is not forensic erasure of backups, PostgreSQL free pages, provider records or runtime saved citations. Blob put followed by a process crash before document commit can leave an unreferenced upload; connector/object-storage inventory reconciliation is required because BlobPort has no list API. Index replacement temporarily holds all new vectors in worker memory. ANN recall under narrow filters needs representative staged measurement; exact search is available as a comparison mode. Live-provider outputs and paraphrase entailment remain unqualified.

## External blockers

- Docker's Linux engine was unavailable; no configured disposable network PostgreSQL/Redis was present. Embedded SQL tests passed, but production transport/multi-worker/load qualification remains required.
- No authorized live generation/transcription/rerank connection was configured in this isolated worktree. No credentials were copied from the user's private database. Supply adapters through runtime/security and rerun labeled live evaluations.
- No Tesseract executable/language installation was available. Install it in the worker image and rerun actual scanned-PDF/image recognition tests; rasterization and callback plumbing are verified with explicit fixtures.
- Shared S3 BlobPort, complete bootstrap/queue recovery, actor scopes, usage enforcement and integrated UI are owned by the other production branches. Compose them and run the combined acceptance gates before deployment.
