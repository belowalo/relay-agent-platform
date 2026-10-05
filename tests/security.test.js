import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import crypto from 'node:crypto';
import { generateKeyPair, exportJWK, SignJWT } from 'jose';
test('OIDC verifies browser state, PKCE, signatures and identities; SMTP recovery expires sessions', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-security-')),
    origin = 'http://127.0.0.1:14326';
  let child,
    emailMessage = '',
    stateNonce = '',
    challenge = '',
    wrongNonce = false;
  const { publicKey, privateKey } = await generateKeyPair('RS256'),
    key = { ...(await exportJWK(publicKey)), kid: 'fixture-key', alg: 'RS256', use: 'sig' };
  const provider = http.createServer(async (req, res) => {
    const issuer = `http://127.0.0.1:${provider.address().port}`;
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/.well-known/openid-configuration')
      return res.end(
        JSON.stringify({
          issuer,
          authorization_endpoint: issuer + '/authorize',
          token_endpoint: issuer + '/token',
          jwks_uri: issuer + '/jwks',
        }),
      );
    if (req.url === '/jwks') return res.end(JSON.stringify({ keys: [key] }));
    if (req.url === '/token') {
      let raw = '';
      for await (const c of req) raw += c;
      const f = new URLSearchParams(raw);
      assert.equal(
        crypto.createHash('sha256').update(f.get('code_verifier')).digest('base64url'),
        challenge,
      );
      assert.equal(f.get('redirect_uri'), origin + '/api/auth/sso/callback');
      const jwt = await new SignJWT({
        nonce: wrongNonce ? 'wrong' : stateNonce,
        email: 'sso@relay.test',
        email_verified: true,
        name: 'SSO Tester',
      })
        .setProtectedHeader({ alg: 'RS256', kid: 'fixture-key' })
        .setIssuer(issuer)
        .setSubject('sso-user')
        .setAudience('relay-test')
        .setIssuedAt()
        .setExpirationTime('5m')
        .sign(privateKey);
      return res.end(JSON.stringify({ id_token: jwt }));
    }
    res.statusCode = 404;
    res.end('{}');
  });
  const sockets = new Set();
  const smtp = net.createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.write('220 fixture ESMTP\r\n');
    let buffer = '',
      inData = false,
      message = '';
    socket.on('data', (chunk) => {
      buffer += chunk.toString();
      let boundary;
      while ((boundary = buffer.indexOf('\r\n')) >= 0) {
        const line = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        if (inData) {
          if (line === '.') {
            inData = false;
            emailMessage = message;
            socket.write('250 accepted\r\n');
          } else message += line + '\n';
        } else if (/^EHLO|HELO/.test(line)) socket.write('250 fixture\r\n');
        else if (/^DATA/.test(line)) {
          inData = true;
          socket.write('354 send\r\n');
        } else if (/^QUIT/.test(line)) {
          socket.end('221 bye\r\n');
        } else socket.write('250 ok\r\n');
      }
    });
  });
  await Promise.all([
    new Promise((r) => provider.listen(0, '127.0.0.1', r)),
    new Promise((r) => smtp.listen(0, '127.0.0.1', r)),
  ]);
  let logs = '';
  const request = async (url, body, cookie = '') => {
    const r = await fetch(origin + url, {
      redirect: 'manual',
      method: body === undefined ? 'GET' : 'POST',
      headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return r;
  };
  async function ssoStart() {
    const start = await request('/api/auth/sso/start');
    assert.equal(start.status, 302);
    const url = new URL(start.headers.get('location'));
    stateNonce = url.searchParams.get('nonce');
    challenge = url.searchParams.get('code_challenge');
    return {
      state: url.searchParams.get('state'),
      cookie: start.headers.get('set-cookie').split(';')[0],
    };
  }
  try {
    child = spawn(process.execPath, ['server/index.js'], {
      env: {
        ...process.env,
        PORT: '14326',
        DATA_DIR: dir,
        ENGINE_ROLE: 'api',
        ALLOW_PRIVATE_NETWORK: 'true',
        PUBLIC_ORIGIN: origin,
        OIDC_ISSUER: `http://127.0.0.1:${provider.address().port}`,
        OIDC_CLIENT_ID: 'relay-test',
        SMTP_HOST: '127.0.0.1',
        SMTP_PORT: String(smtp.address().port),
        SMTP_FROM: 'relay@relay.test',
        SMTP_USER: '',
        SMTP_SECURE: 'false',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.on('data', () => {});
    child.stderr.on('data', (v) => (logs += v));
    let ready = false;
    for (let i = 0; i < 100; i++) {
      try {
        ready = (await request('/api/health')).ok;
      } catch {}
      if (ready) break;
      await new Promise((r) => setTimeout(r, 80));
    }
    assert.ok(ready, logs);
    const options = await (await request('/api/auth/options')).json();
    assert.deepEqual(options, { sso: true, passwordReset: true });
    const s = await ssoStart();
    assert.equal(
      (await request(`/api/auth/sso/callback?state=${s.state}&code=fixture`)).status,
      400,
    );
    const login = await request(
      `/api/auth/sso/callback?state=${s.state}&code=fixture`,
      undefined,
      s.cookie,
    );
    assert.equal(login.status, 302);
    const cookie = login.headers
      .get('set-cookie')
      .split(',')
      .find((v) => v.includes('relay_session'))
      .trim()
      .split(';')[0];
    assert.equal(
      (await (await request('/api/me', undefined, cookie)).json()).user.email,
      'sso@relay.test',
    );
    assert.equal(
      (await request(`/api/auth/sso/callback?state=${s.state}&code=fixture`, undefined, s.cookie))
        .status,
      400,
    );
    const bad = await ssoStart();
    wrongNonce = true;
    assert.equal(
      (
        await request(
          `/api/auth/sso/callback?state=${bad.state}&code=fixture`,
          undefined,
          bad.cookie,
        )
      ).status,
      400,
    );
    wrongNonce = false;
    const again = await ssoStart(),
      returning = await request(
        `/api/auth/sso/callback?state=${again.state}&code=fixture`,
        undefined,
        again.cookie,
      );
    assert.equal(returning.status, 302);
    const registered = await request('/api/auth/register', {
      name: 'Recovery',
      email: 'recovery@relay.test',
      password: 'Recovery-password-2026',
    });
    assert.equal(registered.status, 201);
    const oldCookie = registered.headers.get('set-cookie').split(';')[0];
    const reset = await request('/api/auth/reset/request', { email: 'recovery@relay.test' });
    assert.equal(reset.status, 200);
    assert.ok(emailMessage.includes('Reset your Relay password'));
    const decoded = emailMessage
      .replace(/=\n/g, '')
      .replace(/=([A-F0-9]{2})/g, (_, v) => String.fromCharCode(parseInt(v, 16)));
    const link = decoded.match(/reset=([\w-]+)/);
    assert.ok(link, 'SMTP fixture did not receive recovery URL');
    const unknown = await request('/api/auth/reset/request', { email: 'missing@relay.test' });
    assert.deepEqual(await unknown.json(), await reset.json());
    assert.equal(
      (
        await request('/api/auth/reset/complete', {
          token: link[1],
          password: 'Changed-password-2026',
        })
      ).status,
      200,
    );
    assert.equal((await request('/api/me', undefined, oldCookie)).status, 401);
    assert.equal(
      (
        await request('/api/auth/reset/complete', {
          token: link[1],
          password: 'Another-password-2026',
        })
      ).status,
      400,
    );
    assert.equal(
      (
        await request('/api/auth/login', {
          email: 'recovery@relay.test',
          password: 'Changed-password-2026',
        })
      ).status,
      200,
    );
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) {
      child.kill();
      await new Promise((r) => child.once('exit', r));
    }
    provider.closeAllConnections();
    for (const socket of sockets) socket.destroy();
    await Promise.all([new Promise((r) => provider.close(r)), new Promise((r) => smtp.close(r))]);
    if (
      !path.resolve(dir).startsWith(path.resolve(os.tmpdir()) + path.sep) ||
      !path.basename(dir).startsWith('relay-security-')
    )
      throw new Error('Unexpected test path');
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
