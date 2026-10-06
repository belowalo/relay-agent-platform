import crypto from 'node:crypto';
import { resourceId } from '../foundation/contracts.js';
import { PlatformError } from '../foundation/errors.js';
import { tokenHash } from './tokens.js';
import { writeAudit } from './audit.js';
// Custom Relay HMAC protocol. Provider-specific protocols belong in connectors.
export function createWebhookVerifier({ database, authorize, secrets }) {
  return Object.freeze({
    async verifyAndEnqueue(
      context,
      { applicationId, reference, timestamp, deliveryId, signature, rawBody },
      enqueue,
    ) {
      resourceId.parse(applicationId);
      await authorize(context, 'run.execute', { kind: 'application', id: applicationId });
      if (
        !Buffer.isBuffer(rawBody) ||
        rawBody.length > 3 * 1024 * 1024 ||
        typeof timestamp !== 'string' ||
        !/^\d{10}$/.test(timestamp) ||
        typeof deliveryId !== 'string' ||
        !/^[\w-]{16,128}$/.test(deliveryId) ||
        typeof signature !== 'string' ||
        !/^[a-f0-9]{64}$/.test(signature) ||
        Math.abs(Date.now() - Number(timestamp) * 1000) > 300000
      )
        throw new PlatformError('UNAUTHENTICATED', 'Webhook signature is invalid or expired.');
      const key = await secrets.resolve(context, reference);
      const expected = crypto
        .createHmac('sha256', key)
        .update(`${timestamp}.${applicationId}.${deliveryId}.`)
        .update(rawBody)
        .digest();
      if (!crypto.timingSafeEqual(expected, Buffer.from(signature, 'hex')))
        throw new PlatformError('UNAUTHENTICATED', 'Webhook signature is invalid or expired.');
      return database.transaction(context, async (s) => {
        await s.query(
          'DELETE FROM relay.security_webhook_replays WHERE workspace_id=$1 AND expires_at<now()',
          [context.workspaceId],
        );
        const result = await s.query(
          `INSERT INTO relay.security_webhook_replays VALUES($1,$2,$3,now()+interval '24 hours')
        ON CONFLICT DO NOTHING RETURNING delivery_hash`,
          [context.workspaceId, applicationId, tokenHash(deliveryId)],
        );
        if (!result.rows.length)
          throw new PlatformError('CONFLICT', 'Webhook delivery was already accepted.');
        const output = await enqueue(s);
        await writeAudit(s, context, 'webhook.accepted', applicationId);
        return output;
      });
    },
  });
}
