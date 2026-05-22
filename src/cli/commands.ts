// Per-resource CLI commands. All talk to the running CMS via /api/v1/*
// (cli/api.ts). Keeping the CLI on the HTTP API rather than direct DB
// access means: CLI ≡ API ≡ Admin UI in capabilities forever. The CLI
// also works against remote servers (e.g. production) with one env var.
//
// For operational commands that need direct DB access (migrate, seed,
// backup, restore, types-codegen), see ./main.ts which dispatches to
// ./backup.ts directly without going through the API.

import { api, ApiError } from './api.js';
import { saveSession, clearSession, loadSession } from './session.js';
import { readFile, writeFile, stat } from 'node:fs/promises';
import { basename } from 'node:path';
import { createInterface } from 'node:readline';

// ── tiny helpers ────────────────────────────────────────────────────

function out(o: unknown): void {
  if (o == null) return;
  if (typeof o === 'string') { console.log(o); return; }
  console.log(JSON.stringify(o, null, 2));
}

function err(msg: string): number {
  console.error(`error: ${msg}`);
  return 1;
}

function parseFlags(argv: string[]): { flags: Record<string, string>; positional: string[] } {
  const flags: Record<string, string> = {};
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq > 0) flags[a.slice(2, eq)] = a.slice(eq + 1);
      else if (argv[i + 1] !== undefined && !argv[i + 1]!.startsWith('--')) flags[a.slice(2)] = argv[++i]!;
      else flags[a.slice(2)] = 'true';
    } else positional.push(a);
  }
  return { flags, positional };
}

async function prompt(question: string, mask = false): Promise<string> {
  if (mask) process.stdout.write(question);
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: !mask });
  return new Promise<string>((resolve) => {
    if (mask) {
      // crude no-echo prompt — fine for CLI password input
      process.stdin.setRawMode?.(true);
      let buf = '';
      const onData = (b: Buffer): void => {
        const ch = b.toString('utf8');
        if (ch === '\n' || ch === '\r' || ch === '') {
          process.stdin.setRawMode?.(false);
          process.stdin.removeListener('data', onData);
          process.stdout.write('\n');
          rl.close();
          resolve(buf);
        } else if (ch === '') {
          process.exit(130);
        } else if (ch === '') {
          if (buf.length > 0) buf = buf.slice(0, -1);
        } else { buf += ch; }
      };
      process.stdin.on('data', onData);
    } else {
      rl.question(question, (ans) => { rl.close(); resolve(ans); });
    }
  });
}

// ── auth ────────────────────────────────────────────────────────────

