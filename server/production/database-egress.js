import fs from 'node:fs';
import net from 'node:net';
import { X509Certificate } from 'node:crypto';
import { z } from 'zod';
import { createOutboundPolicy, pinnedDestination } from '../network.js';
import { PlatformError } from '../foundation/errors.js';
const host = z
  .string()
  .min(1)
  .max(255)
  .refine(
    (v) =>
      !!net.isIP(v) ||
      /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(?:\.(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?))*\.?$/i.test(
        v,
      ),
  );
const destinationSchema = z
  .object({
    host,
    port: z.number().int().min(1).max(65535),
    database: z
      .string()
      .min(1)
      .max(128)
      .regex(/^[^\x00-\x1f]+$/),
  })
  .strict();
const deny = () => {
  throw new PlatformError('FORBIDDEN', 'Database destination is outside the administrator grant.');
};
// Deployment-owned configuration only; invocation and connection JSON cannot
// grant socket authority, private ranges, CA files or weaker certificate checks.
export function createDatabaseEgress(env) {
  let grants;
  try {
    grants = z
      .array(
        destinationSchema.extend({
          privateCidrs: z.array(z.string()).max(100).default([]),
          caFile: z.string().min(1).max(4000).optional(),
        }),
      )
      .max(100)
      .parse(JSON.parse(env.OUTBOUND_DATABASE_POLICY_JSON || '[]'))
      .map((g) => {
        const origin = `https://${net.isIP(g.host) === 6 ? '[' + g.host + ']' : g.host}:${g.port}`;
        const policy = createOutboundPolicy({ origins: [origin], privateCidrs: g.privateCidrs });
        let ca;
        if (g.caFile) {
          if (fs.statSync(g.caFile).size > 1_000_000) throw new Error('CA limit');
          ca = fs.readFileSync(g.caFile, 'utf8');
          new X509Certificate(ca);
        }
        return { ...g, origin, policy, ca };
      });
  } catch {
    throw new Error('Invalid administrator database egress configuration');
  }
  return async (_ctx, input) => {
    const d = destinationSchema.safeParse(input);
    if (!d.success) deny();
    const g = grants.find(
      (g) =>
        g.host.toLowerCase() === d.data.host.toLowerCase() &&
        g.port === d.data.port &&
        g.database === d.data.database,
    );
    if (!g) deny();
    let approved;
    try {
      approved = await pinnedDestination(g.origin, g.policy);
    } catch {
      deny();
    }
    return Object.freeze({
      address: approved.address,
      ...(!net.isIP(approved.hostname) ? { servername: approved.hostname } : {}),
      ...(g.ca ? { ca: g.ca } : {}),
    });
  };
}
