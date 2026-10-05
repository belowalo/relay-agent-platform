import { test } from 'node:test';
import assert from 'node:assert/strict';
import { callModel, createModelAdapter } from '../server/connectors/models.js';
const args = {
  provider: 'openai-compatible',
  endpoint: 'https://model.example.test/v1',
  secret: 'fixture-secret',
  config: { model: 'fixture', maxTokens: 100 },
  messages: [{ role: 'user', content: 'test' }],
};
function sse(frames, { chunk = 7, done = true } = {}) {
  const raw =
    frames.map((v) => 'data: ' + JSON.stringify(v) + '\r\n\r\n').join('') +
    (done ? 'data: [DONE]\r\n\r\n' : '');
  const bytes = new TextEncoder().encode(raw);
  return new Response(
    new ReadableStream({
      start(c) {
        for (let i = 0; i < bytes.length; i += chunk) c.enqueue(bytes.slice(i, i + chunk));
        c.close();
      },
    }),
    { headers: { 'Content-Type': 'text/event-stream', 'x-request-id': 'request-fixture' } },
  );
}
const finish = { choices: [{ delta: {}, finish_reason: 'stop' }] };
const usage = {
  choices: [],
  usage: {
    prompt_tokens: 12,
    completion_tokens: 4,
    prompt_tokens_details: { cached_tokens: 2 },
    completion_tokens_details: { reasoning_tokens: 1 },
  },
};
test('OpenAI fragmented CRLF streaming returns text, usage, request correlation and structured schema', async () => {
  let body;
  const outputSchema = {
    type: 'object',
    properties: { ok: { type: 'boolean' } },
    required: ['ok'],
    additionalProperties: false,
  };
  let emitted = '';
  const result = await callModel({
    ...args,
    config: { ...args.config, outputSchema },
    onToken: (t) => {
      emitted += t;
    },
    fetchImpl: async (u, o) => {
      body = JSON.parse(o.body);
      return sse([{ choices: [{ delta: { content: '{"ok":true}' } }] }, finish, usage]);
    },
  });
  assert.equal(body.response_format.type, 'json_schema');
  assert.equal(body.response_format.json_schema.strict, true);
  assert.deepEqual(result.structuredOutput, { ok: true });
  assert.equal(emitted, '{"ok":true}');
  assert.equal(result.usage.inputTokens, 12);
  assert.equal(result.usage.known, true);
  assert.equal(result.usage.cachedInputTokens, 2);
  assert.equal(result.providerRequestId, 'request-fixture');
});
test('tool argument fragments are assembled, checked against granted tool schema and never executed', async () => {
  let progress = 0;
  const tools = [
    {
      id: 'lookup',
      name: 'lookup',
      config: {
        inputSchema: { type: 'object', properties: { q: { type: 'string' } }, required: ['q'] },
      },
    },
  ];
  const result = await callModel({
    ...args,
    tools,
    onProgress: () => {
      progress++;
    },
    fetchImpl: async () =>
      sse([
        {
          choices: [
            {
              delta: {
                tool_calls: [
                  { index: 0, id: 'call1', function: { name: 'lookup', arguments: '{"q":' } },
                ],
              },
            },
          ],
        },
        {
          choices: [
            {
              delta: { tool_calls: [{ index: 0, function: { arguments: '"hello"}' } }] },
              finish_reason: 'tool_calls',
            },
          ],
        },
        usage,
      ]),
  });
  assert.equal(progress, 4);
  assert.deepEqual(result.toolCalls[0].arguments, { q: 'hello' });
});
test('partial response, truncated finish, malformed tool JSON, unsupported capabilities and refusals fail closed', async () => {
  await assert.rejects(
    callModel({
      ...args,
      fetchImpl: async () =>
        sse([{ choices: [{ delta: { content: 'partial' } }] }], { done: false }),
    }),
    /incomplete/,
  );
  await assert.rejects(
    callModel({
      ...args,
      fetchImpl: async () =>
        sse([{ choices: [{ delta: { content: 'partial' }, finish_reason: 'length' }] }]),
    }),
    /truncated/,
  );
  await assert.rejects(
    callModel({
      ...args,
      fetchImpl: async () =>
        sse([{ choices: [{ delta: { refusal: 'private provider reason' } }] }, finish]),
    }),
    (e) => !e.message.includes('private provider reason'),
  );
  await assert.rejects(
    callModel({
      ...args,
      tools: [{ id: 't', config: {} }],
      capabilities: { tools: false },
      fetchImpl: async () => {
        assert.fail('network should not be called');
      },
    }),
    { code: 'VALIDATION_ERROR' },
  );
  await assert.rejects(
    callModel({
      ...args,
      tools: [{ id: 't', config: {} }],
      fetchImpl: async () =>
        sse([
          {
            choices: [
              {
                delta: {
                  tool_calls: [
                    { index: 0, id: 'x', function: { name: 't', arguments: '{broken' } },
                  ],
                },
                finish_reason: 'tool_calls',
              },
            ],
          },
          usage,
        ]),
    }),
    /malformed tool/,
  );
});
test('unknown usage is explicit; malformed JSON and incomplete final frames are sanitized', async () => {
  const r = await callModel({
    ...args,
    fetchImpl: async () => sse([{ choices: [{ delta: { content: 'hello' } }] }, finish]),
  });
  assert.equal(r.usage.known, false);
  assert.equal(r.usage.inputTokens, null);
  await assert.rejects(
    callModel({
      ...args,
      fetchImpl: async () =>
        new Response('data: {fixture-secret}\n\n', {
          headers: { 'Content-Type': 'text/event-stream' },
        }),
    }),
    (e) => e.code === 'DEPENDENCY_UNAVAILABLE' && !e.message.includes('fixture-secret'),
  );
  await assert.rejects(
    callModel({
      ...args,
      fetchImpl: async () =>
        new Response('data: {"choices":[]}', { headers: { 'Content-Type': 'text/event-stream' } }),
    }),
    /incomplete frame/,
  );
});
test('authentication, billing quota and rate-limit errors have actionable sanitized classifications', async () => {
  for (const [status, body, code, retryable] of [
    [401, { error: { message: 'fixture-secret' } }, 'UNAUTHENTICATED', false],
    [429, { error: { type: 'insufficient_quota' } }, 'BUDGET_EXCEEDED', false],
    [429, {}, 'RATE_LIMITED', true],
  ])
    await assert.rejects(
      callModel({ ...args, fetchImpl: async () => new Response(JSON.stringify(body), { status }) }),
      (e) => e.code === code && e.retryable === retryable && !e.message.includes('fixture-secret'),
    );
});
test('Anthropic text/tool streams, cache usage and structured output protocol complete correctly', async () => {
  let body;
  const tools = [
    {
      id: 'lookup',
      config: {
        inputSchema: { type: 'object', required: ['q'], properties: { q: { type: 'string' } } },
      },
    },
  ];
  const r = await callModel({
    ...args,
    provider: 'anthropic',
    tools,
    fetchImpl: async (u, o) => {
      body = JSON.parse(o.body);
      return sse(
        [
          {
            type: 'message_start',
            message: {
              usage: {
                input_tokens: 7,
                cache_read_input_tokens: 3,
                cache_creation_input_tokens: 2,
              },
            },
          },
          {
            type: 'content_block_start',
            index: 0,
            content_block: { type: 'tool_use', id: 'tool1', name: 'lookup', input: {} },
          },
          {
            type: 'content_block_delta',
            index: 0,
            delta: { type: 'input_json_delta', partial_json: '{"q":"hello"}' },
          },
          {
            type: 'message_delta',
            delta: { stop_reason: 'tool_use' },
            usage: { output_tokens: 4 },
          },
          { type: 'message_stop' },
        ],
        { done: false },
      );
    },
  });
  assert.equal(body.tools[0].input_schema.type, 'object');
  assert.equal(r.toolCalls[0].arguments.q, 'hello');
  assert.equal(r.usage.cacheReadInputTokens, 3);
  assert.equal(r.usage.known, true);
  const outputSchema = {
    type: 'object',
    required: ['ok'],
    properties: { ok: { type: 'boolean' } },
  };
  await callModel({
    ...args,
    provider: 'anthropic',
    config: { ...args.config, outputSchema },
    fetchImpl: async (u, o) => {
      assert.equal(JSON.parse(o.body).output_config.format.type, 'json_schema');
      return sse(
        [
          { type: 'message_start', message: { usage: { input_tokens: 1 } } },
          { type: 'content_block_delta', delta: { text: '{"ok":true}' } },
          {
            type: 'message_delta',
            delta: { stop_reason: 'end_turn' },
            usage: { output_tokens: 1 },
          },
          { type: 'message_stop' },
        ],
        { done: false },
      );
    },
  });
});
test('production model adapter refuses cross-workspace credential before resolution', async () => {
  const a = createModelAdapter('openai-compatible', {
    authorize: async () => {},
    secrets: { resolve: async () => assert.fail('resolve should not be called') },
  });
  await assert.rejects(
    a.invoke(
      { workspaceId: 'w1' },
      { secretRef: { workspaceId: 'w2' }, connection: {}, config: {} },
    ),
    { code: 'FORBIDDEN' },
  );
});
