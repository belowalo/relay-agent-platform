import type {
  TenantContext,
  SecretReference,
  SecretPort,
  ConnectorPort,
} from '../foundation/ports.js';
/** Team-owned composition contracts; proposed shared additions are documented in the handoff. */
export interface ActionIntent {
  connectorId: string;
  connectorVersion: string;
  connectionId?: string;
  action: string;
  input: unknown;
  argumentHash: string;
  configurationHash: string;
  secretRef?: SecretReference;
  idempotencyKey?: string;
  requiresApproval: true;
}
export interface ConnectorSecurityPorts {
  authorize(
    context: TenantContext,
    request: {
      connectorId: string;
      action: string;
      config: unknown;
      secretRef?: SecretReference;
    },
  ): Promise<void>;
  secrets?: SecretPort;
  actions?: {
    /** Must bind approved intent, reauthorize reviewer/actor, fence execution and preserve uncertain outcomes. */
    execute<T>(context: TenantContext, intent: ActionIntent, perform: () => Promise<T>): Promise<T>;
  };
  outbound?: {
    authorize?(context: TenantContext, url: string): Promise<void>;
    authorizeDatabase?(
      context: TenantContext,
      target: { host: string; port: number; database: string },
    ): Promise<{ address: string; servername?: string; ca?: string }>;
    authorizeProcess?(
      context: TenantContext,
      process: { command: string; args: string[]; cwd?: string },
    ): Promise<void>;
  };
}
export interface ConnectorDescriptor {
  id: string;
  version: string;
  auth: 'none' | 'api-key' | 'oauth2' | 'database';
  actions: {
    id: string;
    effect: 'read' | 'write';
    idempotency: 'none' | 'provider-key' | 'read-only';
    requiresApproval: boolean;
  }[];
}
export interface DiscoverableConnector extends ConnectorPort {
  readonly descriptor: ConnectorDescriptor;
}
export interface SyncItem {
  sourceId: string;
  revision: string;
  removed: boolean;
}
export interface SyncCheckpoint {
  cursor: string | null;
  assertCurrent(): Promise<void>;
  getItem(externalId: string): Promise<SyncItem | null>;
  recordItem(externalId: string, item: SyncItem): Promise<void>;
  commitCursor(cursor: string | null): Promise<void>;
}
export interface SyncStatePort {
  withLease<T>(
    context: TenantContext,
    sourceId: string,
    work: (checkpoint: SyncCheckpoint) => Promise<T>,
  ): Promise<T>;
}
