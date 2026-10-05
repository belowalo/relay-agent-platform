import os from 'node:os';
import fs from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const exec = promisify(execFile);
export function distribution(values) {
  if (!values.length) return { count: 0, p50: null, p95: null, p99: null, max: null };
  const sorted = values.toSorted((a, b) => a - b);
  const percentile = (fraction) => sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)];
  return {
    count: sorted.length,
    p50: percentile(0.5),
    p95: percentile(0.95),
    p99: percentile(0.99),
    max: sorted.at(-1),
  };
}
export function host() {
  return {
    os: os.type(),
    release: os.release(),
    arch: os.arch(),
    logicalCpus: os.cpus().length,
    cpuModel: os.cpus()[0]?.model,
    totalRamBytes: os.totalmem(),
    node: process.version,
  };
}
export async function resourceSample(pid) {
  if (!pid) return null;
  if (process.platform === 'win32') {
    const { stdout } = await exec(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `Get-Process -Id ${Number(pid)} | Select-Object @{n='rssBytes';e={$_.WorkingSet64}},@{n='cpuSeconds';e={$_.CPU}} | ConvertTo-Json -Compress`,
      ],
      { windowsHide: true },
    );
    return { at: new Date().toISOString(), ...JSON.parse(stdout) };
  }
  const { stdout } = await exec('ps', ['-p', String(pid), '-o', 'rss=', '-o', 'time=']);
  const [rss, time] = stdout.trim().split(/\s+/);
  const parts = time.split(':').map(Number);
  return {
    at: new Date().toISOString(),
    rssBytes: Number(rss) * 1024,
    cpuSeconds: parts.reduce((sum, value) => sum * 60 + value, 0),
  };
}
export async function directoryBytes(directory) {
  let bytes = 0;
  for (const item of await fs.readdir(directory, { withFileTypes: true })) {
    const file = `${directory}/${item.name}`;
    bytes += item.isDirectory() ? await directoryBytes(file) : (await fs.stat(file)).size;
  }
  return bytes;
}
export function corpusDocument(index, chunks) {
  // Fixed lengths make actual chunk counts auditable; no copied business data.
  return Array.from(
    { length: chunks },
    (_, part) =>
      `Synthetic policy ${index} section ${part}. Travel reimbursement limit is 180 CAD. Receipt review requires Finance approval. ${'Policy evidence for approved travel. '.repeat(12)}\n`,
  ).join('\n');
}
