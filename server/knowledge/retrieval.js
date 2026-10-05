import {
  context,
  searchSchema,
  failure,
  normalizeVectors,
  checkSignal,
  principalId,
} from './contracts.js';
import { citationSchema, resourceId } from '../foundation/contracts.js';

export function reciprocalRank(lists) {
  const ranked = new Map();
  for (const list of lists)
    list.forEach((row, index) => {
      const prior = ranked.get(row.id);
      ranked.set(row.id, { ...prior, ...row, score: (prior?.score || 0) + 1 / (60 + index + 1) });
    });
  return [...ranked.values()].sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
}
export function createRetriever({ repository, security, embeddings, rerank } = {}) {
  if (!repository || !security?.authorize || !security?.documentPrincipals || !embeddings)
    throw failure('VALIDATION_ERROR', 'Retrieval requires storage, security, and embeddings.');
  return async function retrieve(ctx, collectionId, query, options = {}, { signal } = {}) {
    const start = performance.now();
    ctx = context(ctx);
    resourceId.parse(collectionId);
    options = searchSchema.parse(options);
    if (typeof query !== 'string' || !query.trim() || query.length > 8000)
      throw failure('VALIDATION_ERROR', 'Query must contain 1–8000 characters.');
    if (options.minRerankScore !== undefined && !options.rerank)
      throw failure('VALIDATION_ERROR', 'A rerank threshold requires reranking.');
    if (options.mode === 'keyword' && options.minSimilarity !== undefined)
      throw failure('VALIDATION_ERROR', 'Cosine thresholds require vector or hybrid retrieval.');
    await security.authorize(ctx, { action: 'documents.search', collectionId });
    const scope = security.documentScope
      ? await security.documentScope(ctx, { collectionId })
      : { principalIds: await security.documentPrincipals(ctx, { collectionId }) };
    const principals = scope.principalIds;
    if (
      !Array.isArray(principals) ||
      principals.length > 100 ||
      principals.some((p) => !principalId.safeParse(p).success)
    )
      throw failure('FORBIDDEN', 'Security returned an invalid document scope.');
    if (
      scope.sourceIds !== undefined &&
      (!Array.isArray(scope.sourceIds) ||
        scope.sourceIds.length > 10000 ||
        scope.sourceIds.some((p) => !resourceId.safeParse(p).success))
    )
      throw failure('FORBIDDEN', 'Security returned invalid document resource IDs.');
    checkSignal(signal);
    let vector;
    if (options.mode !== 'keyword')
      [vector] = normalizeVectors(await embeddings.embed(ctx, [query], { signal }), 1);
    const lists = await repository.candidates(
      ctx,
      collectionId,
      query,
      vector,
      options,
      principals,
      embeddings.model,
      scope.sourceIds,
    );
    let results =
      options.mode === 'keyword'
        ? lists.lexical
        : options.mode === 'vector'
          ? lists.semantic
          : reciprocalRank([lists.lexical, lists.semantic]);
    if (options.minSimilarity !== undefined)
      results = results.filter(
        (r) => r.similarity !== undefined && r.similarity >= options.minSimilarity,
      );
    // Revalidate every candidate before sending its text to a reranking provider.
    const authorized = [];
    for (const row of results) {
      const source = await repository.getSource(ctx, row.source_id);
      if (!source || source.deleted || source.indexed_version !== row.version) continue;
      await security.authorize(ctx, {
        action: 'documents.read',
        collectionId,
        sourceId: row.source_id,
        access: source.access,
      });
      authorized.push(row);
    }
    results = authorized;
    if (options.rerank) {
      if (!rerank)
        throw failure('DEPENDENCY_UNAVAILABLE', 'Configure an authorized reranking provider.');
      const scores = await rerank(
        ctx,
        query,
        results.map((r) => r.content),
        { signal },
      );
      if (
        !Array.isArray(scores) ||
        scores.length !== results.length ||
        scores.some((s) => !Number.isFinite(s) || s < 0 || s > 1)
      )
        throw failure(
          'DEPENDENCY_UNAVAILABLE',
          'Reranker must return one finite [0,1] score per candidate.',
        );
      results = results
        .map((r, i) => ({ ...r, score: scores[i] }))
        .sort((a, b) => b.score - a.score);
      if (options.minRerankScore !== undefined)
        results = results.filter((r) => r.score >= options.minRerankScore);
    }
    const counts = new Map();
    results = results
      .filter((r) => {
        const n = counts.get(r.source_id) || 0;
        counts.set(r.source_id, n + 1);
        return n < options.maxPerSource;
      })
      .slice(0, options.topK);
    // Revalidate membership and candidate ACLs after any external model call (revocation can race it).
    await security.authorize(ctx, { action: 'documents.search', collectionId });
    const evidence = [];
    for (const row of results) {
      const source = await repository.getSource(ctx, row.source_id);
      if (!source || source.deleted || source.indexed_version !== row.version) continue;
      await security.authorize(ctx, {
        action: 'documents.read',
        collectionId,
        sourceId: row.source_id,
        access: source.access,
      });
      evidence.push({
        citation: citationSchema.parse({
          workspaceId: ctx.workspaceId,
          collectionId,
          sourceId: row.source_id,
          sourceVersion: row.version,
          chunkId: row.id,
          text: row.content,
          score: Number(row.score),
          location: row.location,
        }),
        source: row.name,
        metadata: row.metadata,
        preview: row.content.slice(0, 320),
        similarity: row.similarity,
      });
    }
    return {
      evidence,
      diagnostics: {
        mode: options.mode,
        scoreMode: options.rerank
          ? 'reranker'
          : options.mode === 'hybrid'
            ? 'reciprocal-rank-fusion'
            : options.mode === 'vector'
              ? 'cosine'
              : 'full-text-rank',
        candidateCount: lists.lexical.length + lists.semantic.length,
        returned: evidence.length,
        durationMs: performance.now() - start,
        embeddingModel: options.mode === 'keyword' ? null : embeddings.model,
        index:
          repository.dialect === 'postgres'
            ? options.exact
              ? 'pgvector-exact'
              : 'pgvector-hnsw-enabled'
            : 'sqlite-exact-development',
        filteredBeforeRanking: true,
      },
    };
  };
}
