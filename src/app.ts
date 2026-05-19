// Root Hono app. Mounts all route modules. Runtime-agnostic — bind to an
// adapter in server.ts.

import { Hono } from 'hono';
import { healthRoutes } from './routes/healthz.js';
import { authRoutes } from './routes/api/auth.js';
import { contentRoutes } from './routes/api/content.js';
import { menuRoutes } from './routes/api/menus.js';
import { settingsRoutes } from './routes/api/settings.js';
import { webhookRoutes } from './routes/api/webhooks.js';
import { typeRoutes } from './routes/api/types.js';
import { userRoutes, roleRoutes } from './routes/api/users.js';
import { redirectRoutes } from './routes/api/redirects.js';
import { formRoutes } from './routes/api/forms.js';
import { mediaRoutes } from './routes/api/media.js';
import { adminRoutes } from './admin/routes.js';
import { attachAuthContext } from './auth/middleware.js';

export const app = new Hono();

// Standard headers on every response.
app.use('*', async (c, next) => {
  await next();
  c.header('X-Skelpo-Version', '0.1.0-pre');
});

// Resolve auth (cookie or bearer) for every request. Routes opt-in to
// requiring auth via requireAuth(c); the middleware itself doesn't reject.
app.use('*', attachAuthContext);

// Health endpoints (top-level, no /api prefix).
app.route('/', healthRoutes);

// API v1 routes.
const api = new Hono();
api.route('/auth', authRoutes);
api.route('/content', contentRoutes);
api.route('/menus', menuRoutes);
api.route('/settings', settingsRoutes);
api.route('/webhooks', webhookRoutes);
api.route('/types', typeRoutes);
api.route('/users', userRoutes);
api.route('/roles', roleRoutes);
api.route('/redirects', redirectRoutes);
api.route('/forms', formRoutes);
api.route('/media', mediaRoutes);
app.route('/api/v1', api);

// Admin UI (HTMX, server-rendered).
app.route('/admin', adminRoutes);

// Root placeholder until admin lands.
app.get('/', (c) =>
  c.text('Skelpo CMS — boot OK. Admin at /admin, API at /api/v1.\n'),
);

// 404 handler.
app.notFound((c) =>
  c.json({ error: { code: 'notFound', message: 'Route not found' } }, 404),
);

// Error handler. Real implementation will use structured logger.
app.onError((err, c) => {
  console.error('[skelpo-cms] unhandled error:', err);
  return c.json(
    { error: { code: 'internalError', message: 'Internal server error' } },
    500,
  );
});
