import { z } from 'zod';
import { ConnectorError, descriptor, invalid, schemaCheck } from './core.js';

const endpoint = z.url().refine((v) => {
  const u = new URL(v);
  return u.protocol === 'https:' && !u.username && !u.password && !u.search && !u.hash;
});
const selected = z.array(z.string().min(1).max(512)).min(1).max(1000);
const encode = encodeURIComponent;
const obj = z.object({}).passthrough();
const limit = (v) => Math.max(1, Math.min(100, Number(v) || 100));
function permitted(values, value) {
  if (!values.includes(value))
    throw new ConnectorError('FORBIDDEN', 'Resource is outside the configured selection.');
}
function path(value) {
  if (typeof value !== 'string' || value.split('/').some((p) => !p || p === '.' || p === '..'))
    throw invalid();
  return value.split('/').map(encode).join('/');
}
function url(base, route, query = {}) {
  const u = new URL(base.replace(/\/$/, '') + '/' + route);
  for (const [k, v] of Object.entries(query))
    if (v !== undefined && v !== '') u.searchParams.set(k, String(v));
  return u;
}
async function bearer(a, route, query, options, mode) {
  const secret = await a.secret();
  const result = await a.request(
    url(a.config.endpoint, route, query),
    {
      ...options,
      headers: {
        Accept: 'application/json',
        ...options?.headers,
        ...(secret ? { Authorization: 'Bearer ' + secret } : {}),
      },
    },
    mode,
  );
  return result;
}
export const github = {
  validate: (c) =>
    z
      .object({
        endpoint: endpoint.default('https://api.github.com'),
        repositories: selected.refine((rs) => rs.every((r) => /^[\w.-]+\/[\w.-]+$/.test(r))),
      })
      .strict()
      .parse(c),
  descriptor: () =>
    descriptor(
      'github',
      'api-key',
      ['repositories', 'issues', 'pulls', 'document'],
      ['create_issue', 'comment'],
    ),
  testAction: 'repositories',
  testInput: (c) => ({ repository: c.repositories[0] }),
  testCapabilities: () => ['repositories'],
  validateInput(c, action, i) {
    obj.parse(i);
    permitted(c.repositories, i.repository);
    if (action === 'document') path(i.path);
    if (['create_issue', 'comment'].includes(action))
      schemaCheck(
        {
          type: 'object',
          required: action === 'create_issue' ? ['title', 'body'] : ['number', 'body'],
          properties: {
            title: { type: 'string', minLength: 1, maxLength: 256 },
            body: { type: 'string', maxLength: 65536 },
            number: { type: 'integer', minimum: 1 },
          },
        },
        i,
      );
  },
  async invoke(a) {
    const i = a.input,
      root = 'repos/' + path(i.repository);
    let route = root,
      query = {},
      options = { headers: { 'X-GitHub-Api-Version': '2022-11-28' } };
    if (['issues', 'pulls'].includes(a.action)) {
      route += '/' + a.action;
      query = {
        state: 'all',
        per_page: limit(i.limit),
        page: i.cursor || 1,
        ...(a.action === 'issues' ? { since: i.since } : { sort: 'updated', direction: 'desc' }),
      };
    }
    if (a.action === 'document') {
      route += '/contents/' + path(i.path);
      query.ref = i.ref;
    }
    if (a.action === 'create_issue') {
      route += '/issues';
      options.method = 'POST';
      options.body = JSON.stringify({ title: i.title, body: i.body });
      options.headers['Content-Type'] = 'application/json';
    }
    if (a.action === 'comment') {
      route += '/issues/' + i.number + '/comments';
      options.method = 'POST';
      options.body = JSON.stringify({ body: i.body });
      options.headers['Content-Type'] = 'application/json';
    }
    const r = await bearer(a, route, query, options);
    if (a.action === 'document') {
      if (r.data.type !== 'file' || r.data.encoding !== 'base64')
        throw invalid('Choose a GitHub file supported by the contents API (at most 1 MiB).');
      r.data = {
        externalId: `github:${i.repository}:${i.path}`,
        name: i.path,
        text: Buffer.from(r.data.content, 'base64').toString('utf8'),
        url: r.data.html_url,
        revision: r.data.sha,
      };
    }
    if (a.action === 'pulls' && i.since) r.data = r.data.filter((p) => p.updated_at >= i.since);
    const next = r.headers.get('link')?.match(/<([^>]+)>;\s*rel="next"/);
    return {
      data: r.data,
      providerRequestId: r.providerRequestId,
      ...(next ? { nextCursor: new URL(next[1]).searchParams.get('page') } : {}),
    };
  },
};

