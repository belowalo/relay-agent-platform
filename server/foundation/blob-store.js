import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { resourceId, tenantContextSchema } from './contracts.js';
import { PlatformError } from './errors.js';

// Single-host development adapter. Production uses shared object storage behind BlobPort.
export async function createLocalBlobStore(root, { maximumBytes = 15 * 1024 * 1024 } = {}) {
  root = path.resolve(root);
  await fs.mkdir(root, { recursive: true });
  const canonical = await fs.realpath(root);
  if (canonical !== root)
    throw new PlatformError('VALIDATION_ERROR', 'Blob root must not traverse a symbolic link.');
  async function target(context, key, create = false) {
    context = tenantContextSchema.parse(context);
    key = resourceId.parse(key);
    const directory = path.join(root, context.workspaceId);
    if (create) {
      try {
        await fs.mkdir(directory);
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
      }
    }
    try {
      const stat = await fs.lstat(directory);
      if (
        !stat.isDirectory() ||
        stat.isSymbolicLink() ||
        (await fs.realpath(directory)) !== directory
      )
        throw new PlatformError('FORBIDDEN', 'Blob directory is invalid.');
    } catch (error) {
      if (error.code === 'ENOENT') throw new PlatformError('NOT_FOUND', 'Blob not found.');
      throw error;
    }
    const filename = path.join(directory, key);
    try {
      const stat = await fs.lstat(filename);
      if (!stat.isFile() || stat.isSymbolicLink())
        throw new PlatformError('FORBIDDEN', 'Blob is invalid.');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    return filename;
  }
  return Object.freeze({
    async put(context, key, data, contentType) {
      if (
        !(data instanceof Uint8Array) ||
        data.byteLength > maximumBytes ||
        typeof contentType !== 'string' ||
        !/^[\w.+-]+\/[\w.+-]+$/.test(contentType)
      )
        throw new PlatformError('VALIDATION_ERROR', 'Blob size or content type is invalid.');
      const filename = await target(context, key, true);
      try {
        await fs.writeFile(filename, data, { flag: 'wx', mode: 0o600 });
      } catch (error) {
        if (error.code === 'EEXIST')
          throw new PlatformError('CONFLICT', 'Blob keys are immutable.');
        throw error;
      }
      return {
        workspaceId: context.workspaceId,
        key,
        sha256: crypto.createHash('sha256').update(data).digest('hex'),
        bytes: data.byteLength,
        contentType,
      };
    },
    async get(context, key) {
      const filename = await target(context, key);
      try {
        const stat = await fs.stat(filename);
        if (stat.size > maximumBytes)
          throw new PlatformError('VALIDATION_ERROR', 'Blob exceeds read limit.');
        return await fs.readFile(filename);
      } catch (error) {
        if (error.code === 'ENOENT') throw new PlatformError('NOT_FOUND', 'Blob not found.');
        throw error;
      }
    },
    async delete(context, key) {
      const filename = await target(context, key);
      await fs.rm(filename, { force: true });
    },
  });
}
