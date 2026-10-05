import dns from 'node:dns/promises';
import net from 'node:net';
import { Agent } from 'undici';

const privateRanges = new net.BlockList();
for (const [ip, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['127.0.0.0', 8],
  ['100.64.0.0', 10],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 3],
])
  privateRanges.addSubnet(ip, prefix);
const globalV6 = new net.BlockList();
globalV6.addSubnet('2000::', 3, 'ipv6');
for (const [ip, prefix] of [
  ['2001::', 32],
  ['2001:db8::', 32],
  ['2002::', 16],
])
  privateRanges.addSubnet(ip, prefix, 'ipv6');
export function isPrivateAddress(ip) {
  const family = net.isIP(ip);
  return family === 4
    ? privateRanges.check(ip)
    : family !== 6 || !globalV6.check(ip, 'ipv6') || privateRanges.check(ip, 'ipv6');
}
const capabilities = new WeakSet();
const forbiddenDestinations = new net.BlockList();
forbiddenDestinations.addSubnet('169.254.0.0', 16);
forbiddenDestinations.addSubnet('fe80::', 10, 'ipv6');
forbiddenDestinations.addAddress('100.100.100.200');
forbiddenDestinations.addAddress('fd00:ec2::254', 'ipv6');
const production = () =>
  process.env.RELAY_PROFILE === 'production' || process.env.NODE_ENV === 'production';
function parseURL(value) {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash)
    throw new Error('Use an HTTP or HTTPS endpoint without embedded credentials or fragments');
  return url;
}
// Trusted administrator configuration only; never call on request/workflow JSON.
export function createOutboundPolicy({ origins = [], privateCidrs = [] } = {}) {
  const allowed = new Set(
    origins.map((value) => {
      const url = parseURL(value);
      if (url.href !== url.origin + '/')
        throw new Error('Outbound exceptions require exact origins');
      return url.origin;
    }),
  );
  const ranges = new net.BlockList();
  for (const cidr of privateCidrs) {
    const [ip, rawPrefix, extra] = cidr.split('/');
    const family = net.isIP(ip),
      prefix = Number(rawPrefix);
    if (
      extra ||
      !family ||
      rawPrefix === undefined ||
      !Number.isInteger(prefix) ||
      prefix < 0 ||
      prefix > (family === 4 ? 32 : 128)
    )
      throw new Error('Invalid outbound CIDR');
    ranges.addSubnet(ip, prefix, family === 4 ? 'ipv4' : 'ipv6');
  }
  const policy = Object.freeze({
    permits: (url, ip) =>
      allowed.has(url.origin) && ranges.check(ip, net.isIP(ip) === 6 ? 'ipv6' : 'ipv4'),
  });
  capabilities.add(policy);
  return policy;
}
function permits(url, ip, policy) {
  if (forbiddenDestinations.check(ip, net.isIP(ip) === 6 ? 'ipv6' : 'ipv4')) return false;
  if (!isPrivateAddress(ip)) return true;
  if (policy && capabilities.has(policy)) return policy.permits(url, ip);
  return !production() && (policy === true || process.env.ALLOW_PRIVATE_NETWORK === 'true');
}
async function addressesFor(url, policy) {
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const family = net.isIP(host);
  const addresses = family ? [{ address: host, family }] : await dns.lookup(host, { all: true });
  if (!addresses.length || addresses.some(({ address }) => !permits(url, address, policy)))
    throw new Error('Private network requests require an administrator-configured outbound policy');
  return addresses;
}
export async function checkURL(value, policy = false) {
  const url = parseURL(value);
  await addressesFor(url, policy);
  return url;
}
export function assertCredentialDestination(endpoint, destination) {
  const base = parseURL(endpoint),
    target = parseURL(destination);
  const root = base.pathname.replace(/\/$/, '');
  if (
    base.origin !== target.origin ||
    /%(?:2f|5c|2e|25)/i.test(target.pathname) ||
    (target.pathname !== root && !target.pathname.startsWith(root + '/'))
  )
    throw new Error('Credential destination is outside its configured endpoint');
}
export async function safeFetch(value, options = {}, policy = false) {
  let url = await checkURL(value, policy);
  const { noRedirect, dispatcher: ignoredDispatcher, ...fetchOptions } = options;
  const signal = AbortSignal.any([
    AbortSignal.timeout(30000),
    ...(options.signal ? [options.signal] : []),
  ]);
  for (let i = 0; i < 4; i++) {
    const addresses = await addressesFor(url, policy);
    const agent = new Agent({
      connect: {
        lookup(host, opts, callback) {
          const matches = addresses.filter((a) => !opts.family || a.family === opts.family);
          if (!matches.length) return callback(new Error('No permitted address'));
          if (opts.all) callback(null, matches);
          else callback(null, matches[0].address, matches[0].family);
        },
      },
    });
    let response;
    try {
      response = await fetch(url, {
        ...fetchOptions,
        signal,
        redirect: 'manual',
        dispatcher: agent,
      });
    } catch (error) {
      await agent.destroy();
      throw error;
    }
    void agent.close().catch(() => {});
    if (![301, 302, 303, 307, 308].includes(response.status)) return response;
    await response.body?.cancel();
    if (noRedirect) throw new Error('Redirects are not permitted for this request');
    const location = response.headers.get('location');
    if (!location) throw new Error('Redirect location is missing');
    const next = await checkURL(new URL(location, url).href, policy);
    if (next.origin !== url.origin) throw new Error('Cross-origin redirects are not permitted');
    if (!['GET', 'HEAD'].includes((fetchOptions.method || 'GET').toUpperCase()))
      throw new Error('Redirects for requests with effects are not permitted');
    url = next;
  }
  throw new Error('Too many redirects');
}
export async function responseText(response, max = 2_000_000) {
  if (!Number.isSafeInteger(max) || max < 1 || max > 10_000_000)
    throw new Error('Invalid response limit');
  if (!response.body) return '';
  const reader = response.body.getReader(),
    decoder = new TextDecoder();
  let total = 0,
    text = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > max) throw new Error('Response exceeds the byte limit');
      text += decoder.decode(value, { stream: true });
    }
    return text + decoder.decode();
  } finally {
    await reader.cancel().catch(() => {});
  }
}
