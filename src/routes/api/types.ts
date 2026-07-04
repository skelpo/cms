// /api/v1/types/* — content type registry + schema evolution.

import { Hono } from 'hono';
import { listTypes, getTypeBySlug } from '../../content/types.js';
import {
  createType,
  updateType,
  deleteType,
  validateFieldsSchema,
} from '../../content/typeWriter.js';
import { query } from '../../db/client.js';
import { normalizeDates } from '../../db/datetime.js';
import { errorResponse } from './_helpers.js';
import { requireAuth, isResponse } from '../../auth/middleware.js';
import { can } from '../../permissions/check.js';

export const typeRoutes = new Hono();

typeRoutes.get('/', async (c) => {
  const types = await listTypes();
  return c.json({ data: types });
});

typeRoutes.get('/:slug', async (c) => {
  const t = await getTypeBySlug(c.req.param('slug'));
  if (!t) return errorResponse(c, 'notFound', 'Type not found', 404);
  return c.json({ data: t });
});

typeRoutes.get('/:slug/revisions', async (c) => {
  const auth = requireAuth(c);
  if (isResponse(auth)) return auth;
  const t = await getTypeBySlug(c.req.param('slug'));
  if (!t) return errorResponse(c, 'notFound', 'Type not found', 404);
  const revs = await query(
    `SELECT \`revision\`, \`changes\`, \`note\`, \`authorId\`, \`createdAt\`
       FROM \`contentTypeRevisions\` WHERE \`typeId\` = ? ORDER BY \`revision\` DESC`,
    [t.id],
  );
  return c.json({ data: normalizeDates(revs) });
});

typeRoutes.post('/', async (c) => {
  const auth = requireAuth(c);
  if (isResponse(auth)) return auth;
  if (!can({ userId: auth.user.id, caps: auth.role.capabilities }, 'manageTypes')) {
    return errorResponse(c, 'forbidden', 'manageTypes capability required', 403);
  }
  const body = await c.req.json<Record<string, unknown>>().catch(() => ({}) as Record<string, unknown>);
  const schemaCheck = validateFieldsSchema(body.fieldsSchema);
  if (!schemaCheck.ok) return errorResponse(c, 'validationError', schemaCheck.error, 422);
  if (!body.slug || !body.labelSingular || !body.labelPlural) {
    return errorResponse(c, 'validationError', 'slug, labelSingular, labelPlural required', 422);
  }
  const result = await createType(
    {
      slug: String(body.slug),
      labelSingular: String(body.labelSingular),
      labelPlural: String(body.labelPlural),
      isRoutable: body.isRoutable !== false,
      urlPattern: (body.urlPattern as string | null) ?? null,
      icon: body.icon ? String(body.icon) : undefined,
      fieldsSchema: body.fieldsSchema as Parameters<typeof createType>[0]['fieldsSchema'],
    },
    auth.user.id,
  );
  if (!result.ok) return errorResponse(c, 'conflict', result.error, 409);
  const created = await getTypeBySlug(String(body.slug));
  return c.json({ data: created }, 201);
});

typeRoutes.patch('/:slug', async (c) => {
  const auth = requireAuth(c);
  if (isResponse(auth)) return auth;
  if (!can({ userId: auth.user.id, caps: auth.role.capabilities }, 'manageTypes')) {
    return errorResponse(c, 'forbidden', 'manageTypes capability required', 403);
  }
  const slug = c.req.param('slug');
  const body = await c.req.json<Record<string, unknown>>().catch(() => ({}) as Record<string, unknown>);
  if (body.fieldsSchema) {
    const sc = validateFieldsSchema(body.fieldsSchema);
    if (!sc.ok) return errorResponse(c, 'validationError', sc.error, 422);
  }
  const dryRun = body.dryRun === true || c.req.query('dryRun') === 'true';
  const result = await updateType(
    slug,
    body as Parameters<typeof updateType>[1],
    auth.user.id,
    { dryRun },
  );
  if (!result.ok) {
    const status = (result.status ?? 404) as 404 | 409 | 422;
    const code = status === 422 ? 'validationError' : status === 409 ? 'conflict' : 'notFound';
    return errorResponse(c, code, result.error, status);
  }
  return c.json({
    data: {
      dryRun,
      newRevision: result.newRevision,
      affectedRows: result.affectedRows,
    },
  });
});

typeRoutes.delete('/:slug', async (c) => {
  const auth = requireAuth(c);
  if (isResponse(auth)) return auth;
  if (!can({ userId: auth.user.id, caps: auth.role.capabilities }, 'manageTypes')) {
    return errorResponse(c, 'forbidden', 'manageTypes capability required', 403);
  }
  const slug = c.req.param('slug');
  const force = c.req.query('force') === 'true';
  const result = await deleteType(slug, { force });
  if (!result.ok) {
    return errorResponse(c, result.status === 404 ? 'notFound' : 'conflict', result.error, result.status as 404 | 409);
  }
  return c.body(null, 204);
});