export async function cmdLogin(argv: string[]): Promise<number> {
  const { flags } = parseFlags(argv);
  const server = flags.server ?? process.env.SKELPO_SERVER ?? 'http://127.0.0.1:3137';
  const email = flags.email ?? await prompt('Email: ');
  const password = flags.password ?? await prompt('Password: ', true);

  const r = await fetch(`${server}/api/v1/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  if (!r.ok) return err(`login failed: HTTP ${r.status}`);
  const data = (await r.json()) as { data: { token: string } };
  await saveSession({ server, token: data.data.token, email, kind: 'session' });
  console.log(`Signed in as ${email} @ ${server}`);
  return 0;
}

export async function cmdLogout(): Promise<number> {
  await clearSession();
  console.log('Signed out (local session cleared).');
  return 0;
}

export async function cmdWhoami(): Promise<number> {
  const s = await loadSession();
  if (!s) { console.log('Not logged in.'); return 1; }
  const r = (await api('/api/v1/auth/me').catch(() => null)) as { data?: { user: { email: string; displayName: string }; role: { slug: string } } } | null;
  if (!r) { console.log(`Token saved for ${s.server} but server unreachable or expired.`); return 1; }
  console.log(`${r.data?.user.email} (${r.data?.user.displayName}) — role: ${r.data?.role.slug} @ ${s.server}`);
  return 0;
}

// ── tokens (API tokens for service accounts) ────────────────────────

export async function cmdTokens(argv: string[]): Promise<number> {
  const sub = argv[0];
  const { flags, positional } = parseFlags(argv.slice(1));
  switch (sub) {
    case 'list': {
      const r = await api('/api/v1/auth/tokens') as { data: unknown[] };
      out(r.data);
      return 0;
    }
    case 'create': {
      const name = positional[0] ?? flags.name;
      if (!name) return err('Usage: tokens create <name> [--scopes=*] [--ttl-days=365]');
      const r = await api('/api/v1/auth/tokens', { method: 'POST', body: { name, scopes: (flags.scopes ?? '*').split(','), ttlDays: Number(flags['ttl-days'] ?? 365) } }) as { data: { token: string } };
      out(r.data);
      console.log('\nSave the `token` — it will not be shown again.');
      return 0;
    }
    case 'revoke':
    case 'delete': {
      const id = positional[0];
      if (!id) return err('Usage: tokens revoke <id>');
      await api(`/api/v1/auth/tokens/${id}`, { method: 'DELETE' });
      console.log('Token revoked.');
      return 0;
    }
  }
  return err('Usage: tokens <list|create|revoke>');
}

// ── content ─────────────────────────────────────────────────────────

export async function cmdContent(argv: string[]): Promise<number> {
  const sub = argv[0];
  const { flags, positional } = parseFlags(argv.slice(1));
  switch (sub) {
    case 'list': {
      const r = await api('/api/v1/content', { query: {
        type: flags.type, locale: flags.locale, status: flags.status, limit: flags.limit, slug: flags.slug,
      } }) as { data: unknown[] };
      out(r.data);
      return 0;
    }
    case 'get': {
      const [type, slug] = positional;
      if (!type || !slug) return err('Usage: content get <type> <slug> [--locale=en]');
      const r = await api(`/api/v1/content/by-slug/${type}/${slug}`, { query: { locale: flags.locale ?? 'en' } }) as { data: unknown };
      out(r.data);
      return 0;
    }
    case 'create': {
      // Accept a JSON body via --file or stdin (or build from --type/--slug/--locale/--title/--from-md).
      let body: Record<string, unknown> = {};
      if (flags.file) body = JSON.parse(await readFile(flags.file, 'utf8'));
      else if (positional[0]) body = JSON.parse(await readFile(positional[0], 'utf8'));
      if (flags.type)   body.type = flags.type;
      if (flags.slug)   body.slug = flags.slug;
      if (flags.locale) body.locale = flags.locale;
      if (flags.title)  body.title = flags.title;
      if (flags['from-md']) {
        const md = await readFile(flags['from-md'], 'utf8');
        body.fields = { ...(body.fields as object ?? {}), body: md };
      }
      const r = await api('/api/v1/content', { method: 'POST', body }) as { data: { id: number } };
      out(r.data);
      if (flags.publish === 'true' || flags.publish === '1') {
        await api(`/api/v1/content/${r.data.id}/publish`, { method: 'POST' });
        console.log(`Published #${r.data.id}.`);
      }
      return 0;
    }
    case 'update': {
      const id = positional[0];
      if (!id) return err('Usage: content update <id> [--file=patch.json] [--title=...]');
      let patch: Record<string, unknown> = {};
      if (flags.file) patch = JSON.parse(await readFile(flags.file, 'utf8'));
      if (flags.title) patch.title = flags.title;
      if (flags.slug)  patch.slug  = flags.slug;
      if (flags['from-md']) {
        const md = await readFile(flags['from-md'], 'utf8');
        patch.fields = { ...(patch.fields as object ?? {}), body: md };
      }
      const r = await api(`/api/v1/content/${id}`, { method: 'PATCH', body: patch }) as { data: unknown };
      out(r.data);
      return 0;
    }
    case 'publish': {
      const id = positional[0];
      if (!id) return err('Usage: content publish <id>');
      await api(`/api/v1/content/${id}/publish`, { method: 'POST' });
      console.log(`Published #${id}.`);
      return 0;
    }
    case 'unpublish': {
      const id = positional[0];
      if (!id) return err('Usage: content unpublish <id>');
      await api(`/api/v1/content/${id}/unpublish`, { method: 'POST' });
      console.log(`Unpublished #${id}.`);
      return 0;
    }
    case 'delete':
    case 'rm': {
      const id = positional[0];
      if (!id) return err('Usage: content delete <id>');
      await api(`/api/v1/content/${id}`, { method: 'DELETE' });
      console.log(`Deleted #${id}.`);
      return 0;
    }
  }
  return err('Usage: content <list|get|create|update|publish|unpublish|delete>');
}

