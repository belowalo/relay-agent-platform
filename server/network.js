import dns from 'node:dns/promises';
import net from 'node:net';
import { Agent } from 'undici';
function privateIP(ip) {
  ip = ip.toLowerCase();
  if (net.isIP(ip) === 6)
    return (
      ip === '::' ||
      ip === '::1' ||
      ip.startsWith('fc') ||
      ip.startsWith('fd') ||
      /^fe[89ab]/.test(ip) ||
      ip.startsWith('::ffff:')
    );
  const [a, b] = ip.split('.').map(Number);
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    a >= 224 ||
    (a === 169 && b === 254) ||
    (a === 192 && (b === 168 || b === 0)) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 198 && (b === 18 || b === 19))
  );
}
export async function checkURL(value, allowPrivate = false) {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password)
    throw new Error('Use an HTTP or HTTPS endpoint without embedded credentials');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (!allowPrivate && process.env.ALLOW_PRIVATE_NETWORK !== 'true') {
    const addresses = await dns.lookup(host, { all: true });
    if (addresses.some((a) => privateIP(a.address)))
      throw new Error('Private network requests require an administrator-enabled local connection');
  }
  return url;
}
const publicAgent = new Agent({
  connect: {
    lookup(hostname, options, callback) {
      dns
        .lookup(hostname, { all: true })
        .then((addresses) => {
          if (addresses.some((a) => privateIP(a.address)))
            return callback(new Error('Private addresses are not permitted'));
          const address =
            addresses.find((a) => !options.family || a.family === options.family) || addresses[0];
          if (options.all) callback(null, [address]);
          else callback(null, address.address, address.family);
        })
        .catch(callback);
    },
  },
});
export async function safeFetch(value, options = {}, allowPrivate = false) {
  let url = await checkURL(value, allowPrivate);
  const { noRedirect, ...fetchOptions } = options;
  options = fetchOptions;
  for (let i = 0; i < 4; i++) {
    const r = await fetch(url, {
      ...options,
      redirect: 'manual',
      ...(!allowPrivate && process.env.ALLOW_PRIVATE_NETWORK !== 'true'
        ? { dispatcher: publicAgent }
        : {}),
    });
    if ([301, 302, 303, 307, 308].includes(r.status)) {
      if (noRedirect) {
        await r.body?.cancel();
        throw new Error('Redirects are not permitted for this request');
      }
      const next = await checkURL(new URL(r.headers.get('location'), url).href, allowPrivate);
      if (next.origin !== url.origin) {
        const headers = new Headers(options.headers);
        headers.delete('authorization');
        headers.delete('x-api-key');
        options = { ...options, headers };
      }
      if (r.status === 303) {
        options = { ...options, method: 'GET', body: undefined };
      }
      await r.body?.cancel();
      url = next;
      continue;
    }
    return r;
  }
  throw new Error('Too many redirects');
}
export async function responseText(r, max = 2_000_000) {
  const reader = r.body.getReader();
  let total = 0,
    text = '';
  const decoder = new TextDecoder();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > max) throw new Error('Response exceeds the 2 MB limit');
      text += decoder.decode(value, { stream: true });
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  return text;
}
