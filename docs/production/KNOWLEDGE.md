# Knowledge setup and integration

Use Node.js 22.16+, the foundation DatabasePort, PostgreSQL with pgvector >= 0.8, the runtime outbox dispatcher, security authorization/outbound adapters and the connector team's shared BlobPort. This subsystem is exported from `server/knowledge/index.js`. Legacy local entry points do not automatically enable its production routes or worker handler.

## Compose the subsystem

```javascript
import {
  createKnowledgeRepository,
  createKnowledgePipeline,
  createKnowledgeSecurity,
  createKnowledgeResourceLookup,
  createKnowledgeOutbound,
  createLocalEmbeddings,
  createNativeOcr,
  createRetriever,
  createGroundedAnswer,
  registerKnowledgeRoutes,
} from './server/knowledge/index.js';

const repository = createKnowledgeRepository(database);
const knowledgeLookup = createKnowledgeResourceLookup(repository, collectionLookup);
// Construct security's authorization with a resourceLookup that delegates
// collection/document resources to knowledgeLookup and other resources to runtime.
const security = createKnowledgeSecurity(authorization, {
  documentScope: securityDocumentScope,
});
const outbound = createKnowledgeOutbound({
  safeFetch: securitySafeFetch,
  policy: publicOutboundPolicy,
});
const embeddings = createLocalEmbeddings({ cacheDir: configuredModelCache });
const ocr = configuredTesseractPath
  ? createNativeOcr({
      executable: configuredTesseractPath,
      language: configuredOcrLanguage || 'eng',
    })
  : undefined;
const pipeline = createKnowledgePipeline({
  repository,
  blobs: sharedBlobPort,
  security,
  outbound,
  embeddings,
  ocr,
  transcribe: authorizedTranscriptionAdapter,
});
const retrieve = createRetriever({
  repository,
  security,
  embeddings,
  rerank: authorizedRerankAdapter,
});
const answer = createGroundedAnswer({
  retrieve,
  repository,
  security,
  generate: authorizedGroundedModelAdapter,
  // Omit verifyClaim for strict extractive-only statements. A paraphrase verifier
  // must be independently evaluated and must not blindly accept the model's claims.
  verifyClaim: evaluatedClaimVerifier,
});
registerKnowledgeRoutes(app, { pipeline, retrieve, answer, getContext: verifiedRequestContext });
// Runtime dispatch, after authoritative actor revalidation:
await pipeline.handleJob(job, { resolveContext: revalidateStoredIngestionActor, signal });
// Connector DocumentPort:
const documents = { upsert: pipeline.upsert, delete: pipeline.delete };
```

The names supplied by runtime/security above are composition dependencies, not global objects or new identity systems. The API and worker must use the same shared database/blob/model configuration. Workers run model inference offline from a preprovisioned q8 MiniLM cache; missing assets fail with actionable diagnostics. A provider embedding adapter must return exactly 384 finite nonzero dimensions and a stable model identity; changing models requires collection reindexing. Provider generation/transcription/rerank adapters enforce current credentials, outbound requests, cancellation and UsagePort reservations. Unknown provider costs are not considered free.

Apply `0300-knowledge.sql` after runtime's domain migration. It depends on `relay.workspaces(id)` and `relay.collections(id,workspace_id)`. Use dedicated migration credentials and grant CRUD/USAGE to a restricted non-owner role. Refresh planner statistics after bulk ingestion and inspect filtered ANN plans; the capacity harness runs ANALYZE and records actual HNSW use. The branch's standalone PostgreSQL service test creates minimum runtime fixture tables only in a database named `relay_knowledge_test...`; those fixtures must never be used as the production runtime migration.

## Document and search API

The versioned prefix is `/api/v1/knowledge`. Request context always comes from verified authentication, never the body. Restricted principal IDs use security's typed IDs such as `user:alice`.

```json
{
  "collectionId": "operations",
  "externalId": "drive-document-123",
  "name": "Retention policy.md",
  "text": "Records expire after 180 days.",
  "metadata": { "state": "current", "department": "operations" },
  "access": { "mode": "restricted", "principalIds": ["user:alice"] }
}
```

`POST /documents` returns `{sourceId,version,jobId}`. Supply text **or** a validated workspace BlobReference **or** a URL; URL can also accompany text/blob as provenance. Blob reuse checks all referencing document policies. Upload buffers enter `pipeline.upload(context,input,bytes,validatedContentType)` through runtime's multipart boundary. Supported file extensions: txt, md/markdown, html/htm, csv, json, pdf, docx, png, jpg/jpeg, wav, mp3, ogg. Structured text becomes normalized text; HTML never executes scripts or loads resources. Source previews are plain text and should be rendered as text.

`GET /jobs/:jobId` returns state, progress, phase, final version, sanitized error and authorized diagnostics. `POST /jobs/:jobId/cancel` fences in-flight publication. `POST /documents/:sourceId/reindex` schedules a new durable job; `DELETE /documents/:sourceId` removes active evidence and retires blobs. Unchanged connector refreshes reuse a version/job; changed text, metadata or access produces a new version. A URL-only source should be explicitly reindexed to refresh it: fetched content gets its own persisted extraction snapshot, and changed extraction advances the final version shown in job status. Old ready evidence remains available until atomic replacement, under the document's **current** access policy.

`POST /collections/:collectionId/search` accepts:

```json
{
  "query": "When do records expire?",
  "options": {
    "mode": "hybrid",
    "topK": 5,
    "metadata": { "state": "current" },
    "maxPerSource": 2,
    "minSimilarity": 0.3
  }
}
```

