import fs from 'node:fs/promises';
import path from 'node:path';
import { scoreQuality } from './quality-scoring.mjs';
const output = path.resolve(process.env.LIVE_OUTPUT || 'verification-results/live-quality');
if (!process.env.LIVE_REVIEW_FILE)
  throw new Error(
    'Set LIVE_REVIEW_FILE to an independent human review of the saved cases; no model calls are made here',
  );
const { cases, benchmarkHash } = JSON.parse(
  await fs.readFile(path.join(output, 'cases.json'), 'utf8'),
);
const manifest = JSON.parse(await fs.readFile(path.join(output, 'manifest.json'), 'utf8'));
const review = JSON.parse(await fs.readFile(process.env.LIVE_REVIEW_FILE, 'utf8'));
const score = scoreQuality(cases, review, benchmarkHash, manifest.thresholds);
await fs.writeFile(
  path.join(output, 'reviewed-report.json'),
  JSON.stringify(
    { ...manifest, ...score, reviewer: review.reviewer, reviewedAt: review.reviewedAt },
    null,
    2,
  ),
);
process.stdout.write(JSON.stringify(score, null, 2) + '\n');
if (score.verdict !== 'passed') process.exitCode = 1;
