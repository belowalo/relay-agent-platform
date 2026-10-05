import crypto from 'node:crypto';
import { parseTraceparent } from './telemetry.js';
import { requestId } from '../foundation/context.js';

export function createHealth({ probes, integrated = false, timeoutMs = 2000 }) {
  let draining = false;
  let started = false;
  return {
    start() {
      started = true;
    },
    drain() {
      draining = true;
    },
    live: () => ({ live: true }),
    async ready() {
      const checks = await Promise.all(
        Object.entries(probes).map(async ([name, probe]) => {
          let timer;
          try {
            const ok = await Promise.race([
              probe(),
              new Promise((_, reject) => {
                timer = setTimeout(() => reject(new Error()), timeoutMs);
              }),
            ]);
            return [name, ok === true];
          } catch {
            return [name, false];
          } finally {
            clearTimeout(timer);
          }
        }),
      );
      const dependencies = Object.fromEntries(checks);
      return {
        ready: started && !draining && integrated && checks.every(([, ok]) => ok),
        started,
        draining,
        runtimeIntegrated: integrated,
        dependencies,
      };
    },
  };
}
export function registerOperations(app, { health, telemetry, metricsToken }) {
  app.get('/health/live', (_req, res) => res.json(health.live()));
  app.get('/health/ready', async (_req, res) => {
    const result = await health.ready();
    res.status(result.ready ? 200 : 503).json(result);
  });
  app.get('/metrics', (req, res) => {
    const actual = Buffer.from(req.headers.authorization || '');
    const expected = Buffer.from(`Bearer ${metricsToken}`);
    if (
      !metricsToken ||
      actual.length !== expected.length ||
      !crypto.timingSafeEqual(actual, expected)
    )
      return res.sendStatus(403);
    res.type('text/plain; version=0.0.4').send(telemetry.metrics());
  });
}
export function requestTelemetry(telemetry) {
  return (req, res, next) => {
    const id = requestId(req.headers['x-request-id']);
    req.requestId = id;
    res.setHeader('x-request-id', id);
    telemetry
      .span(
        'api',
        { requestId: id },
        () =>
          new Promise((resolve, reject) => {
            let finished = false;
            const end = () => {
              if (!finished) {
                finished = true;
                if (res.statusCode >= 500) reject(new Error('API request failed'));
                else resolve();
              }
            };
            res.once('finish', end);
            res.once('close', end);
            next();
          }),
        parseTraceparent(req.headers.traceparent),
      )
      .catch(() => telemetry.log('telemetry_failed'));
  };
}
export function installShutdown({
  server,
  health,
  stopAccepting,
  drain,
  close,
  telemetry,
  timeoutMs = 30000,
  exit = (code) => process.exit(code),
}) {
  let closing = false;
  const shutdown = async (signal) => {
    if (closing) return;
    closing = true;
    health.drain();
    telemetry.log('shutdown_started', { signal });
    const deadline = setTimeout(() => {
      telemetry.log('shutdown_deadline');
      exit(1);
    }, timeoutMs);
    try {
      await stopAccepting?.();
      const stopped = new Promise((resolve) => server.close(resolve));
      server.closeIdleConnections?.();
      await drain?.();
      await stopped;
      await close?.();
      await telemetry.flush();
      telemetry.log('shutdown_completed');
      clearTimeout(deadline);
      exit(0);
    } catch {
      clearTimeout(deadline);
      telemetry.log('shutdown_failed');
      exit(1);
    }
  };
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => shutdown(signal));
  return shutdown;
}
