import crypto from 'node:crypto';
const hash = (value) => crypto.createHash('sha256').update(value).digest('hex');
const hmac = (key, value) => crypto.createHmac('sha256', key).update(value).digest();
const encode = (value) =>
  encodeURIComponent(value).replace(
    /[!'()*]/g,
    (char) => '%' + char.charCodeAt(0).toString(16).toUpperCase(),
  );
const unxml = (value) =>
  value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
export function createS3({
  endpoint,
  bucket,
  accessKey,
  secretKey,
  region = 'us-east-1',
  maxBytes = 32 * 1024 * 1024,
}) {
  const base = new URL(endpoint);
  if (
    !['http:', 'https:'].includes(base.protocol) ||
    base.username ||
    base.password ||
    base.search ||
    base.pathname !== '/'
  )
    throw new Error('Invalid S3 endpoint');
  if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket)) throw new Error('Invalid S3 bucket');
  async function request(method, key = '', query = {}, body = Buffer.alloc(0)) {
    const pathname = '/' + bucket + (key ? '/' + key.split('/').map(encode).join('/') : '');
    const canonicalQuery = Object.entries(query)
      .map(([key, value]) => [encode(key), encode(value)])
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, value]) => `${key}=${value}`)
      .join('&');
    const url = new URL(pathname + (canonicalQuery ? '?' + canonicalQuery : ''), base);
    const date = new Date().toISOString().replace(/[:-]|\.\d{3}/g, '');
    const day = date.slice(0, 8);
    const payloadHash = hash(body);
    const signedHeaders = 'host;x-amz-content-sha256;x-amz-date';
    const canonical = [
      method,
      pathname,
      canonicalQuery,
      `host:${url.host}\nx-amz-content-sha256:${payloadHash}\nx-amz-date:${date}\n`,
      signedHeaders,
      payloadHash,
    ].join('\n');
    const scope = `${day}/${region}/s3/aws4_request`;
    const signingKey = hmac(
      hmac(hmac(hmac('AWS4' + secretKey, day), region), 's3'),
      'aws4_request',
    );
    const signature = crypto
      .createHmac('sha256', signingKey)
      .update(`AWS4-HMAC-SHA256\n${date}\n${scope}\n${hash(canonical)}`)
      .digest('hex');
    const response = await fetch(url, {
      method,
      signal: AbortSignal.timeout(15000),
      redirect: 'error',
      headers: {
        'x-amz-date': date,
        'x-amz-content-sha256': payloadHash,
        authorization: `AWS4-HMAC-SHA256 Credential=${accessKey}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
      },
      ...(method === 'PUT' ? { body } : {}),
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error('Object storage request failed');
    }
    const chunks = [];
    let size = 0;
    for await (const chunk of response.body || []) {
      size += chunk.length;
      if (size > maxBytes) throw new Error('Object exceeds backup support limit');
      chunks.push(chunk);
    }
    return Buffer.concat(chunks);
  }
  return {
    createBucket: () => request('PUT'),
    probe: async () => {
      await request('HEAD');
      return true;
    },
    put: (key, body) => request('PUT', key, {}, body),
    get: (key) => request('GET', key),
    remove: (key) => request('DELETE', key),
    async list() {
      const keys = [];
      let token;
      do {
        const xml = (
          await request('GET', '', {
            'list-type': '2',
            ...(token ? { 'continuation-token': token } : {}),
          })
        ).toString();
        for (const entry of xml.matchAll(/<Key>([\s\S]*?)<\/Key>/g)) keys.push(unxml(entry[1]));
        token = /<IsTruncated>true<\/IsTruncated>/.test(xml)
          ? unxml(/<NextContinuationToken>([\s\S]*?)<\/NextContinuationToken>/.exec(xml)?.[1] || '')
          : undefined;
        if (token === '') throw new Error('Invalid storage listing');
        if (keys.length > 100000) throw new Error('Object count exceeds backup support limit');
      } while (token);
      return keys;
    },
  };
}
