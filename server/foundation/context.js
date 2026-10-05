import { AsyncLocalStorage } from 'node:async_hooks';
import crypto from 'node:crypto';
import { tenantContextSchema } from './contracts.js';
import { PlatformError } from './errors.js';

const storage = new AsyncLocalStorage();
export function withTenant(context, callback) {
  const parsed = tenantContextSchema.parse(context);
  return storage.run(Object.freeze({ ...parsed, actor: Object.freeze(parsed.actor) }), callback);
}
export function tenantContext() {
  const context = storage.getStore();
  if (!context) throw new PlatformError('FORBIDDEN', 'Workspace context is required.');
  return context;
}
export function assertWorkspace(workspaceId, context = tenantContext()) {
  if (context.workspaceId !== workspaceId)
    throw new PlatformError('FORBIDDEN', 'Resource access is not allowed.');
}
export function requestId(value) {
  return typeof value === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(value)
    ? value
    : crypto.randomUUID();
}
