// Admin UI shell. Server-rendered Hono JSX + HTMX. One uniform look —
// customers never theme the admin (that's the whole point: editors get a
// consistent experience across every Skelpo site).
//
// HTMX is vendored at /admin/static/htmx.min.js (see admin/static.ts) so
// the binary has zero runtime CDN dependency.

import type { FC, PropsWithChildren } from 'hono/jsx';
import { listTypes } from '../content/types.js';
import type { RoleCapabilities } from '../auth/users.js';
import { can, type Action } from '../permissions/check.js';

// Caps-aware sidebar items. Each entry knows what permission it needs;
// the renderer drops items the current user can't action on.
function visibleTypes(allCaps: RoleCapabilities, types: { slug: string; labelPlural: string }[]): { slug: string; label: string }[] {
  return types
    .filter((t) => !['page', 'post', 'doc', 'form', 'errorPage'].includes(t.slug))
    .filter((t) => can({ userId: 0, caps: allCaps }, 'read', t.slug))
    .map((t) => ({ slug: t.slug, label: t.labelPlural }));
}

function has(caps: RoleCapabilities, action: Action, typeSlug?: string): boolean {
  return can({ userId: 0, caps }, action, typeSlug);
}

const CSS = `
/* Dark (default) */
:root{--bg:#0b0c0f;--panel:#15171c;--panel2:#1c1f26;--line:#2a2e38;
--ink:#e7e9ee;--mut:#9aa0ad;--acc:#f59e0b;--acc2:#fbbf24;--ok:#34d399;--err:#f87171}
/* Light */
:root[data-theme="light"]{
--bg:#fafafa;--panel:#ffffff;--panel2:#f3f4f6;--line:#e5e7eb;
--ink:#1f2937;--mut:#6b7280;--acc:#f59e0b;--acc2:#d97706;--ok:#059669;--err:#dc2626}
*{box-sizing:border-box}html,body{margin:0;padding:0}
body{background:var(--bg);color:var(--ink);font:14px/1.55 ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto;transition:background-color .15s,color .15s}
a{color:var(--acc2);text-decoration:none}a:hover{text-decoration:underline}
.app{display:grid;grid-template-columns:230px 1fr;min-height:100vh}
.side{background:var(--panel);border-right:1px solid var(--line);padding:18px 14px;display:flex;flex-direction:column;gap:4px}
.brand{font-weight:700;font-size:16px;color:var(--ink);padding:6px 10px 16px;letter-spacing:.2px}
.brand b{color:var(--acc)}
.nav a{display:block;padding:8px 10px;border-radius:7px;color:var(--mut);font-weight:500}
.nav a:hover{background:var(--panel2);color:var(--ink);text-decoration:none}
.nav a.on{background:var(--panel2);color:var(--acc2)}
.nav .sec{font-size:11px;text-transform:uppercase;letter-spacing:.08em;color:#5b616e;padding:14px 10px 4px}
.main{padding:26px 32px;overflow:auto}
.top{display:flex;align-items:center;justify-content:space-between;margin-bottom:22px}
.top h1{font-size:20px;margin:0}
.muted{color:var(--mut)}
.card{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:18px}
.grid{display:grid;gap:14px}
.g4{grid-template-columns:repeat(4,1fr)}.g3{grid-template-columns:repeat(3,1fr)}.g2{grid-template-columns:repeat(2,1fr)}
.stat{font-size:30px;font-weight:700;color:var(--acc2)}
.stat-l{font-size:12px;color:var(--mut);text-transform:uppercase;letter-spacing:.06em;margin-top:4px}
table{width:100%;border-collapse:collapse;font-size:13px}
th,td{text-align:left;padding:9px 12px;border-bottom:1px solid var(--line)}
th{color:var(--mut);font-weight:600;font-size:11px;text-transform:uppercase;letter-spacing:.05em}
tr:hover td{background:var(--panel2)}
.btn{display:inline-block;background:var(--acc);color:#1a1205;font-weight:600;border:0;border-radius:7px;padding:8px 14px;cursor:pointer;font-size:13px}
.btn:hover{background:var(--acc2);text-decoration:none}
.btn.sec{background:var(--panel2);color:var(--ink);border:1px solid var(--line)}
.btn.sm{padding:5px 10px;font-size:12px}
.badge{display:inline-block;padding:2px 8px;border-radius:999px;font-size:11px;font-weight:600}
.b-pub{background:rgba(52,211,153,.15);color:var(--ok)}
.b-draft{background:rgba(154,160,173,.15);color:var(--mut)}
.b-rev{background:rgba(245,158,11,.15);color:var(--acc2)}
.b-arch{background:rgba(248,113,113,.12);color:var(--err)}
input,textarea,select{width:100%;background:var(--panel2);border:1px solid var(--line);color:var(--ink);
border-radius:7px;padding:9px 11px;font:inherit}
input:focus,textarea:focus,select:focus{outline:0;border-color:var(--acc)}
label{display:block;font-size:12px;color:var(--mut);margin:14px 0 5px;font-weight:600}
.row{display:flex;gap:10px;align-items:center}
.err{background:rgba(248,113,113,.12);border:1px solid rgba(248,113,113,.4);color:var(--err);
padding:10px 12px;border-radius:7px;margin:10px 0;font-size:13px}
.ok{background:rgba(52,211,153,.1);border:1px solid rgba(52,211,153,.35);color:var(--ok);
padding:10px 12px;border-radius:7px;margin:10px 0;font-size:13px}
.login{max-width:360px;margin:12vh auto}
.login .card{padding:26px}
.htmx-indicator{opacity:0;transition:opacity .15s}.htmx-request .htmx-indicator{opacity:1}
`;