export const slack = {
  validate: (c) =>
    z
      .object({
        endpoint: endpoint.default('https://slack.com/api'),
        channels: selected.refine((cs) => cs.every((v) => /^[CG][A-Z0-9]+$/.test(v))),
      })
      .strict()
      .parse(c),
  descriptor: () =>
    descriptor(
      'slack',
      'oauth2',
      ['history', 'search'],
      ['post_message', 'update_message', 'delete_message'],
    ),
  testAction: 'history',
  testInput: (c) => ({ channel: c.channels[0], limit: 1 }),
  testCapabilities: () => ['history'],
  validateInput(c, action, i) {
    obj.parse(i);
    permitted(c.channels, i.channel);
    if (action === 'search' && (typeof i.query !== 'string' || i.query.length > 1000))
      throw invalid();
    if (
      ['post_message', 'update_message'].includes(action) &&
      (typeof i.text !== 'string' || !i.text || i.text.length > 40000)
    )
      throw invalid();
    if (['update_message', 'delete_message'].includes(action) && !/^\d+\.\d+$/.test(i.ts))
      throw invalid();
  },
  async invoke(a) {
    const i = a.input;
    const methods = {
      history: 'conversations.history',
      search: 'search.messages',
      post_message: 'chat.postMessage',
      update_message: 'chat.update',
      delete_message: 'chat.delete',
    };
    const write = !['history', 'search'].includes(a.action);
    const query =
      a.action === 'history'
        ? {
            channel: i.channel,
            limit: limit(i.limit),
            cursor: i.cursor,
            oldest: i.since,
            inclusive: true,
          }
        : a.action === 'search'
          ? {
              query: '(' + i.query + ') in:' + i.channel,
              count: limit(i.limit),
              page: i.cursor || 1,
            }
          : {};
    const r = await bearer(
      a,
      methods[a.action],
      query,
      write
        ? {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              channel: i.channel,
              text: i.text,
              ts: i.ts,
              thread_ts: i.threadTs,
            }),
          }
        : {},
    );
    if (r.data?.ok !== true && r.data?.ok !== false)
      throw new ConnectorError('DEPENDENCY_UNAVAILABLE', 'Slack returned a malformed response.', {
        outcome: write ? 'uncertain' : 'failed',
      });
    if (!r.data.ok) {
      const code = ['invalid_auth', 'token_revoked', 'token_expired', 'not_authed'].includes(
        r.data.error,
      )
        ? 'UNAUTHENTICATED'
        : r.data.error === 'ratelimited'
          ? 'RATE_LIMITED'
          : ['missing_scope', 'not_in_channel', 'channel_not_found'].includes(r.data.error)
            ? 'FORBIDDEN'
            : 'VALIDATION_ERROR';
      throw new ConnectorError(
        code,
        code === 'UNAUTHENTICATED'
          ? 'Slack credential rejected; reconnect.'
          : code === 'FORBIDDEN'
            ? 'Check Slack channel membership and granted scopes.'
            : 'Slack rejected the request; check configuration.',
      );
    }
    if (a.action === 'search') {
      const m = r.data.messages;
      return {
        data: (m?.matches || []).filter((v) => v.channel?.id === i.channel),
        providerRequestId: r.providerRequestId,
        ...(m?.paging?.page < m?.paging?.pages ? { nextCursor: String(m.paging.page + 1) } : {}),
      };
    }
    return {
      data: write ? r.data : r.data.messages,
      providerRequestId: r.providerRequestId,
      ...(r.data.response_metadata?.next_cursor
        ? { nextCursor: r.data.response_metadata.next_cursor }
        : {}),
    };
  },
};

