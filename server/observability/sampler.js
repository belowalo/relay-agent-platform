// Runtime supplies authoritative counters; no unrestricted cross-tenant DB pool is exposed here.
export function startOperationsSampler({
  telemetry,
  queueStats,
  workerStats,
  dependencyReady,
  backupCompletedAt,
  diskFreeBytes,
  intervalMs = 15000,
}) {
  let running = false;
  async function sample() {
    if (running) return;
    running = true;
    try {
      const queue = await queueStats?.();
      if (queue) {
        telemetry.gauge('queue_waiting', queue.waiting);
        telemetry.gauge(
          'queue_age_seconds',
          queue.oldestCreatedAt
            ? Math.max(0, (Date.now() - Date.parse(queue.oldestCreatedAt)) / 1000)
            : 0,
        );
      }
      const worker = await workerStats?.();
      if (worker) {
        telemetry.gauge('workers_alive', worker.alive);
        telemetry.gauge('worker_active', worker.active);
        telemetry.gauge(
          'worker_heartbeat_age_seconds',
          worker.heartbeatAt
            ? Math.max(0, (Date.now() - Date.parse(worker.heartbeatAt)) / 1000)
            : 120,
        );
      }
      if (dependencyReady) telemetry.gauge('dependency_ready', (await dependencyReady()) ? 1 : 0);
      const backupAt = await backupCompletedAt?.();
      if (backupAt)
        telemetry.gauge(
          'backup_age_seconds',
          Math.max(0, (Date.now() - Date.parse(backupAt)) / 1000),
        );
      if (diskFreeBytes) telemetry.gauge('disk_free_bytes', await diskFreeBytes());
    } catch {
      telemetry.log('operations_sample_failed', { code: 'DEPENDENCY_UNAVAILABLE' });
    } finally {
      running = false;
    }
  }
  const timer = setInterval(sample, intervalMs);
  timer.unref();
  sample();
  return () => clearInterval(timer);
}
