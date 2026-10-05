import { context, failure } from './contracts.js';

// Delegates to production-security. No role matrix, grants, or permission bypass here.
export function createKnowledgeSecurity(authorization, { documentScope } = {}) {
  return {
    async authorizeCleanup(ctx) {
      await authorization.authorize(ctx, 'document.write');
    },
    async authorize(ctx, { action, collectionId, sourceId }) {
      if (
        !['documents.read', 'documents.search', 'documents.write', 'documents.delete'].includes(
          action,
        )
      )
        throw failure('FORBIDDEN', 'Unknown knowledge action.');
      const permission = ['documents.write', 'documents.delete'].includes(action)
        ? 'document.write'
        : 'document.read';
      await authorization.authorize(ctx, permission, { kind: 'collection', id: collectionId });
      if (sourceId)
        await authorization.authorize(ctx, permission, { kind: 'document', id: sourceId });
    },
    async documentPrincipals(ctx, { collectionId }) {
      ctx = context(ctx);
      await authorization.authorize(ctx, 'document.read', { kind: 'collection', id: collectionId });
      return [`${ctx.actor.kind}:${ctx.actor.id}`];
    },
    async documentScope(ctx, { collectionId }) {
      ctx = context(ctx);
      await authorization.authorize(ctx, 'document.read', { kind: 'collection', id: collectionId });
      if (documentScope) return documentScope(ctx, { collectionId });
      if (ctx.actor.kind !== 'user')
        throw failure(
          'FORBIDDEN',
          'Application/service retrieval requires security-owned document resource scope.',
        );
      return { principalIds: [`${ctx.actor.kind}:${ctx.actor.id}`] };
    },
  };
}
export function createKnowledgeResourceLookup(repository, collectionLookup) {
  return async (ctx, resource) => {
    if (resource.kind === 'collection') return collectionLookup(ctx, resource.id);
    if (resource.kind !== 'document') return null;
    const source = await repository.getSource(ctx, resource.id);
    return source ? { workspaceId: source.workspace_id, access: source.access } : null;
  };
}
export function createKnowledgeOutbound({ safeFetch, policy }) {
  return {
    fetch: async (ctx, url, options = {}) => {
      context(ctx);
      return safeFetch(
        url,
        {
          ...options,
          noRedirect: true,
          headers: { ...options.headers, 'User-Agent': 'RelayKnowledge/1.0' },
        },
        policy,
      );
    },
  };
}
