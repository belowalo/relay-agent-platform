import crypto from 'node:crypto';

const statuses = {
  VALIDATION_ERROR: 400,
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  BUDGET_EXCEEDED: 429,
  RATE_LIMITED: 429,
  DEPENDENCY_UNAVAILABLE: 503,
  INTERNAL_ERROR: 500,
};

export class PlatformError extends Error {
  constructor(code, message, options = {}) {
    super(message, { cause: options.cause });
    this.name = 'PlatformError';
    this.code = Object.hasOwn(statuses, code) ? code : 'INTERNAL_ERROR';
    this.status = statuses[this.code];
    this.retryable = options.retryable ?? false;
  }
}

// Public errors never reuse arbitrary dependency messages or request payloads.
export function errorEnvelope(error, requestId = crypto.randomUUID()) {
  const known = error instanceof PlatformError;
  return {
    error: {
      code: known ? error.code : 'INTERNAL_ERROR',
      message:
        known && error.status < 500 ? error.message : 'The operation could not be completed.',
      retryable: known ? error.retryable : false,
      requestId,
    },
  };
}
