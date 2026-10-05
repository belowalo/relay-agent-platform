import { validateSchema } from './tools.js';

// These are transparent policy rules, not a claim of comprehensive AI moderation.
export function guardInput(config, input) {
  validateSchema(config.schema, input);
  const text = typeof input === 'string' ? input : JSON.stringify(input);
  const maxChars = Number(config.maxChars ?? 100000);
  if (!Number.isInteger(maxChars) || maxChars < 1 || maxChars > 1000000)
    throw new Error('Guardrail character limit must be between 1 and 1,000,000');
  if (text.length > maxChars) throw new Error('Guardrail blocked input: character limit exceeded');
  const terms = config.blockedTerms || [];
  if (
    !Array.isArray(terms) ||
    terms.length > 100 ||
    terms.some((t) => typeof t !== 'string' || !t.trim() || t.length > 200)
  )
    throw new Error('Guardrail blocked terms must be up to 100 nonempty phrases');
  if (terms.some((t) => text.toLocaleLowerCase().includes(t.toLocaleLowerCase())))
    throw new Error('Guardrail blocked input: a restricted phrase was found');
  const redactText = (value) => {
    if (config.redactEmails)
      value = value.replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[email redacted]');
    for (const literal of config.redactTerms || []) {
      if (typeof literal !== 'string' || !literal || literal.length > 200)
        throw new Error('Redaction terms must be nonempty phrases of up to 200 characters');
      value = value.split(literal).join('[redacted]');
    }
    return value;
  };
  if (config.redactTerms && (!Array.isArray(config.redactTerms) || config.redactTerms.length > 100))
    throw new Error('Use up to 100 redaction phrases');
  function visit(value) {
    if (typeof value === 'string') return redactText(value);
    if (Array.isArray(value)) return value.map(visit);
    if (value && typeof value === 'object')
      return Object.fromEntries(Object.entries(value).map(([k, v]) => [redactText(k), visit(v)]));
    return value;
  }
  return visit(input);
}
