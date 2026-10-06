import { spawn, fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { limits, failure, checkSignal, processingBudgets } from './contracts.js';

export function signature(buffer, name) {
  if (buffer.length < 2) throw failure('VALIDATION_ERROR', 'File signature is incomplete.');
  const ext = name.toLowerCase().split('.').pop();
  const ascii = buffer.subarray(0, 12).toString('ascii');
  const detected =
    buffer.subarray(0, 5).toString() === '%PDF-'
      ? 'pdf'
      : buffer.readUInt16LE?.call(buffer, 0) === 0x4b50
        ? 'docx'
        : buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
          ? 'png'
          : buffer[0] === 255 && buffer[1] === 216 && buffer[2] === 255
            ? 'jpg'
            : ascii.startsWith('RIFF') && ascii.endsWith('WAVE')
              ? 'wav'
              : ascii.startsWith('ID3') || (buffer[0] === 255 && (buffer[1] & 0xe0) === 0xe0)
                ? 'mp3'
                : ascii.startsWith('OggS')
                  ? 'ogg'
                  : null;
  if (detected && !(detected === ext || (detected === 'jpg' && ext === 'jpeg')))
    throw failure('VALIDATION_ERROR', 'File signature does not match its extension.');
  if (!detected && !['txt', 'md', 'markdown', 'html', 'htm', 'csv', 'json'].includes(ext))
    throw failure(
      'VALIDATION_ERROR',
      'Unsupported or invalid file signature. Use PDF, DOCX, text, HTML, CSV, JSON, PNG, JPEG, WAV, MP3, or OGG.',
    );
  return detected || ext;
}
function imageBudget(buffer, extension) {
  let width, height;
  if (extension === 'png') {
    if (buffer.length < 33 || buffer.subarray(12, 16).toString() !== 'IHDR')
      throw failure('VALIDATION_ERROR', 'PNG header is invalid.');
    width = buffer.readUInt32BE(16);
    height = buffer.readUInt32BE(20);
  } else {
    let pos = 2;
    while (pos + 4 <= buffer.length) {
      if (buffer[pos] !== 255) break;
      const marker = buffer[pos + 1];
      pos += 2;
      if (marker === 0xd9 || marker === 0xda) break;
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
      const size = buffer.readUInt16BE(pos);
      if (size < 2 || pos + size > buffer.length) break;
      if ([0xc0, 0xc1, 0xc2].includes(marker)) {
        if (size < 7) break;
        height = buffer.readUInt16BE(pos + 3);
        width = buffer.readUInt16BE(pos + 5);
        break;
      }
      pos += size;
    }
  }
  if (!width || !height)
    throw failure('VALIDATION_ERROR', 'Image dimensions could not be validated.');
  if (width * height > 20_000_000 || width > 20000 || height > 20000)
    throw failure('BUDGET_EXCEEDED', 'Image exceeds the pixel budget; resize it before OCR.');
}
async function isolated(buffer, extension, budgets, signal) {
  checkSignal(signal);
  const worker = fork(fileURLToPath(new URL('./extract-worker.js', import.meta.url)), [], {
    execArgv: ['--max-old-space-size=256'],
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    serialization: 'advanced',
    windowsHide: true,
    env: {
      PATH: process.env.PATH,
      SystemRoot: process.env.SystemRoot,
      TMP: process.env.TMP,
      TEMP: process.env.TEMP,
      // Fixed scratch home: arbitrary container UIDs need not have passwd entries.
      // Canvas otherwise calls os.homedir() while loading system fonts and fails
      // after the credential-free environment drops the parent's HOME.
      HOME: os.tmpdir(),
      DISABLE_SYSTEM_FONTS_LOAD: '1',
      UV_THREADPOOL_SIZE: '1',
    },
  });
  try {
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(
        () =>
          reject(
            failure(
              'BUDGET_EXCEEDED',
              'Parsing time limit exceeded; split or simplify the document.',
            ),
          ),
        budgets.parseMs,
      );
      const abort = () => reject(signal.reason);
      signal?.addEventListener('abort', abort, { once: true });
      const finish = (fn) => (value) => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
        fn(value);
      };
      worker.once(
        'message',
        finish((m) => (m.error ? reject(failure('VALIDATION_ERROR', m.error)) : resolve(m.result))),
      );
      worker.once(
        'error',
        finish(() =>
          reject(failure('VALIDATION_ERROR', 'Document parser failed within its resource limits.')),
        ),
      );
      worker.once(
        'exit',
        finish(() =>
          reject(
            failure('VALIDATION_ERROR', 'Document parser exited before completing extraction.'),
          ),
        ),
      );
      worker.send({ buffer, extension, budgets });
    });
  } finally {
    worker.kill();
  }
}
export function createNativeOcr({ executable, language = 'eng', timeoutMs = 30000 } = {}) {
  if (!executable || !path.isAbsolute(executable) || !/^[a-z_+]{1,40}$/i.test(language))
    throw failure(
      'VALIDATION_ERROR',
      'Configure an absolute Tesseract executable path and installed language.',
    );
  return async function ocr(image, { signal } = {}) {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'relay-ocr-'));
    try {
      const file = path.join(dir, 'input.png');
      await fs.writeFile(file, image, { mode: 0o600 });
      return await new Promise((resolve, reject) => {
        const child = spawn(executable, [file, 'stdout', '-l', language], {
          shell: false,
          windowsHide: true,
          signal,
          timeout: timeoutMs,
          stdio: ['ignore', 'pipe', 'ignore'],
        });
        let text = '',
          failed = false;
        child.stdout.setEncoding('utf8');
        child.stdout.on('data', (b) => {
          text += b;
          if (text.length > limits.characters) child.kill();
        });
        child.once('error', () => {
          failed = true;
        });
        child.once('close', (code) =>
          !failed && code === 0 && text.length <= limits.characters
            ? resolve(text)
            : reject(
                failure(
                  'DEPENDENCY_UNAVAILABLE',
                  'OCR failed or could not start; verify Tesseract, image quality, and installed language.',
                ),
              ),
        );
      });
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  };
}
export async function parseFile(
  bytes,
  name,
  { signal, ocr, transcribe, budgets = limits, contentType } = {},
) {
  budgets = processingBudgets(budgets);
  checkSignal(signal);
  const buffer = Buffer.from(bytes);
  if (buffer.length < 2 || buffer.length > budgets.bytes)
    throw failure('BUDGET_EXCEEDED', 'File is empty or exceeds the upload budget.');
  const extension = signature(buffer, name);
  const types = {
    pdf: ['application/pdf'],
    docx: ['application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
    png: ['image/png'],
    jpg: ['image/jpeg'],
    wav: ['audio/wav', 'audio/x-wav', 'audio/wave'],
    mp3: ['audio/mpeg'],
    ogg: ['audio/ogg'],
    json: ['application/json', 'text/json'],
    csv: ['text/csv', 'application/csv'],
    html: ['text/html'],
    htm: ['text/html'],
    txt: ['text/plain'],
    md: ['text/markdown', 'text/plain'],
    markdown: ['text/markdown', 'text/plain'],
  };
  if (
    contentType &&
    !['application/octet-stream', ...(types[extension] || [])].includes(
      contentType.split(';')[0].toLowerCase(),
    )
  )
    throw failure(
      'VALIDATION_ERROR',
      'File content type does not match its signature and extension.',
    );
  let result;
  if (['png', 'jpg'].includes(extension)) {
    imageBudget(buffer, extension);
    if (!ocr) throw failure('DEPENDENCY_UNAVAILABLE', 'Image ingestion requires configured OCR.');
    result = { segments: [{ text: await ocr(buffer, { signal }) }], method: 'ocr', warnings: [] };
  } else if (['wav', 'mp3', 'ogg'].includes(extension)) {
    if (!transcribe)
      throw failure(
        'DEPENDENCY_UNAVAILABLE',
        'Audio ingestion requires an authorized transcription provider supporting this format.',
      );
    result = {
      segments: [{ text: await transcribe(buffer, { signal, name, format: extension }) }],
      method: 'transcription',
      warnings: [],
    };
  } else {
    result = await isolated(buffer, extension, budgets, signal);
    for (const page of result.segments)
      if (page.image) {
        if (!ocr)
          throw failure(
            'DEPENDENCY_UNAVAILABLE',
            'Scanned PDF pages require configured OCR; install Tesseract and reindex.',
          );
        page.text = await ocr(page.image, { signal });
        delete page.image;
        result.method = 'pdf+ocr';
      }
  }
  if (
    !result.segments.every((s) => typeof s.text === 'string') ||
    result.segments.reduce((n, s) => n + s.text.length, 0) > budgets.characters
  )
    throw failure('BUDGET_EXCEEDED', 'Extracted text exceeds the processing budget.');
  checkSignal(signal);
  return result;
}
