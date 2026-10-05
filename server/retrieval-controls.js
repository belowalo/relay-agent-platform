import { z } from 'zod';
import { one, decode, decrypt } from './db.js';
import { safeFetch, responseText } from './network.js';

export const retrievalOptions = z.object({
  sourceIds: z.array(z.string().max(100)).max(100).optional(),
  nameContains: z.string().max(100).optional(),
  metadata: z
    .record(
      z.string().regex(/^[A-Za-z0-9_-]{1,60}$/),
      z.union([z.string().max(500), z.number(), z.boolean()]),
    )
    .refine((v) => Object.keys(v).length <= 20)
    .optional(),
  minScore: z.number().min(-1).max(1).optional(),
  maxPerSource: z.number().int().min(1).max(20).optional(),
  rerankConnectionId: z.string().optional(),
  rerankModel: z.string().max(200).optional(),
});
export function sourceFilter(options) {
  let sql = '';
  const args = [];
  if (options.sourceIds) {
    sql += ' AND s.id IN (SELECT value FROM json_each(?))';
    args.push(JSON.stringify(options.sourceIds));
  }
  if (options.nameContains) {
    sql += ' AND instr(lower(s.name),lower(?))>0';
    args.push(options.nameContains);
  }
  for (const [key, value] of Object.entries(options.metadata || {})) {
    sql += ' AND json_extract(s.metadata,?)=?';
    args.push(`$."${key}"`, typeof value === 'boolean' ? Number(value) : value);
  }
  return { sql, args };
}
export async function rerank(wid, query, candidates, options) {
  if (!options.rerankConnectionId || !candidates.length) return candidates;
  const c = one(
    'SELECT * FROM connections WHERE id=? AND workspace_id=?',
    options.rerankConnectionId,
    wid,
  );
  if (!c) throw new Error('Rerank connection was not found in this workspace');
  if (!options.rerankModel && !c.model) throw new Error('Choose a rerank model identifier');
  const response = await safeFetch(
    c.endpoint.replace(/\/$/, '') + '/rerank',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${decrypt(c.secret)}` },
      body: JSON.stringify({
        model: options.rerankModel || c.model,
        query,
        documents: candidates.map((r) => r.content),
        top_n: candidates.length,
      }),
      signal: AbortSignal.timeout(30000),
      noRedirect: true,
    },
    !!decode(c.config).allowPrivate,
  );
  if (!response.ok) throw new Error(`Rerank provider returned HTTP ${response.status}`);
  const data = JSON.parse(await responseText(response));
  const indices = new Set();
  if (
    !Array.isArray(data.results) ||
    data.results.length !== candidates.length ||
    data.results.some(
      (r) =>
        !Number.isInteger(r.index) ||
        r.index < 0 ||
        r.index >= candidates.length ||
        indices.has(r.index) ||
        !Number.isFinite(r.relevance_score) ||
        (indices.add(r.index), false),
    )
  )
    throw new Error('Rerank provider returned invalid results');
  return data.results
    .map((r) => ({ ...candidates[r.index], score: r.relevance_score, reranked: true }))
    .sort((a, b) => b.score - a.score);
}
