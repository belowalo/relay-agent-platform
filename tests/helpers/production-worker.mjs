import { createPostgresDatabase } from '../../server/foundation/database.js';
import { loadConfig } from '../../server/foundation/config.js';
import { createJobQueue } from '../../server/foundation/queue.js';
import { createRuntimeRepository } from '../../server/runtime/repository.js';
import { createRuntimeWorker } from '../../server/runtime/worker.js';
import { usageFixture } from './runtime-fixtures.js';
const config = loadConfig();
if (!new URL(config.databaseUrl).pathname.startsWith('/relay_foundation_test_'))
  throw new Error('Disposable test database required');
const database = createPostgresDatabase(config),
  queue = createJobQueue(config),
  leaseMs = 400;
const repository = createRuntimeRepository(database, { leaseMs });
const worker = createRuntimeWorker({
  repository,
  leaseMs,
  ownerId: process.env.TEST_WORKER_ID,
  authorize: async () => true,
  usage: usageFixture(),
  tools: {
    async describe() {
      return {
        effect: process.env.TEST_EFFECT || 'read',
        requiresApproval: false,
        idempotency: 'none',
      };
    },
    async invoke(ctx, call) {
      const response = await fetch(process.env.TEST_FIXTURE_URL, {
        method: process.env.TEST_EFFECT === 'write' ? 'POST' : 'GET',
        signal: call.signal,
      });
      return { data: await response.json() };
    },
  },
});
await queue.probe();
const transport = queue.createWorker(worker.execute);
process.send?.('ready');
process.on('message', async (message) => {
  if (message === 'drain') {
    await worker.close();
    await transport.close();
    await queue.close();
    await database.close();
    process.exit(0);
  }
});
