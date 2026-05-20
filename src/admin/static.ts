// Serves vendored admin static assets (htmx) from disk. On Perry the
// asset is embedded at build time; on Node/Bun it's read once at boot
// and cached in memory.

import { readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Hono } from 'hono';

const ASSET_DIR = resolve(dirname(fileURLToPath(import.meta.url)), 'assets');

const cache = new Map<string, { body: string; type: string }>();

async function load(name: string, type: string): Promise<{ body: string; type: string }> {
  const hit = cache.get(name);
  if (hit) return hit;
  const body = await readFile(resolve(ASSET_DIR, name), 'utf8');
  const entry = { body, type };
  cache.set(name, entry);
  return entry;
}

export const adminStatic = new Hono();

adminStatic.get('/htmx.min.js', async (c) => {
  const { body, type } = await load('htmx.min.js', 'application/javascript; charset=utf-8');
  c.header('Content-Type', type);
  c.header('Cache-Control', 'public, max-age=31536000, immutable');
  return c.body(body);
});

adminStatic.get('/easymde/easymde.min.js', async (c) => {
  const { body, type } = await load('easymde/easymde.min.js', 'application/javascript; charset=utf-8');
  c.header('Content-Type', type);
  c.header('Cache-Control', 'public, max-age=31536000, immutable');
  return c.body(body);
});

adminStatic.get('/easymde/easymde.min.css', async (c) => {
  const { body, type } = await load('easymde/easymde.min.css', 'text/css; charset=utf-8');
  c.header('Content-Type', type);
  c.header('Cache-Control', 'public, max-age=31536000, immutable');
  return c.body(body);
});
