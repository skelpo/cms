// Secondary admin screens: settings, users, redirects, menus, jobs,
// webhooks. Server-rendered; forms POST to handlers that call the
// store/writer functions directly (already inside an authed session).

import { Hono } from 'hono';
import type { Context } from 'hono';
import { AdminPage } from './layout.js';
import type { AuthContext } from '../auth/middleware.js';
import { can } from '../permissions/check.js';
import { getAllSettings, setSetting, invalidateSettingsCache } from '../settings/store.js';
import { invalidate } from '../cache/deps.js';
import { execute, query, queryOne } from '../db/client.js';
import { normalizeDates } from '../db/datetime.js';
import { hashPassword } from '../auth/password.js';
import { listRoles, findRoleBySlug } from '../auth/users.js';
import { listMenus, getMenuTree, addMenuItem, deleteMenuItem } from '../menus/store.js';
import { jobStats, retryJob } from '../jobs/queue.js';
import { listWebhooks, createWebhook, deleteWebhook } from '../webhooks/dispatch.js';

export const adminScreens = new Hono();

function gate(c: Context): AuthContext | Response {
  const auth = c.get('auth');
  if (!auth) return c.redirect('/admin/login', 302);
  return auth;
}
function need(c: Context, auth: AuthContext, cap: Parameters<typeof can>[1]): boolean {
  return can({ userId: auth.user.id, caps: auth.role.capabilities }, cap);
}

// ── Settings ───────────────────────────────────────────────────────────

adminScreens.get('/settings', async (c) => {
  const auth = gate(c);
  if (auth instanceof Response) return auth;
  const all = await getAllSettings();
  const flash = c.req.query('ok');
  const keys = Object.keys(all).sort();
  return c.html(
    <AdminPage title="Settings" active="settings" user={auth.user}>
      <div class="top">
        <h1>Settings</h1>
      </div>
      {flash ? <div class="ok">{flash}</div> : null}
      <form method="post" action="/admin/settings" class="card">
        {keys.map((k) => {
          const v = all[k];
          const isObj = v !== null && typeof v === 'object';
          return (
            <div>
              <label>{k}</label>
              {isObj ? (
                <textarea name={`s_${k}`} rows={3}>
                  {JSON.stringify(v, null, 2)}
                </textarea>
              ) : (
                <input type="text" name={`s_${k}`} value={String(v ?? '')} />
              )}
            </div>
          );
        })}
        <div style="margin-top:16px">
          <button class="btn" type="submit">
            Save settings
          </button>
        </div>
      </form>
    </AdminPage>,
  );
});

adminScreens.post('/settings', async (c) => {
  const auth = gate(c);
  if (auth instanceof Response) return auth;
  if (!need(c, auth, 'manageSettings')) {
    return c.redirect('/admin/settings?ok=' + encodeURIComponent('Forbidden'), 302);
  }
  const body = await c.req.parseBody();
  const all = await getAllSettings();
  for (const [field, raw] of Object.entries(body)) {
    if (!field.startsWith('s_')) continue;
    const key = field.slice(2);
    const prev = all[key];
    let value: unknown = String(raw);
    if (prev !== null && typeof prev === 'object') {
      try { value = JSON.parse(String(raw)); } catch { value = prev; }
    } else if (Array.isArray(prev)) {
      try { value = JSON.parse(String(raw)); } catch { /* keep string */ }
    }
    await setSetting(key, value, auth.user.id);
    invalidate([`setting:${key}`]);
  }
  invalidateSettingsCache();
  invalidate(['GET:/settings'], { prefix: true });
  return c.redirect('/admin/settings?ok=Saved', 302);
});

// ── Users ──────────────────────────────────────────────────────────────

