import { PlatformError } from '../foundation/errors.js';
// Workers only. Never register settlement/release as user-facing routes.
export function createRuntimeSecurity({ authorize, usage, capacity, secrets }) {
  return Object.freeze({
    authorizeStep: async (context, resources = []) => {
      await authorize(context, 'run.execute');
      for (const resource of resources) await authorize(context, resource.permission, resource);
    },
    capacity,
    secrets,
    async metered(
      context,
      { reservation, permission = 'run.execute', resource = null, provider, model },
      call,
    ) {
      await authorize(context, permission, resource);
      const held = await usage.reserve(context, reservation);
      try {
        // Observe removal/revocation again after waiting for the budget lock.
        await authorize(context, permission, resource);
      } catch (error) {
        await usage.release(context, held.id);
        throw error;
      }
      let result;
      try {
        result = await call();
      } catch (error) {
        await usage.markUncertain(context, held.id);
        throw error;
      }
      // Missing provider usage remains unknown; never replace it with a zero-cost assertion.
      if (!result?.usage || !Number.isSafeInteger(result.usage.tokens) || result.usage.tokens < 0) {
        await usage.markUncertain(context, held.id);
        throw new PlatformError(
          'DEPENDENCY_UNAVAILABLE',
          'Metered service did not report bounded usage.',
        );
      }
      await usage.settle(context, held.id, {
        tokens: result.usage.tokens,
        costMicros: result.usage.costMicros ?? null,
        provider,
        model,
      });
      // Persist accounting even if authorization was revoked while the request was in flight.
      await authorize(context, permission, resource);
      return result;
    },
  });
}
