export class RelayClient {
  constructor({ baseUrl, applicationId, token, timeoutMs = 30000 }) {
    const url = new URL(baseUrl);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password)
      throw new Error('Use an HTTP(S) base URL without credentials');
    if (!applicationId || !token)
      throw new Error('An application id and access token are required');
    this.base = url.href.replace(/\/$/, '') + '/api/apps/' + encodeURIComponent(applicationId);
    this.token = token;
    this.timeoutMs = timeoutMs;
  }
  async request(path, body, { signal } = {}) {
    const response = await fetch(this.base + path, {
      method: body === undefined ? 'GET' : 'POST',
      redirect: 'error',
      headers: { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(this.timeoutMs)])
        : AbortSignal.timeout(this.timeoutMs),
    });
    const text = await response.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      throw new Error(`Relay returned an invalid response (HTTP ${response.status})`);
    }
    if (!response.ok)
      throw new Error(`Relay HTTP ${response.status}: ${data.error || 'Request failed'}`);
    return data;
  }
  invoke(input, { conversationId, signal } = {}) {
    return this.request('/invoke', { input, conversationId }, { signal });
  }
  getRun(id, options) {
    return this.request('/runs/' + encodeURIComponent(id), undefined, options);
  }
  async waitRun(id, { timeoutMs = 120000, pollMs = 300, signal, returnOnWaiting = true } = {}) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      signal?.throwIfAborted();
      const run = await this.getRun(id, { signal });
      if (
        ['completed', 'failed', 'cancelled'].includes(run.status) ||
        (returnOnWaiting && run.status === 'waiting')
      )
        return run;
      await new Promise((resolve, reject) => {
        const abort = () => {
          clearTimeout(timer);
          reject(signal.reason);
        };
        const timer = setTimeout(
          () => {
            signal?.removeEventListener('abort', abort);
            resolve();
          },
          Math.max(50, pollMs),
        );
        signal?.addEventListener('abort', abort, { once: true });
      });
    }
    throw new Error('Timed out waiting for the Relay run; the run continues on the server');
  }
  async *events(id, { after = 0, signal } = {}) {
    const response = await fetch(
      this.base + '/runs/' + encodeURIComponent(id) + '/events?after=' + Number(after),
      {
        headers: { Authorization: `Bearer ${this.token}`, Accept: 'text/event-stream' },
        redirect: 'error',
        signal,
      },
    );
    if (!response.ok) throw new Error(`Relay events returned HTTP ${response.status}`);
    const reader = response.body.getReader(),
      decoder = new TextDecoder();
    let buffer = '';
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let end;
        while ((end = buffer.indexOf('\n\n')) >= 0) {
          const frame = buffer.slice(0, end);
          buffer = buffer.slice(end + 2);
          const data = frame
            .split('\n')
            .filter((line) => line.startsWith('data:'))
            .map((line) => line.slice(5).trim())
            .join('\n');
          if (data) yield JSON.parse(data);
        }
        if (buffer.length > 3000000) throw new Error('Relay event exceeded the size limit');
      }
    } finally {
      await reader.cancel().catch(() => {});
    }
  }
}
