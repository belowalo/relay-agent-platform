import { parentPort, workerData } from 'node:worker_threads';
import { parse } from 'parse5';
import { parse as csv } from 'csv-parse/sync';
import { inflateRawSync } from 'node:zlib';
import { limits } from './contracts.js';

export function htmlText(html) {
  const doc = parse(html);
  let visited = 0;
  function walk(node, depth = 0) {
    if (++visited > 100000 || depth > 200) throw new Error('HTML structure budget exceeded');
    if (['script', 'style', 'nav', 'noscript', 'template', 'svg', 'head'].includes(node.tagName))
      return '';
    if (node.nodeName === '#text') return node.value;
    const value = (node.childNodes || []).map((n) => walk(n, depth + 1)).join('');
    return ['p', 'div', 'section', 'article', 'h1', 'h2', 'h3', 'li', 'tr', 'br'].includes(
      node.tagName,
    )
      ? value + '\n'
      : value;
  }
  return walk(doc)
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n/g, '\n')
    .trim();
}
// Read the central directory before inflation. Mammoth must never inflate an unbounded archive.
function checkZip(buffer) {
  let end = -1;
  for (let i = buffer.length - 22; i >= Math.max(0, buffer.length - 65557); i--)
    if (buffer.readUInt32LE(i) === 0x06054b50) {
      end = i;
      break;
    }
  if (end < 0 || buffer.readUInt16LE(end + 4) || buffer.readUInt16LE(end + 6))
    throw new Error('Invalid ZIP directory');
  const count = buffer.readUInt16LE(end + 10),
    offset = buffer.readUInt32LE(end + 16);
  if (count > 2000 || count === 65535) throw new Error('ZIP entry budget exceeded');
  let pos = offset,
    total = 0,
    document = false;
  for (let n = 0; n < count; n++) {
    if (pos + 46 > end || buffer.readUInt32LE(pos) !== 0x02014b50)
      throw new Error('Invalid ZIP entry');
    const size = buffer.readUInt32LE(pos + 24),
      packed = buffer.readUInt32LE(pos + 20),
      length = buffer.readUInt16LE(pos + 28);
    const name = buffer.subarray(pos + 46, pos + 46 + length).toString();
    if (
      buffer.readUInt16LE(pos + 8) & 1 ||
      size === 0xffffffff ||
      size > 32 * 1024 * 1024 ||
      size > Math.max(1, packed) * 200 ||
      name.includes('..') ||
      name.startsWith('/') ||
      name.includes('\\')
    )
      throw new Error('Unsafe ZIP entry');
    total += size;
    if (total > 64 * 1024 * 1024) throw new Error('ZIP expansion budget exceeded');
    const local = buffer.readUInt32LE(pos + 42),
      method = buffer.readUInt16LE(pos + 10);
    if (
      local + 30 > buffer.length ||
      buffer.readUInt32LE(local) !== 0x04034b50 ||
      ![0, 8].includes(method)
    )
      throw new Error('Invalid ZIP local entry');
    const dataStart =
      local + 30 + buffer.readUInt16LE(local + 26) + buffer.readUInt16LE(local + 28);
    if (dataStart + packed > offset) throw new Error('Invalid ZIP compressed range');
    const actual =
      method === 0
        ? buffer.subarray(dataStart, dataStart + packed)
        : inflateRawSync(buffer.subarray(dataStart, dataStart + packed), {
            maxOutputLength: 32 * 1024 * 1024,
          });
    if (actual.length !== size)
      throw new Error('ZIP declared expansion does not match actual size');
    document ||= name === 'word/document.xml';
    pos += 46 + length + buffer.readUInt16LE(pos + 30) + buffer.readUInt16LE(pos + 32);
  }
  if (!document) throw new Error('DOCX document part missing');
}
export async function extract(buffer, extension, budgets = limits) {
  let segments;
  if (extension === 'pdf') {
    const { PDFParse } = await import('pdf-parse');
    const parser = new PDFParse({ data: new Uint8Array(buffer), isEvalSupported: false });
    try {
      const info = await parser.getInfo({ parsePageInfo: true });
      if (info.total > budgets.pages) throw new Error('PDF page budget exceeded');
      if (
        info.pages.some(
          (p) => p.width <= 0 || p.height <= 0 || (1600 * 1600 * p.height) / p.width > 20_000_000,
        )
      )
        throw new Error('PDF render pixel budget exceeded');
      const result = await parser.getText();
      segments = [];
      let imageBytes = 0,
        scannedPages = 0;
      for (const p of result.pages) {
        if (p.text.replace(/\s/g, '').length < 20) {
          const image = (
            await parser.getScreenshot({
              partial: [p.num],
              desiredWidth: 1600,
              imageBuffer: true,
              imageDataUrl: false,
            })
          ).pages[0];
          imageBytes += image.data.byteLength;
          scannedPages++;
          if (scannedPages > budgets.ocrPages || imageBytes > budgets.renderedBytes)
            throw new Error('PDF OCR/render budget exceeded');
          segments.push({ text: p.text, page: p.num, image: image.data });
        } else segments.push({ text: p.text, page: p.num });
      }
    } finally {
      await parser.destroy();
    }
  } else if (extension === 'docx') {
    checkZip(buffer);
    const mammoth = await import('mammoth');
    segments = [
      { text: (await mammoth.extractRawText({ buffer }, { externalFileAccess: false })).value },
    ];
  } else {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(buffer).replace(/^\uFEFF/, '');
    if (text.includes('\0')) throw new Error('Binary data in text input');
    let content = text;
    if (['html', 'htm'].includes(extension)) content = htmlText(text);
    if (extension === 'json') content = JSON.stringify(JSON.parse(text), null, 2);
    if (extension === 'csv') {
      const rows = csv(text, { bom: true, max_record_size: 100000, skip_empty_lines: true });
      if (rows.length > 100000) throw new Error('CSV row budget exceeded');
      const headers = rows.shift() || [];
      content = rows
        .map((row) =>
          row.map((value, i) => `${headers[i] || `Column ${i + 1}`}: ${value}`).join('; '),
        )
        .join('\n');
    }
    segments = [{ text: content }];
  }
  if (segments.reduce((n, s) => n + s.text.length, 0) > budgets.characters)
    throw new Error('Extracted text budget exceeded');
  return { segments, method: extension, warnings: [] };
}
if (parentPort) {
  try {
    parentPort.postMessage({
      result: await extract(
        Buffer.from(workerData.buffer),
        workerData.extension,
        workerData.budgets,
      ),
    });
  } catch {
    parentPort.postMessage({
      error: 'Document is corrupt, unsafe, encrypted, or exceeds parsing limits.',
    });
  }
}
if (process.send)
  process.once('message', async (data) => {
    try {
      process.send({
        result: await extract(Buffer.from(data.buffer), data.extension, data.budgets),
      });
    } catch {
      process.send({ error: 'Document is corrupt, unsafe, encrypted, or exceeds parsing limits.' });
    }
  });
