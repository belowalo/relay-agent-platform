import { all, one, exec, id, now, transaction } from './db.js';
import { safeFetch, responseText } from './network.js';
import { workerId } from './leases.js';
import { embed, embeddingIdentity, similarity } from './embeddings.js';
import { retrievalOptions, sourceFilter, rerank } from './retrieval-controls.js';
import { parseFile } from './knowledge/extract.js';
export function readable(html) {
  return html
    .replace(/<(script|style|nav)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim();
}
export async function parseDocument(buffer, name) {
  return (await parseFile(buffer, name)).segments.map((s) => s.text).join('\n');
}
export async function indexSource(sourceId) {
  const source = one('SELECT * FROM sources WHERE id=?', sourceId);
  if (!source) return;
  const claimed = exec(
    "UPDATE sources SET status='indexing',progress=10,error=NULL,index_generation=index_generation+1,index_lease_owner=?,index_lease_until=? WHERE id=? AND (status='queued' OR (status='indexing' AND (index_lease_until IS NULL OR index_lease_until<?)))",
    workerId,
    Date.now() + 5000,
    sourceId,
    Date.now(),
  );
  if (!claimed.changes) return;
  const generation = one(
    'SELECT index_generation FROM sources WHERE id=?',
    sourceId,
  ).index_generation;
  const heartbeat = setInterval(
    () =>
      exec(
        "UPDATE sources SET index_lease_until=? WHERE id=? AND index_generation=? AND index_lease_owner=? AND status='indexing'",
        Date.now() + 5000,
        sourceId,
        generation,
        workerId,
      ),
    1000,
  );
  try {
    const collection = one('SELECT * FROM collections WHERE id=?', source.collection_id);
    const config = JSON.parse(collection.config);
    const size = Math.max(200, Math.min(4000, Number(config.chunkSize) || 1000));
    const overlap = Math.max(0, Math.min(size / 2, Number(config.overlap) || 150));
    if (!source.content.trim()) throw new Error('No readable text was found in the document');
    const pieces = [];
    for (let offset = 0; offset < source.content.length; offset += size - overlap)
      pieces.push(source.content.slice(offset, offset + size));
    if (pieces.length > 10000) throw new Error('Source exceeds the 10,000 chunk limit');
    const vectors = [];
    if (['semantic', 'hybrid'].includes(config.retrieval)) {
      for (let i = 0; i < pieces.length; i += 16) {
        vectors.push(...(await embed(source.workspace_id, pieces.slice(i, i + 16), config)));
        const changed = exec(
          "UPDATE sources SET progress=? WHERE id=? AND index_generation=? AND status='indexing'",
          Math.round(10 + (80 * Math.min(pieces.length, i + 16)) / pieces.length),
          sourceId,
          generation,
        );
        if (!changed.changes) return;
      }
    }
    transaction(() => {
      if (
        !one(
          "SELECT id FROM sources WHERE id=? AND index_generation=? AND status='indexing'",
          sourceId,
          generation,
        )
      )
        return;
      exec(
        'DELETE FROM chunk_search WHERE chunk_id IN (SELECT id FROM chunks WHERE source_id=?)',
        sourceId,
      );
      exec('DELETE FROM chunks WHERE source_id=?', sourceId);
      let ordinal = 0;
      for (const text of pieces) {
        const chunkId = id(),
          vector = vectors[ordinal];
        exec(
          'INSERT INTO chunks VALUES(?,?,?,?,?,?)',
          chunkId,
          source.workspace_id,
          source.collection_id,
          sourceId,
          ordinal++,
          text,
        );
        exec(
          'INSERT INTO chunk_search(content,chunk_id,workspace_id,collection_id) VALUES(?,?,?,?)',
          text,
          chunkId,
          source.workspace_id,
          source.collection_id,
        );
        if (vector)
          exec(
            'INSERT INTO embeddings VALUES(?,?,?,?,?)',
            chunkId,
            source.workspace_id,
            source.collection_id,
            embeddingIdentity(config),
            JSON.stringify(vector),
          );
      }
      exec("UPDATE sources SET status='ready',progress=100 WHERE id=?", sourceId);
    });
  } catch (e) {
    exec(
      "UPDATE sources SET status='failed',error=? WHERE id=? AND index_generation=?",
      String(e.message),
      sourceId,
      generation,
    );
  } finally {
    clearInterval(heartbeat);
  }
}
export function addSource(wid, collectionId, name, content, url = null) {
  if (!one('SELECT id FROM collections WHERE id=? AND workspace_id=?', collectionId, wid))
    throw new Error('Knowledge collection was not found');
  const sid = id();
  exec(
    'INSERT INTO sources(id,workspace_id,collection_id,name,url,status,content,progress,error,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)',
    sid,
    wid,
    collectionId,
    name,
    url,
    'queued',
    content,
    0,
    null,
    now(),
  );
  setImmediate(() => indexSource(sid));
  return sid;
}
export async function ingestWebsite(wid, collectionId, url) {
  const r = await safeFetch(url, { signal: AbortSignal.timeout(15000) });
  if (!r.ok) throw new Error(`Website returned HTTP ${r.status}`);
  return addSource(wid, collectionId, new URL(url).hostname, readable(await responseText(r)), url);
}
export async function crawlWebsite(wid, collectionId, start, maxPages = 1) {
  const limit = Math.max(1, Math.min(20, Number(maxPages) || 1));
  const root = new URL(start),
    queue = [root.href],
    visited = new Set(),
    ids = [];
  let disallow = [];
  try {
    const r = await safeFetch(new URL('/robots.txt', root).href, {
      signal: AbortSignal.timeout(5000),
    });
    if (r.ok) {
      let applies = false;
      for (const line of (await responseText(r, 50000)).split('\n')) {
        const [key, ...parts] = line.split(':');
        const value = parts.join(':').trim().split('#')[0].trim();
        if (key.trim().toLowerCase() === 'user-agent') applies = value === '*';
        if (applies && key.trim().toLowerCase() === 'disallow' && value) disallow.push(value);
      }
    }
  } catch {}
  while (queue.length && ids.length < limit && visited.size < limit * 4) {
    const page = new URL(queue.shift());
    page.hash = '';
    if (
      visited.has(page.href) ||
      page.origin !== root.origin ||
      disallow.some((p) => page.pathname.startsWith(p))
    )
      continue;
    visited.add(page.href);
    if (
      one(
        'SELECT id FROM sources WHERE workspace_id=? AND collection_id=? AND url=?',
        wid,
        collectionId,
        page.href,
      )
    )
      continue;
    const r = await safeFetch(page.href, { signal: AbortSignal.timeout(15000) });
    if (!r.ok) {
      if (!ids.length) throw new Error(`Website returned HTTP ${r.status}`);
      continue;
    }
    if (r.url && new URL(r.url).origin !== root.origin) continue;
    const html = await responseText(r);
    const content = readable(html);
    if (!content) continue;
    ids.push(addSource(wid, collectionId, page.hostname + page.pathname, content, page.href));
    if (limit > 1)
      for (const match of html.matchAll(/href\s*=\s*["']([^"']+)["']/gi)) {
        try {
          const next = new URL(match[1], page);
          next.hash = '';
          if (
            next.origin === root.origin &&
            !/\.(pdf|zip|png|jpg|mp4|exe)$/i.test(next.pathname) &&
            queue.length < 200
          )
            queue.push(next.href);
        } catch {}
      }
  }
  if (!ids.length)
    throw new Error('No new permitted pages were found; existing sources can be reindexed');
  return ids;
}
export async function retrieve(wid, collectionId, query, topK = 4, options = {}) {
  const collection = one(
    'SELECT * FROM collections WHERE id=? AND workspace_id=?',
    collectionId,
    wid,
  );
  if (!collection)
    throw new Error('Knowledge collection is outside this workspace or does not exist');
  const config = JSON.parse(collection.config);
  options = retrievalOptions.parse(options || {});
  if (options.minScore != null && config.retrieval === 'lexical' && !options.rerankConnectionId)
    throw new Error('Score thresholds require semantic retrieval or a rerank model');
  const filter = sourceFilter(options);
  const count = Math.max(1, Math.min(20, Number(topK) || 4));
  const terms =
    String(query)
      .match(/[\p{L}\p{N}]+/gu)
      ?.slice(0, 20) || [];
  if (!terms.length) return [];
  const match = terms.map((t) => '"' + t.replaceAll('"', '') + '"').join(' OR ');
  const lexical = all(
    "SELECT c.id AS chunkId,c.content,c.ordinal,s.id AS sourceId,s.name AS source,s.url,s.metadata,bm25(chunk_search) AS score FROM chunk_search JOIN chunks c ON c.id=chunk_search.chunk_id JOIN sources s ON s.id=c.source_id WHERE chunk_search MATCH ? AND chunk_search.workspace_id=? AND chunk_search.collection_id=? AND s.status='ready'" +
      filter.sql +
      ' ORDER BY score LIMIT ?',
    match,
    wid,
    collectionId,
    ...filter.args,
    count * 4,
  );
  let results = lexical;
  if (['semantic', 'hybrid'].includes(config.retrieval)) {
    const [vector] = await embed(wid, [String(query).slice(0, 8000)], config);
    const semantic = all(
      "SELECT c.id AS chunkId,c.content,c.ordinal,s.id AS sourceId,s.name AS source,s.url,s.metadata,e.vector FROM embeddings e JOIN chunks c ON c.id=e.chunk_id JOIN sources s ON s.id=c.source_id WHERE e.workspace_id=? AND e.collection_id=? AND e.model=? AND s.status='ready'" +
        filter.sql,
      wid,
      collectionId,
      embeddingIdentity(config),
      ...filter.args,
    )
      .map(({ vector: stored, ...row }) => ({
        ...row,
        score: similarity(vector, JSON.parse(stored)),
        similarity: similarity(vector, JSON.parse(stored)),
      }))
      .filter(
        (r) =>
          options.rerankConnectionId ||
          options.minScore == null ||
          r.similarity >= options.minScore,
      )
      .sort((a, b) => b.score - a.score)
      .slice(0, count * 4);
    if (config.retrieval === 'semantic') results = semantic;
    else {
      const ranks = new Map();
      for (const list of [lexical, semantic])
        list.forEach((row, i) => {
          const prior = ranks.get(row.chunkId);
          ranks.set(row.chunkId, { ...row, score: (prior?.score || 0) + 1 / (60 + i + 1) });
        });
      results = [...ranks.values()].sort((a, b) => b.score - a.score);
      if (options.minScore != null && !options.rerankConnectionId)
        results = results.filter((r) => r.similarity != null && r.similarity >= options.minScore);
    }
  }
  results = await rerank(wid, String(query), results, options);
  if (options.rerankConnectionId && options.minScore != null)
    results = results.filter((r) => r.score >= options.minScore);
  const perSource = new Map();
  results = results.filter((r) => {
    const prior = perSource.get(r.sourceId) || 0;
    if (options.maxPerSource && prior >= options.maxPerSource) return false;
    perSource.set(r.sourceId, prior + 1);
    return true;
  });
  return results.slice(0, count).map((r) => ({
    ...r,
    metadata: JSON.parse(r.metadata || '{}'),
    retrieval: config.retrieval || 'lexical',
    citation: `[${r.source}, chunk ${r.ordinal + 1}]`,
  }));
}
export function deleteSource(sid, wid) {
  transaction(() => {
    exec(
      'DELETE FROM chunk_search WHERE workspace_id=? AND chunk_id IN (SELECT id FROM chunks WHERE source_id=?)',
      wid,
      sid,
    );
    exec('DELETE FROM sources WHERE id=? AND workspace_id=?', sid, wid);
  });
}
