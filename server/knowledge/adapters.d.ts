import type {
  TenantContext,
  DatabasePort,
  BlobPort,
  DocumentInput,
  JobReference,
} from '../foundation/ports.js';
export type DocumentAction =
  'documents.read' | 'documents.search' | 'documents.write' | 'documents.delete';
export interface KnowledgeSecurity {
  /** Revalidate workspace document-write authority before reclaiming already retired blobs. */
  authorizeCleanup(context: TenantContext): Promise<void>;
  authorize(
    context: TenantContext,
    resource: {
      action: DocumentAction;
      collectionId: string;
      sourceId?: string;
      access?: DocumentInput['access'];
    },
  ): Promise<void>;
  documentPrincipals(context: TenantContext, resource: { collectionId: string }): Promise<string[]>;
  /** Security-owned resource scope is required for applications/services; never take this from request JSON. */
  documentScope?(
    context: TenantContext,
    resource: { collectionId: string },
  ): Promise<{ principalIds: string[]; sourceIds?: string[] }>;
}
export interface KnowledgeEmbeddings {
  readonly model: string;
  embed(
    context: TenantContext,
    texts: string[],
    options: { signal?: AbortSignal },
  ): Promise<number[][]>;
  close?(): Promise<void>;
}
export interface KnowledgeOutbound {
  fetch(
    context: TenantContext,
    url: string,
    options: {
      signal?: AbortSignal;
      headers?: Record<string, string>;
      redirect?: 'error';
      maximumBytes?: number;
    },
  ): Promise<Response>;
}
export interface KnowledgeDependencies {
  repository: { database: DatabasePort; [method: string]: unknown };
  blobs: BlobPort;
  security: KnowledgeSecurity;
  outbound: KnowledgeOutbound;
  embeddings: KnowledgeEmbeddings;
  /** Deployment-configured local executable, never a request-supplied command. */
  ocr?(image: Uint8Array, options: { signal?: AbortSignal }): Promise<string>;
  /** Provider/SecretPort/UsagePort authorization happens inside these adapters. */
  transcribe?(
    context: TenantContext,
    audio: Uint8Array,
    options: { signal?: AbortSignal; name: string; format: string },
  ): Promise<string>;
}
export interface GroundedModelRequest {
  system: string;
  question: string;
  evidence: {
    chunkId: string;
    text: string;
    metadata: Record<string, unknown>;
    sourceVersion: number;
  }[];
  tools: never[];
  signal?: AbortSignal;
}
export type ResolveIngestionContext = (job: JobReference) => Promise<TenantContext>;
