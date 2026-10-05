import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
export async function parseUpload(buffer, name) {
  if (
    !Buffer.isBuffer(buffer) ||
    buffer.length > 15 * 1024 * 1024 ||
    typeof name !== 'string' ||
    name.length > 200 ||
    /[\x00-\x1f]/.test(name)
  )
    throw new Error('Invalid document upload');
  const extension = name.toLowerCase().split('.').pop();
  if (!['pdf', 'docx', 'txt', 'md', 'csv', 'json', 'html', 'htm'].includes(extension))
    throw new Error('Unsupported document format');
  if (extension === 'pdf' && !buffer.subarray(0, 1024).includes(Buffer.from('%PDF-')))
    throw new Error('Invalid PDF signature');
  if (extension === 'docx' && !buffer.subarray(0, 4).equals(Buffer.from([80, 75, 3, 4])))
    throw new Error('Invalid DOCX signature');
  if (
    (process.env.RELAY_PROFILE === 'production' || process.env.NODE_ENV === 'production') &&
    ['pdf', 'docx'].includes(extension)
  )
    throw new Error('Complex document parsing requires an OS-isolated parser adapter');
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        '--max-old-space-size=128',
        fileURLToPath(new URL('./upload-worker.js', import.meta.url)),
        extension,
      ],
      {
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
        env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot },
      },
    );
    let text = '',
      bytes = 0,
      finished = false;
    const finish = (error) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      child.kill();
      error ? reject(error) : resolve(text);
    };
    const timer = setTimeout(
      () => finish(new Error('Document parsing time limit exceeded')),
      15000,
    );
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      bytes += Buffer.byteLength(chunk);
      if (bytes > 2_000_000) finish(new Error('Extracted document exceeds text limit'));
      else text += chunk;
    });
    child.stderr.resume();
    child.stdin.on('error', () => {});
    child.on('error', () => finish(new Error('Document parser unavailable')));
    child.on('exit', (code) =>
      finish(code === 0 ? null : new Error('Document could not be parsed within resource limits')),
    );
    child.stdin.end(buffer);
  });
}