Modes are `keyword`, `vector` and `hybrid`. Optional `sourceIds` narrow the authenticated security scope. Empty source IDs mean no evidence. Metadata compares exact scalar values. Cosine thresholds only apply to vector/hybrid evidence; lexical rank, reciprocal-rank fusion and rerank scores are distinct scales. `rerank:true` calls the configured provider, whose adapter returns one finite [0,1] score per candidate; `minRerankScore` is separate. `exact:true` disables PostgreSQL index scans for recall diagnostics. PostgreSQL may select exact plans for selective filters even when HNSW is enabled. Test filtered recall and inspect plans on the deployed corpus rather than assuming a plan from the configured index name.

Responses include evidence with `{workspaceId,collectionId,sourceId,sourceVersion,chunkId,text,score,location}`, source name, metadata, plain-text preview and retrieval diagnostics. Locations refer to normalized extraction offsets and, where available, PDF page and source URL. Chunk IDs are deterministic for a source version, offset and passage. Reindexing unchanged extraction/chunk settings preserves them; changed evidence receives a new version and IDs.

`POST /collections/:collectionId/answer` accepts `question` and the same options. The model adapter gets an empty tool set and evidence as untrusted data. The response contains validated claims, labeled text, full citations, insufficient/conflict flags and retrieval diagnostics. Unknown chunk IDs, invented quotations and unverified claims fail closed. By default only exact quotation claims are accepted; configure an independently qualified semantic verifier for paraphrases. Buffer any model stream until validation and authorization rechecks finish. Runtime must retain the returned citations with the run; later document deletion must follow runtime's explicit saved-evidence retention policy.

## Website refresh

URL ingestion respects robots rules and the security outbound adapter, refuses redirects and accepts HTML only. For bounded background crawling, set `metadata.crawlMaxPages` to an integer between 2 and 200. The root's job diagnostics list child source/version/job references and crawl budgets/failures; child indexing is independently queued. Crawl defaults are 20 pages, 50 requests, 10 MB total, one minute and five sitemaps. The direct crawler API allows up to 200 pages/500 requests/30 MB/five minutes/10 sitemaps. All URLs remain on the starting origin. Query URLs are excluded by default, tracking parameters/fragments are canonicalized, and repeated/deep paths and calendar/search/login/cart traps are excluded.

Sitemap indexes and uncompressed `<loc>` URLs are supported. DTD/entity declarations are rejected; compressed maps and dynamic Javascript pages are not supported. Robots 401/403 denies crawling; 429/5xx/network failures fail closed; missing robots (404) permits crawling. Allowed paths follow the longest matching robots rule, with Allow winning ties. Conditional ETags avoid unchanged fetches. A fetched 404/410 deletes an existing source. Pages omitted by budgets, robots or a partial frontier are **not** treated as deleted. Connectors must propagate authoritative upstream removals through DocumentPort.

## Operate and recover

Queues contain only shared v1 references. Business state and sanitized error detail live in PostgreSQL. A worker checks current permissions before reading a blob/fetching, before embedding batches, on heartbeat and before publication. Superseded/cancelled leases cannot publish. Redis transport is not an independent business retry system. Runtime should reconcile pending outbox references and expired jobs, schedule bounded retries for classified failures and dead-letter exhausted work. A manual reindex is an explicit retry; duplicate unchanged upsert does not retry a failed version silently.

Call `pipeline.cleanup` under freshly revalidated document-write authority for pending blob retirement. Storage failure leaves a durable pending record. Current references prevent reclamation, and retired keys remain unavailable for future upserts. Before deleting a collection/workspace, delete its sources and reclaim their blobs. The coordinator must then perform a security-authorized, retention-aware purge of the tombstones and their job/version records before physically removing parent rows; this subsystem exposes document tombstoning, not parent lifecycle purging. PostgreSQL parent references deliberately prevent silent orphaning. Backups must include knowledge tables, vectors, blobs and runtime saved evidence. Object-storage inventory reconciliation must handle uploads abandoned before the document transaction commits.

Default processing budgets and unsupported cases are listed in the [handoff](handoffs/knowledge.md). Set worker OS/container CPU, native-memory, filesystem and network restrictions; the parser child process's V8 heap limit does not cap every native allocation. Configure corpus/version retention before long-lived deployments. No paid infrastructure, live credential, deployment or private document publication is performed by this branch.

## Evaluate

`npm run test:knowledge` runs actual parsers, the durable SQLite pipeline and embedded PostgreSQL/pgvector SQL/RLS tests. `npm run knowledge:eval` uses actual offline MiniLM embeddings; `--fixture-embeddings` explicitly switches to hashed fixtures. The default answer adapter is labeled extractive fixture output. To exercise a configured live model, set `KNOWLEDGE_EVAL_ADAPTER` to an authorized local module exporting `generate(context,request)` and optionally `verifyClaim`/`close`, then rerun. Reports retain per-question recall, expected-answer checks, citation quote validity, abstention, conflicts, leakage and latency. Obtain independent held-out human review before treating those as K03 production quality evidence.

Run `npm run knowledge:capacity` for 50,000-chunk SQLite storage/retrieval; set `KNOWLEDGE_CAPACITY_BACKEND=pglite` for actual embedded PostgreSQL/pgvector. Both exclude actual model and parser time and use synthetic vectors. Neither substitutes for networked PostgreSQL/Redis/S3 and the acceptance profile's concurrent throughput, multi-worker failures and one-hour soak. `npm run test:knowledge:services` fails if its disposable database URL is absent, avoiding a silent qualification claim.

Implementation references: [pgvector filtering and iterative scans](https://github.com/pgvector/pgvector), [PGlite extensions](https://pglite.dev/extensions/), [Mammoth security guidance](https://github.com/mwilliamson/mammoth.js), [PDFParse](https://www.npmjs.com/package/pdf-parse). These inform index/extraction choices; the shipped tests and measured artifacts determine what this branch has verified.
