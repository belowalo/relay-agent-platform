import { connectorFor } from './index.js';
import { errorEnvelope } from '../foundation/errors.js';
import { invalid } from './core.js';

/** Runtime mounts on its authenticated workspace router. Never accepts configuration/secrets from invocation JSON. */
export function registerConnectorRoutes(
  router,
  { contextFor, connections, portsFor, options = {} },
) {
  if (!contextFor || !connections?.get || !portsFor)
    throw invalid('Connector routes require verified context, repository and production ports.');
  const route = (handler) => async (req, res) => {
    let context;
    const controller = new AbortController();
    const abort = () => controller.abort();
    req.once('aborted', abort);
    res.once('close', abort);
    try {
      context = await contextFor(req);
      const connection = await connections.get(context, req.params.connectionId);
      const ports = await portsFor(context, connection);
      const connector = connectorFor(connection.kind, connection.config, ports, options);
      const result = await handler({
        req,
        context,
        connection,
        connector,
        signal: controller.signal,
      });
      if (!res.destroyed) res.json(result);
    } catch (error) {
      if (!res.destroyed)
        res.status(error.status || 500).json(errorEnvelope(error, context?.requestId));
    } finally {
      req.removeListener('aborted', abort);
      res.removeListener('close', abort);
    }
  };
  router.get(
    '/connectors/:connectionId/capabilities',
    route(async ({ connector }) => connector.descriptor),
  );
  router.post(
    '/connectors/:connectionId/test',
    route(async ({ context, connection, connector, signal }) =>
      connector.test(context, connection.secretRef, signal),
    ),
  );
  router.post(
    '/connectors/:connectionId/invoke',
    route(async ({ req, context, connection, connector, signal }) => {
      if (
        !req.body ||
        Object.keys(req.body).some((k) => !['action', 'input'].includes(k)) ||
        typeof req.body.action !== 'string'
      )
        throw invalid('Provide action and input only.');
      return connector.invoke(context, {
        action: req.body.action,
        input: req.body.input,
        secretRef: connection.secretRef,
        signal,
      });
    }),
  );
}