// ── types ───────────────────────────────────────────────────────────

export async function cmdTypes(argv: string[]): Promise<number> {
  const sub = argv[0];
  const { flags, positional } = parseFlags(argv.slice(1));
  switch (sub) {
    case 'list': {
      const r = await api('/api/v1/types') as { data: unknown[] };
      out(r.data);
      return 0;
    }
    case 'get': {
      const slug = positional[0];
      if (!slug) return err('Usage: types get <slug>');
      const r = await api(`/api/v1/types/${slug}`) as { data: unknown };
      out(r.data);
      return 0;
    }
    case 'create': {
      if (!flags.file) return err('Usage: types create --file=type.json');
      const body = JSON.parse(await readFile(flags.file, 'utf8'));
      const r = await api('/api/v1/types', { method: 'POST', body }) as { data: unknown };
      out(r.data);
      return 0;
    }
    case 'evolve':
    case 'update': {
      const slug = positional[0];
      if (!slug || !flags.file) return err('Usage: types evolve <slug> --file=schema.json [--dry-run]');
      const body = JSON.parse(await readFile(flags.file, 'utf8'));
      const r = await api(`/api/v1/types/${slug}`, {
        method: 'PATCH', body, query: { dryRun: flags['dry-run'] === 'true' ? 'true' : undefined },
      }) as { data: unknown };
      out(r.data);
      return 0;
    }
    case 'delete': {
      const slug = positional[0];
      if (!slug) return err('Usage: types delete <slug> [--force]');
      await api(`/api/v1/types/${slug}`, { method: 'DELETE', query: { force: flags.force === 'true' ? 'true' : undefined } });
      console.log(`Deleted type "${slug}".`);
      return 0;
    }
  }
  return err('Usage: types <list|get|create|evolve|delete>');
}

// ── settings ────────────────────────────────────────────────────────

export async function cmdSettings(argv: string[]): Promise<number> {
  const sub = argv[0];
  const { flags, positional } = parseFlags(argv.slice(1));
  switch (sub) {
    case 'list': {
      const r = await api('/api/v1/settings') as { data: Record<string, unknown> };
      // Filter by prefix if given
      const prefix = flags.prefix;
      const entries = Object.entries(r.data).filter(([k]) => !prefix || k.startsWith(prefix));
      out(Object.fromEntries(entries));
      return 0;
    }
    case 'get': {
      const key = positional[0];
      if (!key) return err('Usage: settings get <key>');
      const r = await api(`/api/v1/settings/${encodeURIComponent(key)}`) as { data: Record<string, unknown> };
      out(r.data[key]);
      return 0;
    }
    case 'set': {
      const key = positional[0];
      const valueRaw = positional[1] ?? flags.value;
      if (!key || valueRaw === undefined) return err('Usage: settings set <key> <value-or-@file.json>');
      let value: unknown;
      if (typeof valueRaw === 'string' && valueRaw.startsWith('@')) {
        value = JSON.parse(await readFile(valueRaw.slice(1), 'utf8'));
      } else {
        // Try to parse JSON; if it fails, store as string
        try { value = JSON.parse(valueRaw); } catch { value = valueRaw; }
      }
      await api(`/api/v1/settings/${encodeURIComponent(key)}`, { method: 'PUT', body: { value } });
      console.log(`Set ${key}.`);
      return 0;
    }
  }
  return err('Usage: settings <list|get|set>');
}

// ── menus ───────────────────────────────────────────────────────────