export const drive = {
  validate: (c) =>
    z
      .object({
        endpoint: endpoint.default('https://www.googleapis.com/drive/v3'),
        files: z.array(z.string().regex(/^[\w-]+$/)).default([]),
        folders: z.array(z.string().regex(/^[\w-]+$/)).default([]),
        exportMimeType: z
          .enum([
            'text/plain',
            'text/csv',
            'application/pdf',
            'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
          ])
          .default('text/plain'),
      })
      .strict()
      .refine((c) => c.files.length + c.folders.length > 0)
      .parse(c),
  descriptor: () =>
    descriptor('google-drive', 'oauth2', ['files', 'document', 'start_cursor', 'changes']),
  testAction: 'files',
  testCapabilities: () => ['files'],
  validateInput(c, action, i) {
    obj.parse(i);
    if (action === 'files' && i.folder) permitted(c.folders, i.folder);
    if (action === 'document' && !/^[\w-]+$/.test(i.fileId)) throw invalid();
    if (action === 'changes' && typeof i.cursor !== 'string') throw invalid();
  },
  async invoke(a) {
    const i = a.input,
      c = a.config,
      fields = 'id,name,mimeType,modifiedTime,version,parents,trashed,webViewLink';
    const allowed = (f) => c.files.includes(f.id) || f.parents?.some((p) => c.folders.includes(p));
    if (a.action === 'start_cursor') {
      const r = await bearer(a, 'changes/startPageToken', { supportsAllDrives: true });
      return { data: r.data, nextCursor: r.data.startPageToken };
    }
    if (a.action === 'changes') {
      const r = await bearer(a, 'changes', {
        pageToken: i.cursor,
        pageSize: 100,
        includeRemoved: true,
        supportsAllDrives: true,
        includeItemsFromAllDrives: true,
        fields: `nextPageToken,newStartPageToken,changes(fileId,removed,file(${fields}))`,
      });
      return {
        data: r.data.changes.map((v) =>
          c.files.includes(v.fileId) || (v.file && allowed(v.file))
            ? v
            : { fileId: v.fileId, removed: true },
        ),
        nextCursor: r.data.nextPageToken || r.data.newStartPageToken,
        checkpoint: !r.data.nextPageToken,
        providerRequestId: r.providerRequestId,
      };
    }
    if (a.action === 'files') {
      const ids = i.folder ? [i.folder] : c.folders;
      const q = [...ids.map((id) => `'${id}' in parents`), ...c.files.map((id) => `id = '${id}'`)];
      // Drive does not support id predicates: selected individual files are fetched separately on initial enumeration.
      if (!ids.length) {
        if (i.cursor) throw invalid();
        const data = [];
        for (const id of c.files) {
          const r = await bearer(a, 'files/' + encode(id), { fields, supportsAllDrives: true });
          if (!r.data.trashed) data.push(r.data);
        }
        return { data };
      }
      const r = await bearer(a, 'files', {
        q: `trashed = false and (${q.slice(0, ids.length).join(' or ')})`,
        pageSize: 100,
        pageToken: i.cursor,
        fields: `nextPageToken,files(${fields})`,
        supportsAllDrives: true,
        includeItemsFromAllDrives: true,
      });
      const data = r.data.files.filter(allowed);
      if (!i.cursor && !i.folder)
        for (const id of c.files)
          if (!data.some((f) => f.id === id)) {
            const x = await bearer(a, 'files/' + encode(id), { fields, supportsAllDrives: true });
            if (!x.data.trashed) data.push(x.data);
          }
      return { data, nextCursor: r.data.nextPageToken, providerRequestId: r.providerRequestId };
    }
    const meta = await bearer(a, 'files/' + encode(i.fileId), { fields, supportsAllDrives: true });
    if (!allowed(meta.data) || meta.data.trashed)
      throw new ConnectorError('FORBIDDEN', 'Drive file is outside the active selection.');
    const google = meta.data.mimeType.startsWith('application/vnd.google-apps.');
    if (
      meta.data.mimeType === 'application/vnd.google-apps.folder' ||
      meta.data.mimeType === 'application/vnd.google-apps.shortcut'
    )
      throw invalid('Folders and shortcuts cannot be downloaded as documents.');
    const response = await bearer(
      a,
      'files/' + encode(i.fileId) + (google ? '/export' : ''),
      google ? { mimeType: c.exportMimeType } : { alt: 'media' },
      {},
      'response',
    );
    const bytes = await readBytes(response, a.signal);
    return {
      data: {
        externalId: 'drive:' + i.fileId,
        name: meta.data.name,
        bytes,
        contentType: google ? c.exportMimeType : meta.data.mimeType,
        url: meta.data.webViewLink,
        revision: String(meta.data.version),
      },
    };
  },
};
export async function readBytes(response, signal, maximum = 15 * 1024 * 1024) {
  const parts = [];
  let size = 0;
  const reader = response.body.getReader();
  try {
    while (true) {
      signal.throwIfAborted();
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > maximum) throw invalid('Document exceeds the configured byte limit.');
      parts.push(value);
    }
    return Buffer.concat(parts);
  } finally {
    await reader.cancel().catch(() => {});
  }
}