export const AdminPage: FC<
  PropsWithChildren<{
    title: string;
    active?: string;
    user?: { displayName: string; roleSlug?: string } | null;
    /** Role capabilities — drives sidebar gating. Falls back to no-access. */
    caps?: RoleCapabilities;
  }>
> = async ({ title, active, user, caps, children }) => {
  // Treat missing caps as "no access" so the sidebar stays empty rather
  // than leaking everything. Authed pages should always pass caps.
  const c = caps ?? { global: [], types: {} };
  const allTypes = user ? await listTypes().catch(() => []) : [];
  const customTypes = visibleTypes(c, allTypes);
  // Built-in editorial types only show if the user can read them.
  const showPages = user && has(c, 'read', 'page');
  const showPosts = user && has(c, 'read', 'post');
  const showDocs  = user && has(c, 'read', 'doc');

  // Developer-only areas
  const canManageTypes     = user && has(c, 'manageTypes');
  const canManageMenus     = user && has(c, 'manageMenus');
  const canManageRedirects = user && has(c, 'manageRedirects');
  const canManageSettings  = user && has(c, 'manageSettings');
  const canManageUsers     = user && has(c, 'manageUsers');
  const canManageJobs      = user && has(c, 'manageJobs');
  const canManageForms     = user && has(c, 'manageForms');
  // Webhooks gated under manageSettings today; promote to its own cap later.
  const canManageWebhooks  = canManageSettings;

  // Editorial-only areas
  const canViewMedia        = user && (has(c, 'manageMedia') || has(c, 'read', 'page')); // media library is editorial
  const canViewSubmissions  = user && (has(c, 'viewSubmissions') || has(c, 'manageForms'));

  // Has any developer link to show?
  const hasDeveloperArea = canManageTypes || canManageForms || canManageRedirects ||
    canManageSettings || canManageUsers || canManageJobs || canManageWebhooks;
  return (
  <html lang="en">
    <head>
      <meta charset="utf-8" />
      <meta name="viewport" content="width=device-width,initial-scale=1" />
      <meta name="robots" content="noindex,nofollow" />
      <title>{title} · Skelpo CMS</title>
      <style dangerouslySetInnerHTML={{ __html: CSS }} />
      {/* Apply saved theme before paint to avoid flash-of-wrong-theme. */}
      <script dangerouslySetInnerHTML={{ __html: `
        try{var t=localStorage.getItem('skelpo-theme');
        if(t==='light')document.documentElement.setAttribute('data-theme','light');}catch(e){}
      ` }} />
      {/* Set the toggle icon to match the active theme after DOM loads. */}
      <script dangerouslySetInnerHTML={{ __html: `
        document.addEventListener('DOMContentLoaded',function(){
          var icon=document.getElementById('skelpo-theme-icon');
          if(icon)icon.textContent=document.documentElement.getAttribute('data-theme')==='light'?'☾':'☀';
        });
      ` }} />
      <script src="/admin/static/htmx.min.js" defer></script>
    </head>
    <body>
      {user ? (
        <div class="app">
          <aside class="side">
            <div class="brand">
              Skelpo<b>CMS</b>
            </div>
            <nav class="nav">
              <a href="/admin" class={active === 'dashboard' ? 'on' : ''}>Dashboard</a>

              {/* ── Editorial ─────────────────────────────────── */}
              <div class="sec">Editorial</div>
              {showPages ? <a href="/admin/content/page" class={active === 'page' ? 'on' : ''}>Pages</a> : null}
              {showPosts ? <a href="/admin/content/post" class={active === 'post' ? 'on' : ''}>Posts</a> : null}
              {showDocs  ? <a href="/admin/content/doc"  class={active === 'doc'  ? 'on' : ''}>Docs</a>  : null}
              {customTypes.map((t) => (
                <a href={`/admin/content/${t.slug}`} class={active === t.slug ? 'on' : ''}>{t.label}</a>
              ))}
              {canViewMedia ? <a href="/admin/media" class={active === 'media' ? 'on' : ''}>Media</a> : null}
              {canManageMenus ? <a href="/admin/menus" class={active === 'menus' ? 'on' : ''}>Menus</a> : null}
              {canViewSubmissions ? <a href="/admin/forms" class={active === 'forms' ? 'on' : ''}>Form submissions</a> : null}

              {/* ── Developer / admin ─────────────────────────── */}
              {hasDeveloperArea ? <div class="sec">Developer</div> : null}
              {canManageTypes     ? <a href="/admin/types"     class={active === 'types'     ? 'on' : ''}>Content Types</a> : null}
              {canManageForms     ? <a href="/admin/forms"     class={active === 'forms-admin' ? 'on' : ''}>Forms (admin)</a> : null}
              {canManageRedirects ? <a href="/admin/redirects" class={active === 'redirects' ? 'on' : ''}>Redirects</a> : null}
              {canManageWebhooks  ? <a href="/admin/webhooks"  class={active === 'webhooks'  ? 'on' : ''}>Webhooks</a> : null}
              {canManageJobs      ? <a href="/admin/jobs"      class={active === 'jobs'      ? 'on' : ''}>Jobs</a> : null}
              {canManageSettings  ? <a href="/admin/settings"  class={active === 'settings'  ? 'on' : ''}>Settings</a> : null}
              {canManageUsers     ? <a href="/admin/users"     class={active === 'users'     ? 'on' : ''}>Users</a> : null}
            </nav>
            <div style="margin-top:auto;padding:14px 10px 0;border-top:1px solid var(--line)">
              <div class="muted" style="font-size:12px;display:flex;align-items:center;gap:6px;flex-wrap:wrap">
                <span>{user.displayName}</span>
                {(user as { roleSlug?: string }).roleSlug ? (
                  <span style="background:var(--panel2);color:var(--acc2);font-size:10px;text-transform:uppercase;letter-spacing:0.05em;padding:1px 6px;border-radius:4px;font-weight:600">
                    {(user as { roleSlug?: string }).roleSlug}
                  </span>
                ) : null}
              </div>
              <div style="display:flex;align-items:center;gap:10px;margin-top:6px">
                <a href="/admin/logout" style="font-size:12px">
                  Sign out
                </a>
                <button
                  type="button"
                  id="skelpo-theme-toggle"
                  title="Toggle light / dark"
                  style="margin-left:auto;background:transparent;border:1px solid var(--line);color:var(--mut);border-radius:6px;padding:4px 8px;cursor:pointer;font-size:12px;line-height:1"
                  onclick="(()=>{var d=document.documentElement;var next=d.getAttribute('data-theme')==='light'?'dark':'light';if(next==='light')d.setAttribute('data-theme','light');else d.removeAttribute('data-theme');try{localStorage.setItem('skelpo-theme',next)}catch(e){}document.getElementById('skelpo-theme-icon').textContent=next==='light'?'☾':'☀';})()"
                >
                  <span id="skelpo-theme-icon">{/* sun for dark (current), moon for light */}☀</span>
                </button>
              </div>
            </div>
          </aside>
          <main class="main">{children}</main>
        </div>
      ) : (
        <div class="login">{children}</div>
      )}
    </body>
  </html>
  );
};

export const StatusBadge: FC<{ status: string }> = ({ status }) => {
  const map: Record<string, string> = {
    published: 'b-pub',
    draft: 'b-draft',
    review: 'b-rev',
    archived: 'b-arch',
  };
  return <span class={`badge ${map[status] ?? 'b-draft'}`}>{status}</span>;
};
