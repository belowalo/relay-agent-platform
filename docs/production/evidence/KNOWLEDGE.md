# Knowledge verification evidence

Recorded October 5, 2026 on Windows, Node 22.16.0, AMD Ryzen 7 7800X3D. Branch `codex/production-knowledge` starts at foundation `76649286b51b39924261a876878efebf5e02f020`. The final pushed commit is reported in the delivery message. Only synthetic public fixtures and a preprovisioned public embedding model cache were used; no private database, credentials or documents were copied.

## Verification

| Command                                                | Result                         | Scope                                                                                                                                                                                                            |
| ------------------------------------------------------ | ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm run test:knowledge`                               | 17 passed, 0 skipped           | Actual format extraction and scanned-PDF rasterization; durable SQLite jobs/indexing; embedded actual PostgreSQL/pgvector migrations, RLS and filters. OCR/transcription/provider outputs use explicit fixtures. |
| `npm test`                                             | 65 passed, 3 skipped           | Full regression suite. Skips are network PostgreSQL foundation/knowledge and Redis transport tests without configured disposable services.                                                                       |
| `npm run test:browser`                                 | 8 passed                       | Existing app workflow/knowledge browser regression flows. The new production routes require runtime composition and are not mounted in the legacy UI.                                                            |
| `npm run build`                                        | Passed                         | TypeScript and Vite production build.                                                                                                                                                                            |
| `npm run foundation:types` / `npm run knowledge:types` | Passed                         | Shared ports and knowledge adapter types.                                                                                                                                                                        |
| `npm run format:check`                                 | Passed                         | Repository formatting, including the new subsystem and evidence.                                                                                                                                                 |
| `npm run test:knowledge:services`                      | Blocked, explicit nonzero exit | No `KNOWLEDGE_TEST_DATABASE_URL`. This is not a passing service gate.                                                                                                                                            |

The embedded PostgreSQL test uses pgvector 0.8.1 and a restricted, non-owner role with transaction-local tenant binding. Tests exercise RLS directly, cross-collection ownership rejection, actual FTS/vector SQL, ACL and metadata filtering, security-owned source-ID scopes, exact search, reference-only transactional outbox, rollback, cancellation, document-policy authorization races, and stale publication fencing. This is real SQL execution in WASM, not a SQL mock or network deployment.

Other regressions verify signatures and bounded parsing for all supported text formats, actual PDF/DOCX extraction, raster-only PDF conversion, OCR/transcription absence diagnostics, cancellation during embeddings, durable restart, deduplication, version snapshots, stable chunk IDs, complete chunk coverage, URL refresh, robots/sitemap/crawl budgets, HTTP deletion propagation, all-mode deletion/reindexing, restricted blob reuse, immutable retirement, repeated authorized deletion, cleanup after storage failure, source diversity, reranker input permissions, quote validation and post-generation revocation. Fixture generation checks structural containment of hostile document instructions; live model injection resistance remains unqualified.

## Retrieval and answers

The [corpus](../../../tests/knowledge/corpus.json) contains 66 documents and 56 known questions: relevant current policies, ten draft distractors, an outdated policy, conflicting current policies, hostile embedded instructions, a restricted canary and another workspace's canary. This is an authored regression corpus, not independent blinded human review.

Run with an administrator-provisioned offline cache:

```powershell
$env:EMBEDDING_CACHE_DIR='<public MiniLM cache>'
npm run knowledge:eval
```

The [per-question report](knowledge-evaluation.json) records:

| Metric                      | Measured result | Qualification                                                                                              |
| --------------------------- | --------------- | ---------------------------------------------------------------------------------------------------------- |
| Recall@5                    | 100%            | Actual local CPU MiniLM 384-dimensional embeddings and SQLite exact cosine/FTS5 retrieval.                 |
| Mean reciprocal rank        | 0.9811          | Relevant passages defined by the authored corpus.                                                          |
| Retrieval P95               | 16.48 ms        | 56 sequential queries; small synthetic corpus.                                                             |
| Expected-answer checks      | 100%            | **Extractive fixture generation**, not a live LLM.                                                         |
| Citation quote checks       | 100%            | Valid retrieved chunk/version IDs and exact supporting text. Semantic paraphrase support is not qualified. |
| Insufficient-evidence cases | Passed          | Explicit abstention, including restricted/other-workspace evidence.                                        |
| Isolation leaks             | 0 observed      | Fixture authority with actual tenant/document query filters; embedded PostgreSQL separately verifies RLS.  |

Set `KNOWLEDGE_EVAL_ADAPTER` to an administrator-controlled local module implementing an authorized generation adapter to obtain explicitly labeled live results. Add independently reviewed questions and semantic verification before claiming K03's held-out answer quality gate. No live generation, transcription or rerank connection was available here.

## Capacity

Both harness runs stored 50,000 chunks with 384-dimensional **fixture precomputed unit vectors**, ten sequential requests per retrieval mode, one process and one connection. They exclude extraction/model time and production network transport. These measurements do not qualify 10 concurrent requests/second, multiple workers or the one-hour soak.

```powershell
npm run knowledge:capacity
$env:KNOWLEDGE_CAPACITY_BACKEND='pglite'
npm run knowledge:capacity
```

| Measurement         | SQLite development | Embedded PostgreSQL/pgvector |
| ------------------- | ------------------ | ---------------------------- |
| Indexing time       | 19.20 s            | 115.34 s                     |
| Indexing throughput | 2,604 chunks/s     | 433 chunks/s                 |
| Keyword P95         | 81.27 ms           | 25.30 ms                     |
| Vector P95          | 1,129.08 ms        | 42.58 ms                     |
| Hybrid P95          | 755.81 ms          | 65.28 ms                     |
| Database size       | 140,522,640 bytes  | 261,357,568 bytes            |
| Process RSS         | 685,973,504 bytes  | 1,164,185,600 bytes          |

The [embedded report](knowledge-pgvector-capacity.json) records ANALYZE before queries and EXPLAIN-confirmed `knowledge_vectors_ann` HNSW use. Ten synthetic comparisons against exact search achieved recall@5 100%. Narrow ACL/metadata filters, varied corpora, concurrency and network PostgreSQL require staged measurement; this sample is not a universal ANN recall guarantee. The [SQLite report](knowledge-capacity.json) intentionally exposes its development adapter's exact-scan cost.

## Remaining release gates

- Configure disposable network PostgreSQL/pgvector and Redis and rerun service gates. Docker's Linux engine was unavailable in this environment. No other user's services were stopped or modified.
- Install Tesseract and language data in the worker image; run actual scanned-PDF/image recognition. Provider callbacks and rasterization are verified, recognition quality is not.
- Supply security/runtime-authorized generation, transcription and optional rerank adapters; rerun labeled live output/injection evaluations and held-out human review.
- Compose runtime migrations/bootstrap, connector BlobPort, shared authorization/outbound policy, fresh worker actor resolution, queue reconciliation/retries and saved-citation persistence. Run integrated multi-worker cancellation/recovery and staged capacity/soak gates.

Setup, exact composition seams and processing limits are in [KNOWLEDGE.md](../KNOWLEDGE.md) and the [handoff](../handoffs/knowledge.md). No merge, deployment or private document publication is part of this delivery.
