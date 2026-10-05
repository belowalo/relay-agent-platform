import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import express from 'express';
import { z } from 'zod';
import { parseFile } from '../knowledge/extract.js';
// Dedicated container: no database/Redis/vault/storage secrets, no egress network.
const token = process.env.PARSER_TOKEN_FILE
  ? (await fs.readFile(process.env.PARSER_TOKEN_FILE, 'utf8')).trim()
  : process.env.PARSER_TOKEN;
if (!token || token.length < 32) throw new Error('Parser authentication is required');
const app = express();
app.disable('x-powered-by');
let active = false;
app.get('/health/live', (_req, res) => res.json({ live: true }));
app.get('/health/ready', (_req, res) => res.json({ ready: true, service: 'isolated-parser' }));
app.use((req, res, next) => {
  const actual = Buffer.from(req.headers.authorization || ''),
    expected = Buffer.from('Bearer ' + token);
  if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected))
    return res.sendStatus(403);
  if (active) return res.status(429).json({ error: 'Parser is busy; retry ingestion.' });
  next();
});
app.use(express.json({ limit: '22mb' }));
app.post('/parse', async (req, res) => {
  let b;
  try {
    b = z
      .object({
        name: z.string().min(1).max(500),
        bytes: z
          .string()
          .max(20_971_520)
          .regex(/^[A-Za-z0-9+/]*={0,2}$/),
        contentType: z.string().max(100).optional(),
      })
      .strict()
      .parse(req.body);
  } catch {
    return res.status(400).json({ error: 'Invalid parser input.' });
  }
  const bytes = Buffer.from(b.bytes, 'base64');
  if (bytes.length > 15 * 1024 * 1024) return res.sendStatus(413);
  active = true;
  try {
    res.json(
      await parseFile(bytes, b.name, {
        contentType: b.contentType,
        signal: AbortSignal.timeout(30000),
      }),
    );
  } catch {
    res.status(422).json({ error: 'Document could not be processed within the allowed budgets.' });
  } finally {
    active = false;
  }
});
app.use((_error, _req, res, _next) => res.status(400).json({ error: 'Parser request rejected.' }));
const server = app.listen(Number(process.env.PORT) || 4312, '0.0.0.0');
process.once('SIGTERM', () => server.close(() => process.exit(0)));
