import { parse } from 'parse5';
import { boundedText } from './pipeline.js';
import { parseFile } from './extract.js';
import { failure, checkSignal } from './contracts.js';

export function canonicalUrl(value, root, { allowQuery = false } = {}) {
  let u;
  try {
    u = new URL(value, root);
  } catch {
    return null;
  }
  if (
    !['http:', 'https:'].includes(u.protocol) ||
    u.username ||
    u.password ||
    u.origin !== new URL(root).origin
  )
    return null;
  u.hash = '';
  for (const key of [...u.searchParams.keys()])
    if (/^(utm_|fbclid|gclid)/i.test(key)) u.searchParams.delete(key);
  if (!allowQuery && u.search) return null;
  u.searchParams.sort();
  const parts = u.pathname.split('/').filter(Boolean);
  if (
    parts.length > 12 ||
    parts.some((p, i) => parts.indexOf(p) < i) ||
    /\/(calendar|search|login|logout|cart)(\/|$)/i.test(u.pathname) ||
    /\.(zip|exe|png|jpe?g|gif|mp4|pdf|docx|wav|mp3)$/i.test(u.pathname)
  )
    return null;
  return u.href;
}
export function robotsPolicy(text, userAgent = 'relayknowledge') {
  const groups = [];
  let group = null,
    rulesStarted = false;
  const sitemaps = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.split('#')[0],
      colon = line.indexOf(':');
    if (colon < 0) continue;
    const key = line.slice(0, colon).trim().toLowerCase(),
      value = line.slice(colon + 1).trim();
    if (key === 'sitemap') {
      if (sitemaps.length < 100 && value.length <= 4000) sitemaps.push(value);
      continue;
    }
    if (key === 'user-agent') {
      if (!value) continue;
      if (groups.length >= 1000 || group?.agents.length >= 100)
        throw failure('BUDGET_EXCEEDED', 'Robots user-agent budget exceeded.');
      if (!group || rulesStarted) {
        group = { agents: [], rules: [] };
        groups.push(group);
        rulesStarted = false;
      }
      group.agents.push(value.toLowerCase());
    } else if (group && ['allow', 'disallow'].includes(key)) {
      rulesStarted = true;
      if (value) {
        if (value.length > 4000 || groups.reduce((n, g) => n + g.rules.length, 0) >= 2000)
          throw failure('BUDGET_EXCEEDED', 'Robots rule budget exceeded.');
        group.rules.push({ allow: key === 'allow', path: value });
      }
    }
  }
  let selected = groups.filter((g) => g.agents.some((a) => a !== '*' && userAgent.includes(a)));
  if (selected.length) {
    const specificity = (g) =>
      Math.max(...g.agents.filter((a) => a !== '*' && userAgent.includes(a)).map((a) => a.length));
    const longest = Math.max(...selected.map(specificity));
    selected = selected.filter((g) => specificity(g) === longest);
  }
  if (!selected.length) selected = groups.filter((g) => g.agents.includes('*'));
  const rules = selected.flatMap((g) => g.rules);
  return {
    sitemaps,
    allowed(url) {
      const u = new URL(url),
        path = u.pathname + u.search;
      const matching = rules
        .filter((r) => robotPathMatches(r.path, path))
        .sort(
          (a, b) =>
            b.path.replace(/[*$]/g, '').length - a.path.replace(/[*$]/g, '').length ||
            Number(b.allow) - Number(a.allow),
        );
      return !matching.length || matching[0].allow;
    },
  };
}
// Match robots wildcards without constructing potentially exponential regular expressions.
function robotPathMatches(pattern, path) {
  const anchored = pattern.endsWith('$');
  if (anchored) pattern = pattern.slice(0, -1);
  const parts = pattern.split('*');
  if (!path.startsWith(parts[0])) return false;
  let offset = parts[0].length;
  for (let i = 1; i < parts.length; i++) {
    const part = parts[i];
    if (i === parts.length - 1 && anchored) {
      const last = path.length - part.length;
      return last >= offset && path.endsWith(part);
    }
    const at = path.indexOf(part, offset);
    if (at < 0) return false;
    offset = at + part.length;
  }
  return !anchored || offset === path.length;
}
function links(html) {
  const tree = parse(html);
  const values = [];
  let count = 0;
  function walk(n, depth = 0) {
    if (++count > 100000 || depth > 200)
      throw failure('BUDGET_EXCEEDED', 'Website HTML structure budget exceeded.');
    if (n.tagName === 'a') {
      const a = n.attrs.find((a) => a.name === 'href');
      if (a && values.length < 500) values.push(a.value);
    }
    for (const c of n.childNodes || []) walk(c, depth + 1);
  }
  walk(tree);
  return values;
}
function sitemapLocations(xml) {
  if (/<!DOCTYPE|<!ENTITY/i.test(xml))
    throw failure(
      'VALIDATION_ERROR',
      'Sitemaps containing declarations or entities are not supported.',
    );
  return [...xml.matchAll(/<loc\b[^>]{0,500}>([^<]{1,4000})<\/loc\s{0,50}>/gi)]
    .slice(0, 5000)
    .map((m) =>
      m[1].trim().replaceAll('&amp;', '&').replaceAll('&lt;', '<').replaceAll('&gt;', '>'),
    );
}
export function createWebsiteCrawler({ pipeline, outbound } = {}) {
  return async function crawl(
    ctx,
    collectionId,
    start,
    {
      maxPages = 20,
      maxRequests = 50,
      maxBytes = 10_000_000,
      maxMs = 60000,
      maxSitemaps = 5,
      allowQuery = false,
      access = { mode: 'workspace', principalIds: [] },
      signal,
      skipSourceId,
      onProgress = () => {},
    } = {},
  ) {
    if (
      !Number.isInteger(maxPages) ||
      maxPages < 1 ||
      maxPages > 200 ||
      !Number.isInteger(maxRequests) ||
      maxRequests < 1 ||
      maxRequests > 500 ||
      !Number.isInteger(maxBytes) ||
      maxBytes < 1 ||
      maxBytes > 30_000_000 ||
      !Number.isInteger(maxMs) ||
      maxMs < 1 ||
      maxMs > 300000 ||
      !Number.isInteger(maxSitemaps) ||
      maxSitemaps < 0 ||
      maxSitemaps > 10
    )
      throw failure('VALIDATION_ERROR', 'Invalid crawl page/request/byte/time budgets.');
    await pipeline.security.authorize(ctx, { action: 'documents.write', collectionId });
    const root = canonicalUrl(start, start, { allowQuery });
    if (!root)
      throw failure('VALIDATION_ERROR', 'Website URL is outside the permitted crawl shape.');
    const combined = signal
      ? AbortSignal.any([signal, AbortSignal.timeout(maxMs)])
      : AbortSignal.timeout(maxMs);
    let requests = 0,
      bytes = 0;
    const visited = new Set(),
      queued = new Set([root]),
      queue = [root],
      documents = [],
      failures = [];
    async function request(url, headers = {}) {
      checkSignal(combined);
      if (requests >= maxRequests)
        throw failure('BUDGET_EXCEEDED', 'Crawl request budget exhausted.');
      requests++;
      const r = await outbound.fetch(ctx, url, {
        signal: combined,
        headers,
        redirect: 'error',
        maximumBytes: Math.min(2_000_000, maxBytes - bytes),
      });
      const body = await boundedText(r, Math.min(2_000_000, maxBytes - bytes), combined);
      bytes += Buffer.byteLength(body);
      return { r, body };
    }
    const robots = await request(new URL('/robots.txt', root).href);
    if (robots.r.status >= 500 || robots.r.status === 429)
      throw failure(
        'DEPENDENCY_UNAVAILABLE',
        'Robots policy is unavailable; retry the crawl later.',
        true,
      );
    const policy = robotsPolicy(
      [401, 403].includes(robots.r.status)
        ? 'User-agent: *\nDisallow: /'
        : robots.r.ok
          ? robots.body
          : '',
    );
    function add(value, base = root) {
      const url = canonicalUrl(value, base, { allowQuery });
      if (url && policy.allowed(url) && !queued.has(url) && queued.size < maxPages * 10) {
        queued.add(url);
        queue.push(url);
      }
    }
    const maps = [...policy.sitemaps, new URL('/sitemap.xml', root).href],
      seenMaps = new Set();
    for (let i = 0; i < maps.length && seenMaps.size < maxSitemaps; i++) {
      const url = canonicalUrl(maps[i], root, { allowQuery });
      if (!url || seenMaps.has(url) || !policy.allowed(url)) continue;
      seenMaps.add(url);
      const { r, body } = await request(url);
      if (!r.ok) continue;
      const locations = sitemapLocations(body);
      if (/<sitemapindex\b/i.test(body)) maps.push(...locations);
      else locations.forEach((u) => add(u));
    }
    while (queue.length && visited.size < maxPages) {
      const url = queue.shift();
      if (visited.has(url) || !policy.allowed(url)) continue;
      visited.add(url);
      const prior = await pipeline.repository.getExternal(ctx, collectionId, url);
      let fetched;
      try {
        fetched = await request(
          url,
          prior?.metadata?.etag ? { 'If-None-Match': prior.metadata.etag } : {},
        );
      } catch (e) {
        if (e.code === 'BUDGET_EXCEEDED' || combined.aborted) throw e;
        failures.push({ url, code: 'FETCH_FAILED' });
        continue;
      }
      const { r, body } = fetched;
      if (r.status === 304) {
        if (prior) documents.push({ sourceId: prior.id, version: prior.version, unchanged: true });
        continue;
      }
      if ([404, 410].includes(r.status)) {
        if (prior && !prior.deleted) await pipeline.delete(ctx, prior.id);
        continue;
      }
      if (!r.ok) {
        failures.push({ url, code: 'HTTP_ERROR', status: r.status });
        continue;
      }
      if (!/^text\/html\b/i.test(r.headers.get('content-type') || '')) {
        failures.push({ url, code: 'UNSUPPORTED_CONTENT_TYPE' });
        continue;
      }
      if (r.url && new URL(r.url).origin !== new URL(root).origin)
        throw failure('FORBIDDEN', 'Website response escaped its origin.');
      const extracted = await parseFile(Buffer.from(body), 'page.html', { signal: combined });
      const metadata = {
        kind: 'website',
        ...(r.headers.get('etag') ? { etag: r.headers.get('etag').slice(0, 500) } : {}),
      };
      if (extracted.segments[0].text.trim() && (!skipSourceId || prior?.id !== skipSourceId))
        documents.push(
          await pipeline.upsert(ctx, {
            collectionId,
            externalId: url,
            name: new URL(url).hostname + new URL(url).pathname,
            url,
            text: extracted.segments[0].text,
            metadata,
            access,
          }),
        );
      for (const link of links(body)) add(link, url);
      await onProgress({ pages: visited.size, documents: documents.length, requests, bytes });
    }
    return {
      documents,
      failures,
      diagnostics: {
        pages: visited.size,
        requests,
        bytes,
        queued: queue.length,
        truncated: queue.length > 0,
        origin: new URL(root).origin,
      },
    };
  };
}
