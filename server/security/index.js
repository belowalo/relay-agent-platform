import crypto from 'node:crypto';
import { createAuthorization } from './authorization.js';
import { createIdentityRepository } from './identity.js';
import { createMembershipRepository } from './membership.js';
import { createTokenRepository } from './tokens.js';
import { createSecretPort } from './credentials.js';
import { createUsagePort } from './usage.js';
import { createCapacityPort } from './capacity.js';
import { createRateLimiter } from './rate-limits.js';
import { createRuntimeSecurity } from './runtime.js';
import { browserBoundary } from './http.js';
import { resourceId } from '../foundation/contracts.js';
import { errorEnvelope } from '../foundation/errors.js';
import { createOrganizationControls } from './organization.js';
import { createWebhookVerifier } from './webhooks.js';
export function createSecurityServices({
  database,
  identityPool,
  ratePool,
  vault,
  resourceLookup,
  applicationLookup,
  serviceLookup,
}) {
  let tokens;
  const { authorize } = createAuthorization({
    database,
    resourceLookup,
    serviceLookup,
    applicationLookup: (context) => tokens.lookup(context),
  });
  tokens = createTokenRepository({ database, authorize, applicationLookup });
  const identity = createIdentityRepository({ pool: identityPool, vault });
  const membership = createMembershipRepository({ database, authorize });
  const secrets = createSecretPort({ database, authorize, vault });
  const usage = createUsagePort({ database, authorize }),
    capacity = createCapacityPort({ database, authorize });
  const rate = createRateLimiter({ pool: ratePool });
  return Object.freeze({
    authorize,
    tokens,
    identity,
    membership,
    secrets,
    usage,
    capacity,
    rate,
    organization: createOrganizationControls({ database, authorize }),
    webhooks: createWebhookVerifier({ database, authorize, secrets }),
    runtime: createRuntimeSecurity({ authorize, usage, capacity, secrets }),
  });
}
export function createSecurityMiddleware(services, { publicOrigin }) {
  return Object.freeze({
    browser: browserBoundary({ publicOrigin }),
    request(req, res, next) {
      req.requestId = crypto.randomUUID();
      res.set('X-Request-Id', req.requestId);
      next();
    },
    rate(policy, key = (req) => req.ip) {
      return async (req, res, next) => {
        try {
          await services.rate.consume(policy, key(req));
          next();
        } catch (error) {
          next(error);
        }
      };
    },
    async session(req, res, next) {
      try {
        req.user = await services.identity.authenticate(req.cookies?.relay_session);
        next();
      } catch (error) {
        next(error);
      }
    },
    workspace(permission, resource = (req) => null) {
      return async (req, res, next) => {
        try {
          const workspaceId = resourceId.parse(req.params.wid);
          const context = {
            workspaceId,
            actor: { kind: 'user', id: req.user.id },
            requestId: req.requestId,
          };
          req.tenant = await services.authorize(context, permission, resource(req));
          next();
        } catch (error) {
          next(error);
        }
      };
    },
    application(permission, resource = (req) => ({ kind: 'application', id: req.params.aid })) {
      return async (req, res, next) => {
        try {
          // Runtime resolves the application workspace from its authoritative row first.
          const context = await services.tokens.authenticate({
            workspaceId: req.application.workspace_id,
            applicationId: req.params.aid,
            token: (req.headers.authorization || '').replace(/^Bearer /i, ''),
            requestId: req.requestId,
          });
          req.tenant = await services.authorize(context, permission, resource(req));
          next();
        } catch (error) {
          next(error);
        }
      };
    },
    error(error, req, res, next) {
      if (res.headersSent) return next(error);
      const envelope = errorEnvelope(error, req.requestId);
      res.status(error.status || 500).json({
        error: envelope.error.message,
        errorCode: envelope.error.code,
        requestId: envelope.error.requestId,
      });
    },
  });
}
export function setSessionCookie(res, session) {
  res.cookie('relay_session', session.token, {
    httpOnly: true,
    secure: true,
    sameSite: 'strict',
    path: '/',
    maxAge: Math.max(0, session.expiresAt - Date.now()),
  });
}