export async function cmdMenus(argv: string[]): Promise<number> {
  const sub = argv[0];
  const { flags, positional } = parseFlags(argv.slice(1));
  switch (sub) {
    case 'list': {
      const r = await api('/api/v1/menus') as { data: unknown[] };
      out(r.data);
      return 0;
    }
    case 'tree':
    case 'get': {
      const slug = positional[0];
      if (!slug) return err('Usage: menus tree <slug> [--locale=en]');
      const r = await api(`/api/v1/menus/${slug}`, { query: { locale: flags.locale } }) as { data: unknown };
      out(r.data);
      return 0;
    }
    case 'create': {
      const slug = positional[0] ?? flags.slug;
      const label = flags.label ?? slug;
      if (!slug) return err('Usage: menus create <slug> [--label=...]');
      const r = await api('/api/v1/menus', { method: 'POST', body: { slug, label } }) as { data: unknown };
      out(r.data);
      return 0;
    }
    case 'add-item': {
      const slug = positional[0];
      if (!slug || !flags.label || !flags.url) return err('Usage: menus add-item <slug> --label=... --url=... [--target=_blank] [--parent-id=N]');
      const body: Record<string, unknown> = {
        label: { en: flags.label },
        url: flags.url,
        target: flags.target ?? '_self',
        sortOrder: Number(flags.sortOrder ?? flags.order ?? 0),
      };
      if (flags['parent-id']) body.parentId = Number(flags['parent-id']);
      const r = await api(`/api/v1/menus/${slug}/items`, { method: 'POST', body }) as { data: { id: number } };
      out(r.data);
      return 0;
    }
    case 'remove-item': {
      const slug = positional[0];
      const id = positional[1];
      if (!slug || !id) return err('Usage: menus remove-item <slug> <itemId>');
      await api(`/api/v1/menus/${slug}/items/${id}`, { method: 'DELETE' });
      console.log('Removed.');
      return 0;
    }
    case 'delete': {
      const slug = positional[0];
      if (!slug) return err('Usage: menus delete <slug>');
      await api(`/api/v1/menus/${slug}`, { method: 'DELETE' });
      console.log(`Deleted menu "${slug}".`);
      return 0;
    }
  }
  return err('Usage: menus <list|tree|create|add-item|remove-item|delete>');
}

// ── media ───────────────────────────────────────────────────────────

export async function cmdMedia(argv: string[]): Promise<number> {
  const sub = argv[0];
  const { flags, positional } = parseFlags(argv.slice(1));
  switch (sub) {
    case 'list': {
      const r = await api('/api/v1/media', { query: { mimeType: flags.type, limit: flags.limit } }) as { data: unknown[] };
      out(r.data);
      return 0;
    }
    case 'get': {
      const id = positional[0];
      if (!id) return err('Usage: media get <id>');
      const r = await api(`/api/v1/media/${id}`) as { data: unknown };
      out(r.data);
      return 0;
    }
    case 'upload': {
      const path = positional[0];
      if (!path) return err('Usage: media upload <file> [--alt="..."]');
      const buf = await readFile(path);
      const fd = new FormData();
      const mime = flags.mime ?? mimeFromName(basename(path));
      fd.append('file', new Blob([buf as BlobPart], { type: mime }), basename(path));
      if (flags.alt) fd.append('altText', JSON.stringify({ en: flags.alt }));
      const r = await api('/api/v1/media', { method: 'POST', formBody: fd }) as { data: unknown };
      out(r.data);
      return 0;
    }
    case 'delete': {
      const id = positional[0];
      if (!id) return err('Usage: media delete <id>');
      await api(`/api/v1/media/${id}`, { method: 'DELETE' });
      console.log(`Deleted media #${id}.`);
      return 0;
    }
  }
  return err('Usage: media <list|get|upload|delete>');
}

function mimeFromName(name: string): string {
  const ext = name.toLowerCase().split('.').pop() ?? '';
  return { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
    webp: 'image/webp', svg: 'image/svg+xml', pdf: 'application/pdf',
    mp4: 'video/mp4', webm: 'video/webm', mp3: 'audio/mpeg', wav: 'audio/wav',
    json: 'application/json', txt: 'text/plain' }[ext] ?? 'application/octet-stream';
}

// ── users / roles ───────────────────────────────────────────────────

