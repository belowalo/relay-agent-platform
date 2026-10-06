import { Queue, Worker } from 'bullmq';
import Redis from 'ioredis';
import { randomUUID } from 'node:crypto';
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
  const heartbeatKey = `${config.queuePrefix}:worker-heartbeats`;
  let closing;
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
        if (['source.ingest', 'connector.sync'].includes(job.kind)) {
          const previous = await queue.getJob(job.id);
          if (previous && ['completed', 'failed'].includes(await previous.getState()))
            await previous.remove();
        }
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
    async stats() {
      return bounded(async () => {
        const counts = await queue.getJobCounts('waiting', 'active', 'delayed');
        const oldest = (await queue.getJobs(['waiting'], 0, 0, true))[0];
        return {
          waiting: counts.waiting + counts.delayed,
          active: counts.active,
          oldestCreatedAt: oldest ? new Date(oldest.timestamp).toISOString() : null,
        };
      });
    },
    async workerStats() {
      return bounded(async () => {
        await queue.waitUntilReady();
        const now = Date.now();
        await producerConnection.zremrangebyscore(heartbeatKey, '-inf', now - 600000);
        const alive = await producerConnection.zcount(heartbeatKey, now - 15000, '+inf');
        const newest = await producerConnection.zrevrange(heartbeatKey, 0, 0, 'WITHSCORES');
        const counts = await queue.getJobCounts('active');
        return {
          alive,
          active: counts.active,
          heartbeatAt: newest.length ? new Date(Number(newest[1])).toISOString() : null,
        };
      });
    },
    createWorker(handler) {
      const workerId = randomUUID();
      let heartbeatTimer,
        heartbeating = false,
        stopped = false;
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
      async function heartbeat() {
        if (stopped || heartbeating || !worker.isRunning() || worker.isPaused()) return;
        heartbeating = true;
        try {
          await bounded(async () => {
            await queue.waitUntilReady();
            if (stopped) return;
            await producerConnection.zadd(heartbeatKey, Date.now(), workerId);
            await producerConnection.zremrangebyscore(heartbeatKey, '-inf', Date.now() - 600000);
          });
        } catch {
          onError('queue.worker.heartbeat');
        } finally {
          heartbeating = false;
        }
      }
      worker.on('ready', () => {
        if (stopped || heartbeatTimer) return;
        heartbeatTimer = setInterval(heartbeat, 5000);
        heartbeatTimer.unref();
        heartbeat();
      });
      const handle = {
        async close() {
          stopped = true;
          clearInterval(heartbeatTimer);
          try {
            await bounded(() => worker.close(), config.shutdownTimeoutMs);
          } finally {
            // Expiry still detects a killed process or an unavailable Redis connection.
            await bounded(() => producerConnection.zrem(heartbeatKey, workerId)).catch(() => {});
            workerConnection.disconnect();
            workers.delete(handle);
          }
        },
      };
      workers.add(handle);
      return handle;
    },
    async close() {
      if (closing) return closing;
      closing = (async () => {
        const results = await Promise.allSettled([...workers].map((worker) => worker.close()));
        producerConnection.disconnect();
        try {
          await queue.close();
        } finally {
          producerConnection.disconnect();
        }
        if (results.some((result) => result.status === 'rejected'))
          throw new PlatformError('DEPENDENCY_UNAVAILABLE', 'Worker drain deadline exceeded.');
      })();
      return closing;
    },
  });
}
