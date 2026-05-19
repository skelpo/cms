// /healthz and /readyz endpoints.
//
// /healthz — always returns 200 if the HTTP listener is up. Used by
//            load balancers for liveness.
// /readyz  — returns 200 only when the DB is reachable. Used to
//            decide whether to route traffic to this instance.

import { Hono } from 'hono';
import { ping } from '../db/client.js';

export const healthRoutes = new Hono();

healthRoutes.get('/healthz', (c) => c.json({ status: 'ok' }));

healthRoutes.get('/readyz', async (c) => {
  const dbOk = await ping();
  if (!dbOk) {
    return c.json({ status: 'unavailable', db: 'unreachable' }, 503);
  }
  return c.json({ status: 'ok', db: 'ok' });
});
