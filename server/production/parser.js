import { PlatformError } from '../foundation/errors.js';
import { responseText } from '../network.js';
import { parseFile } from '../knowledge/extract.js';
import { z } from 'zod';
const resultSchema = z
  .object({
    segments: z
      .array(
        z
          .object({ text: z.string().max(2_000_000), page: z.number().int().positive().optional() })
          .passthrough(),
      )
      .max(10000),
    method: z.string().max(80),
    warnings: z.array(z.string().max(2000)).max(100),
  })
  .passthrough();
export function createProductionParser(env) {
  if (!env.PARSER_ENDPOINT || !env.PARSER_TOKEN || env.PARSER_TOKEN.length < 32) {
    return async (bytes, name, options) => {
      if (!/\.(txt|md|markdown|html|htm|csv|json)$/i.test(name))
        throw new PlatformError(
          'DEPENDENCY_UNAVAILABLE',
          'Configure the isolated document parser service for this format.',
        );
      return parseFile(bytes, name, options);
    };
  }
  const endpoint = new URL(env.PARSER_ENDPOINT);
  if (
    endpoint.username ||
    endpoint.password ||
    endpoint.search ||
    endpoint.hash ||
    endpoint.pathname !== '/' ||
    !(
      endpoint.protocol === 'https:' ||
      (endpoint.protocol === 'http:' && env.PARSER_INTERNAL_NETWORK === 'true')
    )
  )
    throw new Error('Invalid parser endpoint');
  return async (bytes, name, options) => {
    if (bytes.length > 15 * 1024 * 1024)
      throw new PlatformError('BUDGET_EXCEEDED', 'Document exceeds the parser budget.');
    const response = await fetch(new URL('/parse', endpoint), {
      method: 'POST',
      redirect: 'error',
      signal: AbortSignal.any([
        options.signal || new AbortController().signal,
        AbortSignal.timeout(35000),
      ]),
      headers: { Authorization: 'Bearer ' + env.PARSER_TOKEN, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name,
        bytes: Buffer.from(bytes).toString('base64'),
        contentType: options.contentType,
      }),
    });
    if (!response.ok)
      throw new PlatformError(
        'DEPENDENCY_UNAVAILABLE',
        'Isolated parser could not process the document within its budgets.',
      );
    const result = resultSchema.parse(JSON.parse(await responseText(response, 12_000_000)));
    if (result.segments.reduce((n, s) => n + s.text.length, 0) > 2_000_000)
      throw new PlatformError('BUDGET_EXCEEDED', 'Extracted text exceeds its budget.');
    return result;
  };
}
