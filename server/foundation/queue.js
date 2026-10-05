import { Queue, Worker } from 'bullmq';
import Redis from 'ioredis';
import { jobSchema } from './contracts.js';
import { PlatformError } from './errors.js';

export function createJobQueue(config, { onError = () => {} } = {}) {
  const producerConnection = new Redis(config.redisUrl, {
    lazyConnect: true,
    maxRetriesPerRequest: 1,
    enableOfflineQueue: false,
    connectTimeout: config.databaseTimeoutMs,
    retryStrategy: (times) => Math.min(times * 250, 5000),
  });
  producerConnection.on('error', () => onError('queue.connection'));
  const queue = new Queue('jobs', { connection: producerConnection, prefix: config.queuePrefix });
  queue.on('error', () => onError('queue.producer'));
  const workers = new Set();
  async function bounded(operation, milliseconds = config.databaseTimeoutMs) {
    let timer;
    try {
      return await Promise.race([
        operation(),
        new Promise((_, reject) => {
          timer = setTimeout(
            () =>
              reject(
                new PlatformError('DEPENDENCY_UNAVAILABLE', 'Queue operation timed out.', {
                  retryable: true,
                }),
              ),
            milliseconds,
          );
        }),
      ]);
    } catch (error) {
      if (error instanceof PlatformError) throw error;
      throw new PlatformError('DEPENDENCY_UNAVAILABLE', 'Queue operation failed.', {
        retryable: true,
        cause: error,
      });
    } finally {
      clearTimeout(timer);
    }
  }
  return Object.freeze({
    async publish(job) {
      job = jobSchema.parse(job);
      // PG outbox recovery owns redelivery. Queue completion is not durable business state.
      await bounded(async () => {
        await queue.waitUntilReady();
        await queue.add(job.kind, job, {
          jobId: job.id,
          attempts: 1,
          removeOnComplete: { age: 86400 },
          removeOnFail: false,
        });
      });
      return job.id;
    },
    async probe() {
      return bounded(async () => {
        await queue.waitUntilReady();
        return (await producerConnection.ping()) === 'PONG';
      });
    },
    createWorker(handler) {
      const workerConnection = new Redis(config.redisUrl, {
        maxRetriesPerRequest: null,
        enableOfflineQueue: true,
        connectTimeout: config.databaseTimeoutMs,
        retryStrategy: (times) => Math.min(times * 250, 5000),
      });
      workerConnection.on('error', () => onError('queue.worker.connection'));
      const worker = new Worker(
        'jobs',
        async (entry) => {
          const reference = jobSchema.parse(entry.data);
          try {
            await handler(reference);
          } catch {
            // BullMQ persists failedReason/stacktrace; raw handler errors can contain private input.
            throw new Error('Job execution failed. Inspect authorized run history.');
          }
          // Business output belongs in PostgreSQL; never persist handler output in Redis.
          return { id: reference.id };
        },
        {
          connection: workerConnection,
          prefix: config.queuePrefix,
          concurrency: config.workerConcurrency,
        },
      );
      worker.on('error', () => onError('queue.worker'));
      const handle = {
        async close() {
          try {
            await bounded(() => worker.close(), config.shutdownTimeoutMs);
          } finally {
            workerConnection.disconnect();
            workers.delete(handle);
          }
        },
      };
      workers.add(handle);
      return handle;
    },
    async close() {
      const results = await Promise.allSettled([...workers].map((worker) => worker.close()));
      producerConnection.disconnect();
      try {
        await queue.close();
      } finally {
        producerConnection.disconnect();
      }
      if (results.some((result) => result.status === 'rejected'))
        throw new PlatformError('DEPENDENCY_UNAVAILABLE', 'Worker drain deadline exceeded.');
    },
  });
}
