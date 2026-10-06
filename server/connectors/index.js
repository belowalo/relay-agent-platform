import { createConnector, invalid } from './core.js';
import { github, slack, drive, rest } from './native.js';
import { createS3Adapter, createPostgresAdapter } from './storage.js';
import { createMcpAdapter } from './mcp.js';
export { createConnector, ConnectorError } from './core.js';
export { createS3BlobStore } from './storage.js';
export { synchronizeDocuments, documentFromResult } from './sync.js';
export { createDocumentSource } from './sources.js';
export { createConnectionRepository, createSyncState } from './repository.js';
export { createModelAdapter } from './models.js';
export function validateConnectorConfig(kind, config) {
  const adapters = {
    github,
    slack,
    'google-drive': drive,
    s3: createS3Adapter(),
    postgresql: createPostgresAdapter(),
    rest,
    mcp: createMcpAdapter(),
  };
  try {
    if (!adapters[kind]) throw invalid();
    return adapters[kind].validate(structuredClone(config));
  } catch {
    throw invalid();
  }
}
export function connectorFor(kind, config, ports, options = {}) {
  const adapters = {
    github,
    slack,
    'google-drive': drive,
    s3: createS3Adapter(options),
    postgresql: createPostgresAdapter(options),
    rest,
    mcp: createMcpAdapter(options),
  };
  let adapter = adapters[kind];
  if (!adapter) throw invalid('Connector type is unsupported.');
  if (kind === 'rest') {
    const c = rest.validate(config),
      testAction = Object.keys(c.actions).find((k) =>
        ['GET', 'HEAD'].includes(c.actions[k].method),
      );
    if (!testAction)
      throw invalid('REST configuration requires a read-only connection test action.');
    adapter = {
      ...rest,
      testAction,
      testInput: () => options.testInput || {},
      testCapabilities: () => [testAction],
    };
  }
  return createConnector(adapter, config, ports, options);
}