export const rest = {
  validate: (c) =>
    z
      .object({
        endpoint,
        auth: z.enum(['none', 'bearer', 'basic', 'api-key']).default('bearer'),
        authHeader: z
          .string()
          .regex(/^[\w-]+$/)
          .default('X-API-Key'),
        actions: z.record(
          z.string().regex(/^[\w-]+$/),
          z
            .object({
              path: z.string().regex(/^\/(?!\/)[^?#]*$/),
              method: z.enum(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE']).default('GET'),
              inputSchema: obj,
              outputSchema: obj,
              pagination: z
                .object({
                  mode: z.enum(['cursor', 'page', 'link']),
                  parameter: z.string().default('cursor'),
                  nextPath: z.string().default('nextCursor'),
                })
                .optional(),
              idempotencyHeader: z
                .string()
                .regex(/^[\w-]+$/)
                .optional(),
            })
            .strict(),
        ),
      })
      .strict()
      .refine((c) => Object.keys(c.actions).length > 0)
      .parse(c),
  descriptor: (c) => {
    const d = descriptor(
      'rest',
      c.auth === 'none' ? 'none' : 'api-key',
      Object.keys(c.actions).filter((k) => ['GET', 'HEAD'].includes(c.actions[k].method)),
      Object.keys(c.actions).filter((k) => !['GET', 'HEAD'].includes(c.actions[k].method)),
    );
    for (const a of d.actions)
      if (c.actions[a.id].idempotencyHeader && a.effect === 'write') a.idempotency = 'provider-key';
    return d;
  },
  testAction: '',
  testInput: () => ({}),
  validateInput(c, action, i) {
    schemaCheck(c.actions[action].inputSchema, i);
  },
  async invoke(a) {
    const action = a.config.actions[a.action],
      i = a.input;
    const route = action.path.replace(/\{([\w-]+)\}/g, (_, k) => {
      if (i[k] === undefined || ['.', '..'].includes(String(i[k]))) throw invalid();
      return encode(i[k]);
    });
    let u = url(a.config.endpoint, route.slice(1));
    const headers = { Accept: 'application/json' },
      secret = await a.secret();
    if (a.config.auth === 'bearer') headers.Authorization = 'Bearer ' + secret;
    if (a.config.auth === 'basic')
      headers.Authorization = 'Basic ' + Buffer.from(secret).toString('base64');
    if (a.config.auth === 'api-key') headers[a.config.authHeader] = secret;
    const read = ['GET', 'HEAD'].includes(action.method);
    if (read)
      for (const [k, v] of Object.entries(i))
        if (k !== 'cursor' && !action.path.includes('{' + k + '}'))
          u.searchParams.set(k, String(v));
    if (action.pagination && i.cursor) {
      if (action.pagination.mode === 'link') {
        const next = new URL(i.cursor);
        if (
          next.origin !== u.origin ||
          next.pathname !== u.pathname ||
          next.username ||
          next.password
        )
          throw invalid('Pagination link is outside the configured action.');
        u = next;
      } else u.searchParams.set(action.pagination.parameter, i.cursor);
    }
    if (!read) headers['Content-Type'] = 'application/json';
    if (!read && action.idempotencyHeader && a.idempotencyKey)
      headers[action.idempotencyHeader] = a.idempotencyKey;
    const r = await a.request(
      u,
      { method: action.method, headers, ...(!read ? { body: JSON.stringify(i) } : {}) },
      action.method === 'HEAD' ? 'text' : 'json',
    );
    try {
      schemaCheck(action.outputSchema, r.data);
    } catch (error) {
      if (!read) error.outcome = 'uncertain';
      throw error;
    }
    let next;
    if (action.pagination?.mode === 'link')
      next = r.headers.get('link')?.match(/<([^>]+)>;\s*rel="next"/)?.[1];
    else if (action.pagination)
      next = action.pagination.nextPath.split('.').reduce((o, k) => o?.[k], r.data);
    return {
      data: r.data,
      providerRequestId: r.providerRequestId,
      ...(next !== undefined && next !== null && next !== '' ? { nextCursor: String(next) } : {}),
    };
  },
};
