// /api/v1/forms/* — public submit (spam-protected) + submissions admin.
//
// Forms are content rows of type `form`. The form's `fields` repeater
// defines accepted inputs + the success message + notification email.

import { Hono } from 'hono';
import { execute, query, queryOne } from '../../db/client.js';
import { normalizeDates } from '../../db/datetime.js';
import { findBySlug } from '../../content/content.js';
import { enqueue } from '../../jobs/queue.js';
import { fireEvent } from '../../webhooks/dispatch.js';
import { getDefaultLocale } from '../../settings/store.js';
import { errorResponse, clientIp, userAgent } from './_helpers.js';
import { requireAuth } from '../../auth/middleware.js';
import { can } from '../../permissions/check.js';

export const formRoutes = new Hono();

// Per-IP submit rate limit (in-memory sliding window — adequate single-tenant).
const ipHits = new Map<string, number[]>();
function rateLimited(ip: string, max = 5, windowMs = 60_000): boolean {
  const now = Date.now();
  const arr = (ipHits.get(ip) ?? []).filter((t) => now - t < windowMs);
  arr.push(now);
  ipHits.set(ip, arr);
  return arr.length > max;
}

// ─── POST /forms/:slug/submit (public) ───────────────────────────────────

formRoutes.post('/:slug/submit', async (c) => {
  const slug = c.req.param('slug');
  const ip = clientIp(c);

  if (rateLimited(ip)) {
    c.header('Retry-After', '60');
    return errorResponse(c, 'rateLimited', 'Too many submissions, slow down', 429, { retryAfterS: 60 });
  }

  const defaultLocale = await getDefaultLocale();
  const form = await findBySlug('form', slug, defaultLocale, /* includeDrafts */ false);
  if (!form) return errorResponse(c, 'notFound', 'Form not found', 404);

  const body = await c.req.json<Record<string, unknown>>().catch(() => ({}) as Record<string, unknown>);

  // Spam gate 1: honeypot must be empty.
  if (typeof body._hp === 'string' && body._hp.length > 0) {
    // Silently accept to not tip off bots; record as spam.
    await execute(
      'INSERT INTO `formSubmissions` (`formId`, `data`, `ip`, `userAgent`, `isSpam`) VALUES (?, ?, ?, ?, 1)',
      [form.id, JSON.stringify(body), ip, userAgent(c)],
    );
    const fields = parseFormFields(form.fields);
    return c.json({ data: { id: 0, message: fields.successMessage || 'Thanks!' } });
  }

  // Spam gate 2: timing — form rendered <2s ago is bot-fast.
  const ts = Number(body._ts);
  if (Number.isFinite(ts) && Date.now() - ts < 2000) {
    return errorResponse(c, 'validationError', 'Submitted too quickly', 422);
  }

  const fieldDefs = parseFormFields(form.fields);
  // Strip control fields; keep declared fields only.
  const clean: Record<string, unknown> = {};
  for (const f of fieldDefs.fields) {
    if (body[f.name] !== undefined) clean[f.name] = body[f.name];
    if (f.required && (clean[f.name] === undefined || clean[f.name] === '')) {
      return errorResponse(c, 'validationError', `Field '${f.name}' is required`, 422, { field: f.name });
    }
  }

  const r = await execute(
    'INSERT INTO `formSubmissions` (`formId`, `data`, `ip`, `userAgent`) VALUES (?, ?, ?, ?)',
    [form.id, JSON.stringify(clean), ip, userAgent(c)],
  );
  const submissionId = Number(r.insertId);

  // Notify admin + autoresponder via the job queue (async, always).
  if (fieldDefs.notificationEmail) {
    await enqueue('sendEmail', {
      templateSlug: 'formNotification',
      to: fieldDefs.notificationEmail,
      variables: {
        formName: form.title,
        submissionText: Object.entries(clean).map(([k, v]) => `${k}: ${String(v)}`).join('\n'),
        submissionHtml: Object.entries(clean).map(([k, v]) => `<p><b>${k}:</b> ${String(v)}</p>`).join(''),
      },
    });
  }
  void fireEvent('form.submitted', { formSlug: slug, submissionId }, [`content:${form.id}`]);

  return c.json({
    data: {
      id: submissionId,
      message: fieldDefs.successMessage || 'Thanks! We will be in touch.',
      redirectUrl: fieldDefs.redirectUrl || null,
    },
  });
});

interface ParsedForm {
  successMessage: string;
  redirectUrl: string;
  notificationEmail: string;
  fields: Array<{ name: string; required: boolean; type: string }>;
}

function parseFormFields(raw: string | Record<string, unknown>): ParsedForm {
  const f = typeof raw === 'string' ? JSON.parse(raw) : raw;
  const list = Array.isArray(f.fields) ? f.fields : [];
  return {
    successMessage: String(f.successMessage ?? ''),
    redirectUrl: String(f.redirectUrl ?? ''),
    notificationEmail: String(f.notificationEmail ?? ''),
    fields: list.map((x: Record<string, unknown>) => ({
      name: String(x.name ?? ''),
      required: !!x.required,
      type: String(x.type ?? 'text'),
    })),
  };
}

// ─── GET /forms/:slug/submissions (admin) ────────────────────────────────

formRoutes.get('/:slug/submissions', async (c) => {
  const auth = requireAuth(c);
  if (auth instanceof Response) return auth;
  if (!can({ userId: auth.user.id, caps: auth.role.capabilities }, 'manageForms')) {
    return errorResponse(c, 'forbidden', 'manageForms capability required', 403);
  }
  const slug = c.req.param('slug');
  const defaultLocale = await getDefaultLocale();
  const form = await findBySlug('form', slug, defaultLocale, true);
  if (!form) return errorResponse(c, 'notFound', 'Form not found', 404);
  const includeSpam = c.req.query('spam') === 'true';
  const rows = await query(
    `SELECT \`id\`, \`data\`, \`ip\`, \`isSpam\`, \`createdAt\`
       FROM \`formSubmissions\`
      WHERE \`formId\` = ? ${includeSpam ? '' : 'AND `isSpam` = 0'}
      ORDER BY \`createdAt\` DESC LIMIT 200`,
    [form.id],
  );
  return c.json({ data: normalizeDates(rows) });
});

formRoutes.delete('/submissions/:id', async (c) => {
  const auth = requireAuth(c);
  if (auth instanceof Response) return auth;
  if (!can({ userId: auth.user.id, caps: auth.role.capabilities }, 'manageForms')) {
    return errorResponse(c, 'forbidden', 'manageForms capability required', 403);
  }
  const id = Number(c.req.param('id'));
  const r = await execute('DELETE FROM `formSubmissions` WHERE `id` = ?', [id]);
  if (r.affectedRows === 0) return errorResponse(c, 'notFound', 'submission not found', 404);
  return c.body(null, 204);
});

formRoutes.post('/submissions/:id/mark-spam', async (c) => {
  const auth = requireAuth(c);
  if (auth instanceof Response) return auth;
  if (!can({ userId: auth.user.id, caps: auth.role.capabilities }, 'manageForms')) {
    return errorResponse(c, 'forbidden', 'manageForms capability required', 403);
  }
  const id = Number(c.req.param('id'));
  await execute('UPDATE `formSubmissions` SET `isSpam` = 1 WHERE `id` = ?', [id]);
  return c.body(null, 204);
});
