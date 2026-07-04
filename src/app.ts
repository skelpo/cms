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
import { jobsRoutes } from './routes/api/jobs.js';
import { adminRoutes } from './admin/routes.js';
import { attachAuthContext } from './auth/middleware.js';

export const app = new Hono();

// Standard + security headers on every response.
app.use('*', async (c, next) => {
  await next();
  c.header('X-Skelpo-Version', '0.1.0-pre');
  // Baseline hardening: stop MIME sniffing (also protects served media),
  // deny framing (clickjacking), and trim the Referer. HSTS is only emitted
  // when the original request was HTTPS (honoring X-Forwarded-Proto).
  c.header('X-Content-Type-Options', 'nosniff');
  c.header('X-Frame-Options', 'SAMEORIGIN');
  c.header('Referrer-Policy', 'strict-origin-when-cross-origin');
  const proto = c.req.header('x-forwarded-proto')?.split(',')[0]?.trim().toLowerCase()
    ?? (c.req.url.startsWith('https://') ? 'https' : 'http');
  if (proto === 'https') {
    c.header('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
});

// Resolve auth (cookie or bearer) for every request. Routes opt-in to
// requiring auth via requireAuth(c); the middleware itself doesn't reject.
// The admin UI language is resolved per-request inside adminRoutes (see
// src/admin/routes.tsx) so it covers every admin path including /admin.
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
api.route('/jobs', jobsRoutes);
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