export async function cmdUsers(argv: string[]): Promise<number> {
  const sub = argv[0];
  const { flags, positional } = parseFlags(argv.slice(1));
  switch (sub) {
    case 'list': {
      const r = await api('/api/v1/users') as { data: unknown[] };
      out(r.data);
      return 0;
    }
    case 'create': {
      const email = positional[0] ?? flags.email;
      const displayName = positional[1] ?? flags.name ?? email;
      if (!email) return err('Usage: users create <email> <displayName> [--role=admin] [--password=...] [--locale=en]');
      const password = flags.password ?? await prompt('Password: ', true);
      const body: Record<string, unknown> = { email, displayName, password, roleSlug: flags.role ?? 'editor' };
      if (flags.locale) body.locale = flags.locale;
      const r = await api('/api/v1/users', {
        method: 'POST',
        body,
      }) as { data: unknown };
      out(r.data);
      return 0;
    }
    case 'update': {
      const id = positional[0];
      if (!id) return err('Usage: users update <id> [--name=...] [--role=...] [--locale=en]');
      const patch: Record<string, unknown> = {};
      if (flags.name) patch.displayName = flags.name;
      if (flags.role) patch.roleSlug = flags.role;
      if (flags.locale) patch.locale = flags.locale;
      const r = await api(`/api/v1/users/${id}`, { method: 'PATCH', body: patch }) as { data: unknown };
      out(r.data);
      return 0;
    }
    case 'suspend': {
      const id = positional[0];
      if (!id) return err('Usage: users suspend <id>');
      await api(`/api/v1/users/${id}/suspend`, { method: 'POST' });
      console.log(`Suspended user #${id}.`);
      return 0;
    }
    case 'unsuspend': {
      const id = positional[0];
      if (!id) return err('Usage: users unsuspend <id>');
      await api(`/api/v1/users/${id}/unsuspend`, { method: 'POST' });
      console.log(`Unsuspended user #${id}.`);
      return 0;
    }
  }
  return err('Usage: users <list|create|update|suspend|unsuspend> [--locale=en]');
}

export async function cmdRoles(argv: string[]): Promise<number> {
  const sub = argv[0];
  const { flags, positional } = parseFlags(argv.slice(1));
  switch (sub) {
    case 'list': {
      const r = await api('/api/v1/roles') as { data: unknown[] };
      out(r.data);
      return 0;
    }
    case 'create': {
      const slug = positional[0];
      if (!slug || !flags.caps) return err('Usage: roles create <slug> --caps=cap1,cap2,... --label=...');
      const r = await api('/api/v1/roles', { method: 'POST', body: {
        slug, label: flags.label ?? slug, capabilities: flags.caps.split(','),
      } }) as { data: unknown };
      out(r.data);
      return 0;
    }
    case 'update': {
      const slug = positional[0];
      if (!slug) return err('Usage: roles update <slug> [--label=...] [--caps=...]');
      const patch: Record<string, unknown> = {};
      if (flags.label) patch.label = flags.label;
      if (flags.caps) patch.capabilities = flags.caps.split(',');
      const r = await api(`/api/v1/roles/${slug}`, { method: 'PATCH', body: patch }) as { data: unknown };
      out(r.data);
      return 0;
    }
    case 'delete': {
      const slug = positional[0];
      if (!slug) return err('Usage: roles delete <slug>');
      await api(`/api/v1/roles/${slug}`, { method: 'DELETE' });
      console.log(`Deleted role "${slug}".`);
      return 0;
    }
  }
  return err('Usage: roles <list|create|update|delete>');
}

// ── menus, redirects, webhooks, jobs, forms ─────────────────────────

export async function cmdRedirects(argv: string[]): Promise<number> {
  const sub = argv[0];
  const { flags, positional } = parseFlags(argv.slice(1));
  switch (sub) {
    case 'list': {
      const r = await api('/api/v1/redirects') as { data: unknown[] };
      out(r.data);
      return 0;
    }
    case 'add':
    case 'create': {
      const from = positional[0] ?? flags.from;
      const to = positional[1] ?? flags.to;
      if (!from || !to) return err('Usage: redirects add <from> <to> [--status=301]');
      const r = await api('/api/v1/redirects', { method: 'POST', body: {
        fromPath: from, toPath: to, statusCode: Number(flags.status ?? 301),
      } }) as { data: unknown };
      out(r.data);
      return 0;
    }
    case 'delete':
    case 'rm': {
      const id = positional[0];
      if (!id) return err('Usage: redirects delete <id>');
      await api(`/api/v1/redirects/${id}`, { method: 'DELETE' });
      console.log(`Deleted redirect #${id}.`);
      return 0;
    }
  }
  return err('Usage: redirects <list|add|delete>');
}

