/** Contract v1. Async production ports; implementations must authorize before constructing context. */
export type TenantContext = Readonly<{
  workspaceId: string;
  actor: Readonly<{ kind: 'user' | 'application' | 'service'; id: string }>;
  requestId: string;
}>;
export interface DatabaseSession {
  readonly context: TenantContext;
  query(
    text: string,
    values?: unknown[],
  ): Promise<{ rows: Record<string, unknown>[]; rowCount: number | null }>;
  one(text: string, values?: unknown[]): Promise<Record<string, unknown> | null>;
  all(text: string, values?: unknown[]): Promise<Record<string, unknown>[]>;
}
export interface DatabasePort {
  transaction<T>(
    context: TenantContext,
    callback: (session: DatabaseSession) => Promise<T>,
  ): Promise<T>;
  probe(): Promise<boolean>;
  assertApplicationRole(): Promise<void>;
  close(): Promise<void>;
}
export interface JobReference {
  version: 1;
  id: string;
  workspaceId: string;
  kind:
    | 'workflow.run'
    | 'source.ingest'
    | 'connector.sync'
    | 'evaluation.run'
    | 'maintenance.retention';
  resourceId: string;
  requestId: string;
}
export interface QueuePort {
  publish(job: JobReference): Promise<string>;
  probe(): Promise<boolean>;
  createWorker(handler: (job: JobReference) => Promise<unknown>): { close(): Promise<void> };
  close(): Promise<void>;
}
export interface Lease {
  ownerId: string;
  generation: number;
  expiresAt: string;
}
export interface SecretReference {
  workspaceId: string;
  connectionId: string;
  version: number;
}
export interface SecretPort {
  /** Resolve only after checking actor permissions against current membership/policy. Never log the result. */
  resolve(context: TenantContext, reference: SecretReference): Promise<string>;
}
export interface BlobReference {
  workspaceId: string;
  key: string;
  sha256: string;
  bytes: number;
  contentType: string;
}
export interface BlobPort {
  put(
    context: TenantContext,
    key: string,
    data: Uint8Array,
    contentType: string,
  ): Promise<BlobReference>;
  get(context: TenantContext, key: string): Promise<Uint8Array>;
  delete(context: TenantContext, key: string): Promise<void>;
}
export interface ConnectorCall {
  action: string;
  input: unknown;
  secretRef?: SecretReference;
  idempotencyKey?: string;
  signal: AbortSignal;
}
export interface ConnectorResult {
  data: unknown;
  nextCursor?: string;
  providerRequestId?: string;
}
export interface ConnectorPort {
  test(
    context: TenantContext,
    secretRef?: SecretReference,
  ): Promise<{ ok: boolean; capabilities: string[] }>;
  invoke(context: TenantContext, call: ConnectorCall): Promise<ConnectorResult>;
}
export interface DocumentInput {
  collectionId: string;
  externalId: string;
  name: string;
  blob?: BlobReference;
  text?: string;
  url?: string;
  metadata: Record<string, string | number | boolean | null>;
  access: { mode: 'workspace' | 'restricted'; principalIds: string[] };
}
export interface DocumentPort {
  upsert(
    context: TenantContext,
    input: DocumentInput,
  ): Promise<{ sourceId: string; version: number; jobId: string }>;
  delete(context: TenantContext, sourceId: string): Promise<void>;
}
export interface UsageReservation {
  id: string;
  workspaceId: string;
  runId: string;
  maximumTokens: number;
  /** Integer micro-USD; null means unknown, never zero-cost. */
  maximumCostMicros: number | null;
}
export interface UsagePort {
  reserve(
    context: TenantContext,
    request: Omit<UsageReservation, 'id' | 'workspaceId'>,
  ): Promise<UsageReservation>;
  settle(
    context: TenantContext,
    reservationId: string,
    result: { tokens: number; costMicros: number | null; provider: string; model: string },
  ): Promise<void>;
  release(context: TenantContext, reservationId: string): Promise<void>;
}
export interface TelemetryPort {
  /** Attributes must be allowlisted: no prompts, documents, credentials, full URLs or user emails. */
  event(name: string, attributes: Record<string, string | number | boolean>): void;
  timing(
    name: string,
    milliseconds: number,
    attributes: Record<string, string | number | boolean>,
  ): void;
}
