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
import { makeT, type Translator } from './i18n/index.js';
import { adminLocales, adminLocaleNames, defaultAdminLocale } from './i18n/locales.js';
import { getSetting } from '../settings/store.js';

// Caps-aware sidebar items. Each entry knows what permission it needs;
// the renderer drops items the current user can't action on.
/** Types that never appear in the Content section (they have their own screens). */
const INTERNAL_TYPES = ['form', 'errorPage'];
const BUILTIN_NAV_KEYS: Record<string, string> = { page: 'nav.pages', post: 'nav.posts', doc: 'nav.docs' };

function visibleTypes(
  allCaps: RoleCapabilities,
  types: { slug: string; labelPlural: string }[],
  hidden: string[],
  tr: Translator,
): { slug: string; label: string }[] {
  return types
    .filter((t) => !INTERNAL_TYPES.includes(t.slug) && !hidden.includes(t.slug))
    .filter((t) => can({ userId: 0, caps: allCaps }, 'read', t.slug))
    .map((t) => ({ slug: t.slug, label: BUILTIN_NAV_KEYS[t.slug] ? tr(BUILTIN_NAV_KEYS[t.slug]!) : t.labelPlural }));
}

/** Content types hidden from the sidebar/dashboard (setting `admin.hiddenTypes`). */
export async function getHiddenTypes(): Promise<string[]> {
  const v = await getSetting<unknown>('admin.hiddenTypes', []).catch(() => []);
  return Array.isArray(v) ? v.map(String) : [];
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
.nav .sec{font-size:11px;text-transform:uppercase;letter-spacing:.08em;color:var(--mut);padding:14px 10px 4px}
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
.btn.dis{opacity:.4;pointer-events:none}
.btn.danger{background:transparent;color:var(--err);border:1px solid var(--line)}
.btn.danger:hover{background:rgba(248,113,113,.12)}
.linkbtn{background:none;border:0;padding:0;color:var(--acc2);cursor:pointer;font:inherit}
.linkbtn:hover{text-decoration:underline}
.linkbtn.danger{color:var(--err)}
.help{font-size:12px;color:var(--mut);margin-top:5px;line-height:1.45}
.counter{float:right;font-weight:400;font-variant-numeric:tabular-nums}
.counter.bad{color:var(--err)}.counter.good{color:var(--ok)}
.pager{display:flex;align-items:center;gap:10px;justify-content:flex-end;margin-top:14px;font-size:12px}
.tabs{display:flex;gap:2px;flex-wrap:wrap;border-bottom:1px solid var(--line);margin-bottom:18px}
.tabs a{padding:9px 14px;color:var(--mut);font-weight:600;font-size:13px;border-bottom:2px solid transparent;margin-bottom:-1px}
.tabs a:hover{color:var(--ink);text-decoration:none}
.tabs a.on{color:var(--acc2);border-bottom-color:var(--acc2)}
.subtabs{display:flex;gap:14px;flex-wrap:wrap;font-size:13px;margin-bottom:12px}
.subtabs a{color:var(--mut)}.subtabs a.on{color:var(--ink);font-weight:600}
.rowact{font-size:12px;margin-top:3px;display:flex;gap:10px;flex-wrap:wrap;opacity:.75}
tr:hover .rowact{opacity:1}
.rowact form{display:inline;margin:0}
.toolbar{display:flex;gap:10px;align-items:center;flex-wrap:wrap}
.toolbar input,.toolbar select{width:auto}
.editor-grid{display:grid;gap:14px;grid-template-columns:minmax(0,2fr) minmax(260px,1fr);align-items:start}
.stack{display:flex;flex-direction:column;gap:14px}
.card h3{margin:0 0 4px;font-size:14px}
.kv{display:grid;grid-template-columns:auto 1fr;gap:4px 14px;font-size:13px}
.kv dt{color:var(--mut)}.kv dd{margin:0;word-break:break-word}
.check{display:flex;align-items:center;gap:8px;font-weight:400;margin:6px 0;color:var(--ink);cursor:pointer;font-size:13px}
.check input,td input[type=checkbox],th input[type=checkbox]{width:auto}
.secret{display:block;background:var(--panel2);border:1px solid var(--line);border-radius:7px;padding:10px 12px;font:12px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;word-break:break-all;margin:8px 0}
.sitelink{font-size:12px;padding:0 10px 12px;display:block}
.nav details summary{font-size:11px;text-transform:uppercase;letter-spacing:.08em;color:var(--mut);padding:14px 10px 4px;cursor:pointer;list-style:none}
.nav details summary::-webkit-details-marker{display:none}
.nav details summary::after{content:' ▸'}.nav details[open] summary::after{content:' ▾'}
.topbar{display:none}
@media (max-width:860px){
.app{grid-template-columns:1fr}
.side{display:none;position:fixed;inset:0 20% 0 0;z-index:30;overflow:auto;box-shadow:0 0 0 100vmax rgba(0,0,0,.5)}
body.nav-open .side{display:flex}
.topbar{display:flex;align-items:center;gap:12px;padding:10px 16px;background:var(--panel);border-bottom:1px solid var(--line);position:sticky;top:0;z-index:20}
.topbar button{background:var(--panel2);border:1px solid var(--line);color:var(--ink);border-radius:6px;padding:5px 10px;font-size:16px;cursor:pointer}
.main{padding:18px 14px}
.g4,.g3,.g2,.editor-grid{grid-template-columns:1fr}
.top{flex-wrap:wrap;gap:10px}
.card{overflow-x:auto}
}
`;


// Page-wide behaviour, inlined so every admin page gets it without a round-trip:
//  • <time data-dt> is rewritten to the viewer's local time,
//  • [data-confirm] asks before a destructive click,
//  • [data-copy] copies its value to the clipboard,
//  • form[data-guard] warns before leaving with unsaved changes.
const SHELL_SCRIPT = `
document.addEventListener('DOMContentLoaded',function(){
  var icon=document.getElementById('skelpo-theme-icon');
  if(icon)icon.textContent=document.documentElement.getAttribute('data-theme')==='light'?'☾':'☀';
  var lang=document.documentElement.lang||undefined;
  document.querySelectorAll('time[data-dt]').forEach(function(el){
    var d=new Date(el.getAttribute('datetime'));if(isNaN(d))return;
    try{
      el.title=el.textContent;
      el.textContent=el.getAttribute('data-dt')==='date'
        ?d.toLocaleDateString(lang,{year:'numeric',month:'short',day:'numeric'})
        :d.toLocaleString(lang,{year:'numeric',month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'});
    }catch(e){}
  });
  document.querySelectorAll('option[data-month]').forEach(function(el){
    var p=el.getAttribute('data-month').split('-');var d=new Date(Number(p[0]),Number(p[1])-1,1);
    try{el.textContent=d.toLocaleDateString(lang,{year:'numeric',month:'long'});}catch(e){}
  });
  var dirty=false;
  document.querySelectorAll('form[data-guard]').forEach(function(f){
    f.addEventListener('input',function(){dirty=true;});
    f.addEventListener('change',function(){dirty=true;});
    f.addEventListener('submit',function(){dirty=false;});
  });
  window.skelpoMarkDirty=function(){dirty=true;};
  window.addEventListener('beforeunload',function(e){if(dirty){e.preventDefault();e.returnValue='';}});
});
document.addEventListener('click',function(e){
  var t=e.target&&e.target.closest?e.target:null;if(!t)return;
  var c=t.closest('[data-confirm]');
  if(c&&!confirm(c.getAttribute('data-confirm'))){e.preventDefault();e.stopPropagation();return;}
  var cp=t.closest('[data-copy]');
  if(cp){e.preventDefault();var v=cp.getAttribute('data-copy');
    (navigator.clipboard?navigator.clipboard.writeText(v):Promise.reject()).then(function(){
      var o=cp.textContent;cp.textContent=cp.getAttribute('data-copied')||'✓';setTimeout(function(){cp.textContent=o;},1500);
    }).catch(function(){prompt('',v);});}
},true);
`;

export const AdminPage: FC<
  PropsWithChildren<{
    title: string;
    active?: string;
    user?: { displayName: string; roleSlug?: string } | null;
    /** Role capabilities — drives sidebar gating. Falls back to no-access. */
    caps?: RoleCapabilities;
    /** Request translator. Falls back to English when omitted (e.g. stubs). */
    t?: Translator;
  }>
> = async ({ title, active, user, caps, t, children }) => {
  // Treat missing caps as "no access" so the sidebar stays empty rather
  // than leaking everything. Authed pages should always pass caps.
  const c = caps ?? { global: [], types: {} };
  // Translator: always have one so chrome renders even on stub pages.
  const tr = t ?? makeT(defaultAdminLocale);
  const allTypes = user ? await listTypes().catch(() => []) : [];
  const hiddenTypes = user ? await getHiddenTypes() : [];
  const contentTypes = visibleTypes(c, allTypes, hiddenTypes, tr);
  const siteNameRaw = await getSetting<unknown>('site.name', '').catch(() => '');
  const siteName = typeof siteNameRaw === 'string' && siteNameRaw.trim() ? siteNameRaw.trim() : 'Skelpo CMS';
  const siteUrlRaw = await getSetting<unknown>('site.url', '').catch(() => '');
  const siteUrl = typeof siteUrlRaw === 'string' && /^https?:\/\//.test(siteUrlRaw) ? siteUrlRaw : '';

  const canManageTypes     = user && has(c, 'manageTypes');
  const canManageMenus     = user && has(c, 'manageMenus');
  const canManageRedirects = user && has(c, 'manageRedirects');
  const canManageSettings  = user && has(c, 'manageSettings');
  const canManageUsers     = user && has(c, 'manageUsers');
  const canManageJobs      = user && has(c, 'manageJobs');
  // Webhooks gated under manageSettings today; promote to its own cap later.
  const canManageWebhooks  = canManageSettings;
  const canViewMedia       = user && (has(c, 'manageMedia') || contentTypes.length > 0);
  const canViewForms       = user && (has(c, 'viewSubmissions') || has(c, 'manageForms'));

  const hasSiteArea = canManageMenus || canViewForms || canManageRedirects;
  const hasAdminArea = canManageUsers || canManageSettings;
  const hasDeveloperArea = canManageTypes || canManageWebhooks || canManageJobs;
  const developerOpen = ['types', 'webhooks', 'jobs'].includes(active ?? '');
  return (
  <html lang={tr.locale}>
    <head>
      <meta charset="utf-8" />
      <meta name="viewport" content="width=device-width,initial-scale=1" />
      <meta name="robots" content="noindex,nofollow" />
      <title>{title} · {siteName}</title>
      <style dangerouslySetInnerHTML={{ __html: CSS }} />
      {/* Apply saved theme before paint to avoid flash-of-wrong-theme. */}
      <script dangerouslySetInnerHTML={{ __html: `
        try{var t=localStorage.getItem('skelpo-theme');
        if(t==='light')document.documentElement.setAttribute('data-theme','light');}catch(e){}
      ` }} />
      <script dangerouslySetInnerHTML={{ __html: SHELL_SCRIPT }} />
      <script src="/admin/static/htmx.min.js" defer></script>
    </head>
    <body>
      {user ? (
        <div class="app">
          <div class="topbar">
            <button type="button" aria-label={tr('nav.menu')} onclick="document.body.classList.toggle('nav-open')">☰</button>
            <strong>{siteName}</strong>
          </div>
          <aside class="side" onclick="if(event.target.closest('a'))document.body.classList.remove('nav-open')">
            <div class="brand" style="padding-bottom:4px">{siteName}</div>
            {siteUrl
              ? <a class="sitelink" href={siteUrl} target="_blank" rel="noopener">{tr('nav.visitSite')} ↗</a>
              : <span class="sitelink muted">Skelpo CMS</span>}
            <nav class="nav">
              <a href="/admin" class={active === 'dashboard' ? 'on' : ''}>{tr('nav.dashboard')}</a>

              {contentTypes.length > 0 || canViewMedia ? <div class="sec">{tr('nav.content')}</div> : null}
              {contentTypes.map((ct) => (
                <a href={`/admin/content/${ct.slug}`} class={active === ct.slug ? 'on' : ''}>{ct.label}</a>
              ))}
              {canViewMedia ? <a href="/admin/media" class={active === 'media' ? 'on' : ''}>{tr('nav.media')}</a> : null}

              {hasSiteArea ? <div class="sec">{tr('nav.site')}</div> : null}
              {canManageMenus ? <a href="/admin/menus" class={active === 'menus' ? 'on' : ''}>{tr('nav.menus')}</a> : null}
              {canViewForms ? <a href="/admin/forms" class={active === 'forms' ? 'on' : ''}>{tr('nav.forms')}</a> : null}
              {canManageRedirects ? <a href="/admin/redirects" class={active === 'redirects' ? 'on' : ''}>{tr('nav.redirects')}</a> : null}

              {hasAdminArea ? <div class="sec">{tr('nav.administration')}</div> : null}
              {canManageUsers ? <a href="/admin/users" class={active === 'users' ? 'on' : ''}>{tr('nav.users')}</a> : null}
              {canManageSettings ? <a href="/admin/settings" class={active === 'settings' ? 'on' : ''}>{tr('nav.settings')}</a> : null}

              {hasDeveloperArea ? (
                <details open={developerOpen}>
                  <summary>{tr('nav.developer')}</summary>
                  {canManageTypes    ? <a href="/admin/types"    class={active === 'types'    ? 'on' : ''}>{tr('nav.contentTypes')}</a> : null}
                  {canManageWebhooks ? <a href="/admin/webhooks" class={active === 'webhooks' ? 'on' : ''}>{tr('nav.webhooks')}</a> : null}
                  {canManageJobs     ? <a href="/admin/jobs"     class={active === 'jobs'     ? 'on' : ''}>{tr('nav.jobs')}</a> : null}
                </details>
              ) : null}
            </nav>
            <div style="margin-top:auto;padding:14px 10px 0;border-top:1px solid var(--line)">
              <a href="/admin/profile" class={active === 'profile' ? 'on' : ''} style="font-size:13px;font-weight:600;color:var(--ink);display:block">
                {user.displayName}
              </a>
              {/* Language switcher — saves to the user's locale + cookie and
                  reloads the current page in the chosen language. */}
              <form method="post" action="/admin/profile/language" style="margin:8px 0 0">
                <input type="hidden" name="return" id="skelpo-lang-return" />
                <select
                  id="skelpo-lang-select"
                  name="locale"
                  aria-label={tr('nav.language')}
                  style="font-size:12px;padding:5px 8px"
                  onchange="document.getElementById('skelpo-lang-return').value=location.pathname+location.search;this.form.submit()"
                >
                  {adminLocales.map((l) => (
                    <option value={l} selected={l === tr.locale}>{adminLocaleNames[l]}</option>
                  ))}
                </select>
              </form>
              <div style="display:flex;align-items:center;gap:10px;margin-top:8px">
                <a href="/admin/profile" style="font-size:12px">{tr('nav.profile')}</a>
                <a href="/admin/logout" style="font-size:12px">
                  {tr('nav.signOut')}
                </a>
                <button
                  type="button"
                  id="skelpo-theme-toggle"
                  title={tr('nav.themeToggle')}
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

export const StatusBadge: FC<{ status: string; t?: Translator }> = ({ status, t }) => {
  const map: Record<string, string> = {
    published: 'b-pub',
    draft: 'b-draft',
    review: 'b-rev',
    archived: 'b-arch',
    scheduled: 'b-rev',
  };
  // Translate known statuses; unknown values render verbatim.
  const label = t && ['published', 'draft', 'review', 'archived', 'scheduled'].includes(status)
    ? t(`status.${status}`)
    : status;
  return <span class={`badge ${map[status] ?? 'b-draft'}`}>{label}</span>;
};