adminScreens.get('/users', async (c) => {
  const auth = gate(c);
  if (auth instanceof Response) return auth;
  const users = await query<{
    id: number; email: string; displayName: string; status: string; roleSlug: string; lastLoginAt: unknown;
  }>(
    `SELECT u.\`id\`,u.\`email\`,u.\`displayName\`,u.\`status\`,u.\`lastLoginAt\`,
            r.\`slug\` roleSlug
       FROM \`users\` u LEFT JOIN \`roles\` r ON r.\`id\`=u.\`roleId\` ORDER BY u.\`id\``,
  );
  const roles = await listRoles();
  const flash = c.req.query('ok');
  return c.html(
    <AdminPage title="Users" active="users" user={auth.user}>
      <div class="top">
        <h1>Users</h1>
      </div>
      {flash ? <div class="ok">{flash}</div> : null}
      <div class="card">
        <table>
          <thead>
            <tr>
              <th>Email</th>
              <th>Name</th>
              <th>Role</th>
              <th>Status</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {normalizeDates(users).map((u) => (
              <tr>
                <td>{u.email}</td>
                <td>{u.displayName}</td>
                <td class="muted">{u.roleSlug}</td>
                <td>{u.status}</td>
                <td>
                  {u.id !== auth.user.id ? (
                    <form method="post" action={`/admin/users/${u.id}/toggle`} style="margin:0">
                      <button class="btn sec sm" type="submit">
                        {u.status === 'suspended' ? 'Unsuspend' : 'Suspend'}
                      </button>
                    </form>
                  ) : (
                    <span class="muted">you</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div class="card" style="margin-top:16px">
        <h3 style="margin-top:0">Invite user</h3>
        <form method="post" action="/admin/users">
          <div class="grid g3">
            <div>
              <label>Email</label>
              <input type="email" name="email" required />
            </div>
            <div>
              <label>Display name</label>
              <input type="text" name="displayName" required />
            </div>
            <div>
              <label>Role</label>
              <select name="roleSlug">
                {roles.map((r) => (
                  <option value={r.slug}>{r.label}</option>
                ))}
              </select>
            </div>
          </div>
          <div style="margin-top:14px">
            <button class="btn" type="submit">
              Send invite
            </button>
          </div>
        </form>
      </div>
    </AdminPage>,
  );
});

adminScreens.post('/users', async (c) => {
  const auth = gate(c);
  if (auth instanceof Response) return auth;
  if (!need(c, auth, 'manageUsers')) return c.redirect('/admin/users?ok=Forbidden', 302);
  const b = await c.req.parseBody();
  const email = String(b.email ?? '').toLowerCase().trim();
  const displayName = String(b.displayName ?? '').trim();
  const role = await findRoleBySlug(String(b.roleSlug ?? 'viewer'));
  if (!email || !displayName || !role) return c.redirect('/admin/users?ok=Invalid+input', 302);
  const dup = await queryOne<{ id: number }>('SELECT `id` FROM `users` WHERE `email`=?', [email]);
  if (dup) return c.redirect('/admin/users?ok=Email+already+used', 302);
  const tok = Array.from(crypto.getRandomValues(new Uint8Array(32)), (x) => x.toString(16).padStart(2, '0')).join('');
  const ph = await hashPassword(tok); // unusable until invite accepted
  await execute(
    `INSERT INTO \`users\` (\`email\`,\`passwordHash\`,\`displayName\`,\`roleId\`,\`status\`,\`inviteToken\`,\`inviteExpiresAt\`)
     VALUES (?,?,?,?,'invited',?, (NOW() + INTERVAL 7 DAY))`,
    [email, ph, displayName, role.id, tok],
  );
  const { enqueue } = await import('../jobs/queue.js');
  await enqueue('sendEmail', {
    templateSlug: 'userInvite',
    to: email,
    variables: { siteName: 'Skelpo CMS', inviteUrl: `/admin/accept-invite?token=${tok}` },
  });
  return c.redirect('/admin/users?ok=Invite+sent', 302);
});

adminScreens.post('/users/:id/toggle', async (c) => {
  const auth = gate(c);
  if (auth instanceof Response) return auth;
  if (!need(c, auth, 'manageUsers')) return c.redirect('/admin/users?ok=Forbidden', 302);
  const id = Number(c.req.param('id'));
  if (id === auth.user.id) return c.redirect('/admin/users?ok=Cannot+change+self', 302);
  const u = await queryOne<{ status: string }>('SELECT `status` FROM `users` WHERE `id`=?', [id]);
  if (!u) return c.redirect('/admin/users?ok=Not+found', 302);
  const next = u.status === 'suspended' ? 'active' : 'suspended';
  await execute('UPDATE `users` SET `status`=? WHERE `id`=?', [next, id]);
  if (next === 'suspended') await execute('DELETE FROM `sessions` WHERE `userId`=?', [id]);
  return c.redirect('/admin/users?ok=Updated', 302);
});

// ── Redirects ──────────────────────────────────────────────────────────

adminScreens.get('/redirects', async (c) => {
  const auth = gate(c);
  if (auth instanceof Response) return auth;
  const rows = await query<{ id: number; source: string; destination: string; statusCode: number; hitCount: number }>(
    'SELECT `id`,`source`,`destination`,`statusCode`,`hitCount` FROM `redirects` ORDER BY `id` DESC',
  );
  return c.html(
    <AdminPage title="Redirects" active="redirects" user={auth.user}>
      <div class="top">
        <h1>Redirects</h1>
      </div>
      <div class="card">
        <form method="post" action="/admin/redirects" class="row" style="gap:8px;align-items:end;flex-wrap:wrap">
          <div style="flex:1;min-width:160px">
            <label>Source</label>
            <input type="text" name="source" placeholder="/old-url" required />
          </div>
          <div style="flex:1;min-width:160px">
            <label>Destination</label>
            <input type="text" name="destination" placeholder="/new-url" required />
          </div>
          <div style="width:110px">
            <label>Code</label>
            <select name="statusCode">
              <option>301</option>
              <option>302</option>
              <option>307</option>
              <option>308</option>
            </select>
          </div>
          <button class="btn" type="submit">
            Add
          </button>
        </form>
      </div>
      <div class="card" style="margin-top:16px">
        <table>
          <thead>
            <tr>
              <th>Source</th>
              <th>→ Destination</th>
              <th>Code</th>
              <th>Hits</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr>
                <td>{r.source}</td>
                <td class="muted">{r.destination}</td>
                <td>{r.statusCode}</td>
                <td class="muted">{r.hitCount}</td>
                <td>
                  <form method="post" action={`/admin/redirects/${r.id}/delete`} style="margin:0">
                    <button class="btn sec sm" type="submit">
                      Delete
                    </button>
                  </form>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </AdminPage>,
  );
});

adminScreens.post('/redirects', async (c) => {
  const auth = gate(c);
  if (auth instanceof Response) return auth;
  if (!need(c, auth, 'manageRedirects')) return c.redirect('/admin/redirects', 302);
  const b = await c.req.parseBody();
  const source = String(b.source ?? '').trim();
  const destination = String(b.destination ?? '').trim();
  const statusCode = Number(b.statusCode ?? 301);
  if (source && destination) {
    await execute(
      'INSERT INTO `redirects` (`source`,`destination`,`statusCode`) VALUES (?,?,?) ' +
        'ON DUPLICATE KEY UPDATE `destination`=VALUES(`destination`),`statusCode`=VALUES(`statusCode`)',
      [source, destination, statusCode],
    );
    invalidate(['redirects', 'GET:/redirects'], { prefix: true });
  }
  return c.redirect('/admin/redirects', 302);
});

adminScreens.post('/redirects/:id/delete', async (c) => {
  const auth = gate(c);
  if (auth instanceof Response) return auth;
  if (!need(c, auth, 'manageRedirects')) return c.redirect('/admin/redirects', 302);
  await execute('DELETE FROM `redirects` WHERE `id`=?', [Number(c.req.param('id'))]);
  invalidate(['redirects', 'GET:/redirects'], { prefix: true });
  return c.redirect('/admin/redirects', 302);
});

// ── Menus ──────────────────────────────────────────────────────────────

adminScreens.get('/menus', async (c) => {
  const auth = gate(c);
  if (auth instanceof Response) return auth;
  const menus = await listMenus();
  const sel = c.req.query('m') ?? menus[0]?.slug ?? 'main';
  const tree = await getMenuTree(sel, 'en', 'en');
  return c.html(
    <AdminPage title="Menus" active="menus" user={auth.user}>
      <div class="top">
        <h1>Menus</h1>
        <div class="row">
          {menus.map((m) => (
            <a class={`btn sm ${m.slug === sel ? '' : 'sec'}`} href={`/admin/menus?m=${m.slug}`}>
              {m.label}
            </a>
          ))}
        </div>
      </div>
      <div class="card">
        <h3 style="margin-top:0">{sel} items</h3>
        <table>
          <thead>
            <tr>
              <th>Label (en)</th>
              <th>URL</th>
              <th>Order</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {(tree?.items ?? []).map((i) => (
              <tr>
                <td>{i.label}</td>
                <td class="muted">{i.url ?? '(content link)'}</td>
                <td>{i.sortOrder}</td>
                <td>
                  <form method="post" action={`/admin/menus/${sel}/items/${i.id}/delete`} style="margin:0">
                    <button class="btn sec sm" type="submit">
                      Delete
                    </button>
                  </form>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div class="card" style="margin-top:16px">
        <h3 style="margin-top:0">Add item to “{sel}”</h3>
        <form method="post" action={`/admin/menus/${sel}/items`} class="row" style="gap:8px;align-items:end;flex-wrap:wrap">
          <div style="flex:1;min-width:140px">
            <label>Label (en)</label>
            <input type="text" name="label" required />
          </div>
          <div style="flex:1;min-width:140px">
            <label>URL</label>
            <input type="text" name="url" placeholder="/about" required />
          </div>
          <div style="width:90px">
            <label>Order</label>
            <input type="number" name="sortOrder" value="0" />
          </div>
          <button class="btn" type="submit">
            Add
          </button>
        </form>
      </div>
    </AdminPage>,
  );
});

adminScreens.post('/menus/:slug/items', async (c) => {
  const auth = gate(c);
  if (auth instanceof Response) return auth;
  if (!need(c, auth, 'manageMenus')) return c.redirect('/admin/menus', 302);
  const slug = c.req.param('slug');
  const b = await c.req.parseBody();
  const label = String(b.label ?? '').trim();
  const url = String(b.url ?? '').trim();
  if (label && url) {
    await addMenuItem(slug, { label: { en: label }, url, sortOrder: Number(b.sortOrder ?? 0) });
    invalidate([`menu:${slug}`], { prefix: true });
  }
  return c.redirect(`/admin/menus?m=${slug}`, 302);
});

adminScreens.post('/menus/:slug/items/:id/delete', async (c) => {
  const auth = gate(c);
  if (auth instanceof Response) return auth;
  if (!need(c, auth, 'manageMenus')) return c.redirect('/admin/menus', 302);
  const slug = c.req.param('slug');
  await deleteMenuItem(Number(c.req.param('id')));
  invalidate([`menu:${slug}`], { prefix: true });
  return c.redirect(`/admin/menus?m=${slug}`, 302);
});

// ── Jobs (read-only + retry) ───────────────────────────────────────────

adminScreens.get('/jobs', async (c) => {
  const auth = gate(c);
  if (auth instanceof Response) return auth;
  const stats = await jobStats();
  const recent = await query<{ id: number; kind: string; status: string; attempts: number; lastError: string | null; createdAt: unknown }>(
    'SELECT `id`,`kind`,`status`,`attempts`,`lastError`,`createdAt` FROM `jobs` ORDER BY `id` DESC LIMIT 30',
  );
  return c.html(
    <AdminPage title="Jobs" active="jobs" user={auth.user}>
      <div class="top">
        <h1>Jobs</h1>
        <span class="muted">
          {Object.entries(stats).map(([k, v]) => `${k}: ${v}`).join('  ·  ') || 'idle'}
        </span>
      </div>
      <div class="card">
        <table>
          <thead>
            <tr>
              <th>#</th>
              <th>Kind</th>
              <th>Status</th>
              <th>Attempts</th>
              <th>Error</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {normalizeDates(recent).map((j) => (
              <tr>
                <td>{j.id}</td>
                <td>{j.kind}</td>
                <td>{j.status}</td>
                <td>{j.attempts}</td>
                <td class="muted" style="max-width:280px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">
                  {j.lastError ?? ''}
                </td>
                <td>
                  {j.status === 'failed' || j.status === 'dead' ? (
                    <form method="post" action={`/admin/jobs/${j.id}/retry`} style="margin:0">
                      <button class="btn sec sm" type="submit">
                        Retry
                      </button>
                    </form>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </AdminPage>,
  );
});

adminScreens.post('/jobs/:id/retry', async (c) => {
  const auth = gate(c);
  if (auth instanceof Response) return auth;
  if (!need(c, auth, 'manageJobs')) return c.redirect('/admin/jobs', 302);
  await retryJob(Number(c.req.param('id')));
  return c.redirect('/admin/jobs', 302);
});

// ── Webhooks ───────────────────────────────────────────────────────────

adminScreens.get('/webhooks', async (c) => {
  const auth = gate(c);
  if (auth instanceof Response) return auth;
  const hooks = await listWebhooks();
  const flash = c.req.query('ok');
  return c.html(
    <AdminPage title="Webhooks" active="webhooks" user={auth.user}>
      <div class="top">
        <h1>Webhooks</h1>
      </div>
      {flash ? <div class="ok">{flash}</div> : null}
      <div class="card">
        <table>
          <thead>
            <tr>
              <th>URL</th>
              <th>Events</th>
              <th>Active</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {hooks.map((h) => (
              <tr>
                <td>{h.url}</td>
                <td class="muted">{h.events.join(', ')}</td>
                <td>{h.active ? 'yes' : 'no'}</td>
                <td>
                  <form method="post" action={`/admin/webhooks/${h.id}/delete`} style="margin:0">
                    <button class="btn sec sm" type="submit">
                      Delete
                    </button>
                  </form>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div class="card" style="margin-top:16px">
        <h3 style="margin-top:0">Add webhook</h3>
        <form method="post" action="/admin/webhooks">
          <label>URL</label>
          <input type="url" name="url" required placeholder="https://site.com/webhook/cms" />
          <label>Events (comma-separated, or *)</label>
          <input
            type="text"
            name="events"
            value="content.published,content.updated,content.unpublished,menu.updated,setting.changed"
          />
          <div style="margin-top:14px">
            <button class="btn" type="submit">
              Add webhook
            </button>
          </div>
        </form>
      </div>
    </AdminPage>,
  );
});

adminScreens.post('/webhooks', async (c) => {
  const auth = gate(c);
  if (auth instanceof Response) return auth;
  if (!need(c, auth, 'manageSettings')) return c.redirect('/admin/webhooks?ok=Forbidden', 302);
  const b = await c.req.parseBody();
  const url = String(b.url ?? '').trim();
  const events = String(b.events ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (url && events.length) {
    const { secret } = await createWebhook({ url, events });
    return c.redirect('/admin/webhooks?ok=' + encodeURIComponent(`Created. Secret (save it): ${secret}`), 302);
  }
  return c.redirect('/admin/webhooks?ok=Invalid+input', 302);
});

adminScreens.post('/webhooks/:id/delete', async (c) => {
  const auth = gate(c);
  if (auth instanceof Response) return auth;
  if (!need(c, auth, 'manageSettings')) return c.redirect('/admin/webhooks', 302);
  await deleteWebhook(Number(c.req.param('id')));
  return c.redirect('/admin/webhooks?ok=Deleted', 302);
});
