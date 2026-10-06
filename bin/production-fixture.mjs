// Disposable CI protocol endpoint. It cannot be enabled by the production entrypoint.
import http from 'node:http';
if (process.env.INTEGRATION_FIXTURE !== 'true') throw new Error('Disposable fixture flag required');
const actions = [];
const server = http.createServer(async (req, res) => {
  if (req.url === '/health' || req.url === '/health/ready' || req.url === '/actions') {
    res.setHeader('content-type', 'application/json');
    return res.end(
      JSON.stringify(req.url === '/actions' ? { count: actions.length } : { ready: true }),
    );
  }
  let body = '';
  for await (const chunk of req) {
    body += chunk;
    if (body.length > 1024 * 1024) {
      res.writeHead(413);
      return res.end();
    }
  }
  if (['/action', '/action-slow'].includes(req.url) && req.method === 'POST') {
    actions.push(JSON.parse(body));
    if (req.url === '/action-slow') await new Promise((r) => setTimeout(r, 120000));
    res.setHeader('content-type', 'application/json');
    return res.end(JSON.stringify({ accepted: true }));
  }
  if (req.url === '/research') {
    res.setHeader('content-type', 'application/json');
    return res.end(
      JSON.stringify({
        title: 'Synthetic public product evidence',
        text: 'Synthetic external operating policy for qualification.',
        url: 'https://example.org/research',
      }),
    );
  }
  if (req.url === '/v1/chat/completions') {
    const request = JSON.parse(body),
      system = request.messages?.find((m) => m.role === 'system')?.content || '';
    let content = 'Synthetic protocol response.';
    if (system.includes('extractive verification')) {
      const payload = JSON.parse(request.messages.find((m) => m.role === 'user').content),
        e = payload.evidence.find((e) => e.text.includes('180 CAD')) || payload.evidence[0];
      content = JSON.stringify({
        insufficient: !e,
        conflict: false,
        claims: e ? [{ text: e.text, references: [{ chunkId: e.chunkId, quote: e.text }] }] : [],
      });
    }
    if (request.stream === false) {
      res.setHeader('content-type', 'application/json');
      return res.end(
        JSON.stringify({
          choices: [{ message: { content }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 20, completion_tokens: 8, total_tokens: 28 },
        }),
      );
    }
    res.setHeader('content-type', 'text/event-stream');
    const send = (v) => res.write('data: ' + JSON.stringify(v) + '\n\n');
    send({
      choices: [{ index: 0, delta: { content }, finish_reason: null }],
    });
    send({
      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      usage: { prompt_tokens: 20, completion_tokens: 8, total_tokens: 28 },
    });
    return res.end('data: [DONE]\n\n');
  }
  res.writeHead(404);
  res.end();
});
server.listen(4320, '0.0.0.0');
process.on('SIGTERM', () => server.close());
