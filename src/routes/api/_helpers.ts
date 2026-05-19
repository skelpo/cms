// Small helpers shared by API route modules.

import type { Context } from 'hono';

export function errorResponse(
  c: Context,
  code: string,
  message: string,
  status: 400 | 401 | 403 | 404 | 409 | 422 | 429 | 500 | 503,
  details?: Record<string, unknown>,
): Response {
  const body: { error: { code: string; message: string; details?: Record<string, unknown> } } = {
    error: { code, message },
  };
  if (details) body.error.details = details;
  return c.json(body, status);
}

export function clientIp(c: Context): string {
  return (
    c.req.header('x-forwarded-for')?.split(',')[0]?.trim() ??
    c.req.header('x-real-ip') ??
    '0.0.0.0'
  );
}

export function userAgent(c: Context): string {
  return c.req.header('user-agent')?.slice(0, 255) ?? '';
}
