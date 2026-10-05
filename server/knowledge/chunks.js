import { createHash } from 'node:crypto';
import { limits, failure } from './contracts.js';
export const hash = (value) => createHash('sha256').update(value).digest('hex');
export function chunksFor(source, extraction, { size = 1000, overlap = 150 } = {}) {
  if (
    !Number.isInteger(size) ||
    size < 200 ||
    size > 4000 ||
    !Number.isInteger(overlap) ||
    overlap < 0 ||
    overlap >= size / 2
  )
    throw failure('VALIDATION_ERROR', 'Invalid chunk size or overlap.');
  const chunks = [];
  let base = 0;
  for (const segment of extraction.segments) {
    const text = segment.text;
    for (let start = 0; start < text.length;) {
      let end = Math.min(text.length, start + size);
      if (end < text.length) {
        const boundary = text.lastIndexOf('\n', end);
        if (boundary > start + size * 0.7) end = boundary;
      }
      const content = text.slice(start, end);
      const next = end === text.length ? end : Math.max(start + 1, end - overlap);
      if (!content.trim()) {
        start = next;
        continue;
      }
      const location = {
        start: base + start,
        end: base + end,
        ...(segment.page ? { page: segment.page } : {}),
        ...(source.input.url ? { url: source.input.url } : {}),
      };
      chunks.push({
        id:
          'ch_' + hash(`${source.id}:${source.version}:${location.start}:${content}`).slice(0, 60),
        ordinal: chunks.length,
        content,
        location,
      });
      if (chunks.length > limits.chunks)
        throw failure(
          'BUDGET_EXCEEDED',
          'Document exceeds the chunk budget; split it into smaller documents.',
        );
      if (end === text.length) break;
      start = next;
    }
    base += text.length + 1;
  }
  if (!chunks.length)
    throw failure(
      'VALIDATION_ERROR',
      'No readable text found; configure OCR for scanned documents.',
    );
  return chunks;
}