export async function cmdWebhooks(argv: string[]): Promise<number> {
  const sub = argv[0];
  const { flags, positional } = parseFlags(argv.slice(1));
  switch (sub) {
    case 'list': {
      const r = await api('/api/v1/webhooks') as { data: unknown[] };
      out(r.data);
      return 0;
    }
    case 'add':
    case 'create': {
      const url = positional[0] ?? flags.url;
      const events = (flags.events ?? '*').split(',');
      if (!url) return err('Usage: webhooks add <url> [--events=content.published,...] [--secret=...]');
      const body: Record<string, unknown> = { url, events };
      if (flags.secret) body.secret = flags.secret;
      const r = await api('/api/v1/webhooks', { method: 'POST', body }) as { data: unknown };
      out(r.data);
      return 0;
    }
    case 'deliveries': {
      const id = positional[0];
      if (!id) return err('Usage: webhooks deliveries <id>');
      const r = await api(`/api/v1/webhooks/${id}/deliveries`) as { data: unknown };
      out(r.data);
      return 0;
    }
    case 'delete':
    case 'rm': {
      const id = positional[0];
      if (!id) return err('Usage: webhooks delete <id>');
      await api(`/api/v1/webhooks/${id}`, { method: 'DELETE' });
      console.log(`Deleted webhook #${id}.`);
      return 0;
    }
  }
  return err('Usage: webhooks <list|add|delete|deliveries>');
}

export async function cmdJobs(argv: string[]): Promise<number> {
  const sub = argv[0];
  const { flags, positional } = parseFlags(argv.slice(1));
  switch (sub) {
    case 'stats': {
      const r = await api('/api/v1/jobs/stats') as { data: unknown };
      out(r.data);
      return 0;
    }
    case 'list': {
      const r = await api('/api/v1/jobs', { query: { status: flags.status, limit: flags.limit } }) as { data: unknown[] };
      out(r.data);
      return 0;
    }
    case 'get': {
      const id = positional[0];
      if (!id) return err('Usage: jobs get <id>');
      const r = await api(`/api/v1/jobs/${id}`) as { data: unknown };
      out(r.data);
      return 0;
    }
    case 'retry': {
      const id = positional[0];
      if (!id) return err('Usage: jobs retry <id>');
      await api(`/api/v1/jobs/${id}/retry`, { method: 'POST' });
      console.log(`Re-queued job #${id}.`);
      return 0;
    }
  }
  return err('Usage: jobs <stats|list|get|retry>');
}

export async function cmdForms(argv: string[]): Promise<number> {
  const sub = argv[0];
  const { flags, positional } = parseFlags(argv.slice(1));
  switch (sub) {
    case 'submissions': {
      const slug = positional[0];
      if (!slug) return err('Usage: forms submissions <slug>');
      const r = await api(`/api/v1/forms/${slug}/submissions`, { query: { limit: flags.limit } }) as { data: unknown[] };
      out(r.data);
      return 0;
    }
    case 'delete-submission': {
      const id = positional[0];
      if (!id) return err('Usage: forms delete-submission <id>');
      await api(`/api/v1/forms/submissions/${id}`, { method: 'DELETE' });
      console.log(`Deleted submission #${id}.`);
      return 0;
    }
    case 'mark-spam': {
      const id = positional[0];
      if (!id) return err('Usage: forms mark-spam <id>');
      await api(`/api/v1/forms/submissions/${id}/mark-spam`, { method: 'POST' });
      console.log(`Marked submission #${id} as spam.`);
      return 0;
    }
  }
  return err('Usage: forms <submissions|delete-submission|mark-spam>');
}

// ── api passthrough (escape hatch for anything we haven't wrapped) ──

export async function cmdApi(argv: string[]): Promise<number> {
  const method = (argv[0] ?? '').toUpperCase();
  const path = argv[1];
  if (!['GET', 'POST', 'PATCH', 'PUT', 'DELETE'].includes(method) || !path) {
    return err('Usage: api <GET|POST|PATCH|PUT|DELETE> <path> [--data="..."|@file.json]');
  }
  const { flags } = parseFlags(argv.slice(2));
  let body: unknown;
  const dataFlag = flags.data;
  if (typeof dataFlag === 'string') {
    if (dataFlag.startsWith('@')) body = JSON.parse(await readFile(dataFlag.slice(1), 'utf8'));
    else { try { body = JSON.parse(dataFlag); } catch { body = dataFlag; } }
  }
  const r = await api(path, { method: method as 'GET', body }) as unknown;
  out(r);
  return 0;
}
