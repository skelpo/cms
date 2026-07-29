// Secondary admin screens: settings, users, redirects, menus, jobs,
// webhooks. Server-rendered; forms POST to handlers that call the
// store/writer functions directly (already inside an authed session).

import { Hono } from 'hono';
import type { Context } from 'hono';
import type { FC } from 'hono/jsx';
import { AdminPage, StatusBadge } from './layout.js';
import type { AuthContext } from '../auth/middleware.js';
import { can } from '../permissions/check.js';
import { getT, type Translator } from './i18n/index.js';
import { getAllSettings, setSetting, invalidateSettingsCache } from '../settings/store.js';
import { invalidate } from '../cache/deps.js';
import { fireEvent } from '../webhooks/dispatch.js';
import { execute, query, queryOne } from '../db/client.js';
import { normalizeDates } from '../db/datetime.js';
import { hashPassword } from '../auth/password.js';
import { listRoles, findRoleBySlug } from '../auth/users.js';
import { listMenus, getMenuTree, addMenuItem, deleteMenuItem } from '../menus/store.js';
import { jobStats, retryJob } from '../jobs/queue.js';
import { listWebhooks, createWebhook, deleteWebhook } from '../webhooks/dispatch.js';
import { listMedia, getMedia, storeMedia, updateMedia, deleteMedia } from '../media/store.js';

export const adminScreens = new Hono();

function gate(c: Context): AuthContext | Response {
  const auth = c.get('auth');
  if (!auth) return c.redirect('/admin/login', 302);
  return auth;
}
// Perry workaround: `instanceof Response` is always false for native fetch
// handles, so discriminate gate()'s union by a field only AuthContext carries.
// Type guard → callers still narrow to AuthContext. Identical on Node/Bun.
function notAuth(x: AuthContext | Response): x is Response {
  return (x as AuthContext).user === undefined;
}
function need(c: Context, auth: AuthContext, cap: Parameters<typeof can>[1]): boolean {
  return can({ userId: auth.user.id, caps: auth.role.capabilities }, cap);
}

// ── Settings ───────────────────────────────────────────────────────────

// ── Settings index: group by prefix (i18n, site, seo, …). No JSON dump. ──

function describeShape(v: unknown, t: Translator): string {
  if (v === null || v === undefined) return t('settings.describe.empty');
  if (Array.isArray(v)) {
    if (v.length === 0) return t('settings.describe.emptyList');
    if (v.every((x) => typeof x === 'string')) return t.plural('settings.describe.tags', v.length);
    if (v.every((x) => typeof x === 'object' && x !== null && !Array.isArray(x))) return t.plural('settings.describe.entries', v.length);
    return t.plural('settings.describe.items', v.length);
  }
  if (typeof v === 'object') {
    const leaves = countLeaves(v);
    return t.plural('settings.describe.fields', leaves);
  }
  if (typeof v === 'string') {
    const s = v as string;
    return s.length === 0 ? t('settings.describe.empty') : s.length <= 40 ? `"${s}"` : t('settings.describe.chars', { n: s.length });
  }
  return String(v);
}

function countLeaves(o: unknown): number {
  if (o === null || o === undefined) return 0;
  if (typeof o !== 'object') return 1;
  if (Array.isArray(o)) return o.reduce<number>((n, x) => n + countLeaves(x), 0);
  return Object.values(o as Record<string, unknown>).reduce<number>((n, x) => n + countLeaves(x), 0);
}

adminScreens.get('/settings', async (c) => {
  const auth = gate(c);
  if (notAuth(auth)) return auth;
  const t = getT(c);
  const all = await getAllSettings();
  const flash = c.req.query('ok');

  // Group by prefix before the first dot. Keys without a dot fall into 'general'.
  const groups = new Map<string, { key: string; value: unknown }[]>();
  for (const key of Object.keys(all).sort()) {
    const prefix = key.includes('.') ? key.slice(0, key.indexOf('.')) : 'general';
    if (!groups.has(prefix)) groups.set(prefix, []);
    groups.get(prefix)!.push({ key, value: all[key] });
  }

  return c.html(
    <AdminPage title={t('settings.title')} active="settings" t={t} user={{ ...auth.user, roleSlug: auth.role.slug }} caps={auth.role.capabilities}>
      <div class="top">
        <h1>{t('settings.title')}</h1>
        <span class="muted">{t('settings.summary', { settings: t.plural('settings.settingsCount', Object.keys(all).length), groups: t.plural('settings.groupsCount', groups.size) })}</span>
      </div>
      {flash ? <div class="ok">{decodeURIComponent(flash)}</div> : null}
      {[...groups.entries()].map(([group, items]) => (
        <div class="card" style="margin-bottom:14px">
          <h3 style="margin:0 0 12px;font-size:13px;text-transform:uppercase;letter-spacing:0.06em;color:var(--mut)">{group}</h3>
          <table>
            <tbody>
              {items.map((it) => (
                <tr>
                  <td style="width:40%">
                    <a href={`/admin/settings/${encodeURIComponent(it.key)}`}>{it.key}</a>
                  </td>
                  <td class="muted">{describeShape(it.value, t)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ))}
    </AdminPage>,
  );
});

// ── Settings: per-key edit page (shape-aware UI, no JSON) ────────────────

interface FlatLeaf { path: string; value: string; multiline: boolean }

/** Walk a nested object and yield every leaf with its dot-path. */
function flattenLeaves(o: unknown, prefix = ''): FlatLeaf[] {
  if (o === null || o === undefined) return prefix ? [{ path: prefix, value: '', multiline: false }] : [];
  if (typeof o !== 'object') {
    const s = String(o);
    return [{ path: prefix, value: s, multiline: s.includes('\n') || s.length > 80 }];
  }
  if (Array.isArray(o)) {
    return o.flatMap((v, i) => flattenLeaves(v, prefix ? `${prefix}.${i}` : String(i)));
  }
  return Object.entries(o as Record<string, unknown>).flatMap(([k, v]) =>
    flattenLeaves(v, prefix ? `${prefix}.${k}` : k),
  );
}

/** Set a dot-path on a target object, coercing array indexes from numeric segments. */
function setPath(target: Record<string, unknown>, path: string, value: unknown): void {
  const parts = path.split('.');
  let cur: Record<string, unknown> = target;
  for (let i = 0; i < parts.length - 1; i++) {
    const k = parts[i]!;
    const nextNumeric = /^\d+$/.test(parts[i + 1]!);
    if (!(k in cur) || typeof cur[k] !== 'object' || cur[k] === null) {
      cur[k] = nextNumeric ? [] : {};
    }
    cur = cur[k] as Record<string, unknown>;
  }
  cur[parts[parts.length - 1]!] = value;
}

function shapeOf(v: unknown): 'string' | 'multiline' | 'number' | 'boolean' | 'tags' | 'repeater' | 'tree' | 'empty' {
  if (v === null || v === undefined) return 'empty';
  if (typeof v === 'boolean') return 'boolean';
  if (typeof v === 'number') return 'number';
  if (typeof v === 'string') return v.length > 80 || v.includes('\n') ? 'multiline' : 'string';
  if (Array.isArray(v)) {
    if (v.length === 0) return 'tags';
    if (v.every((x) => typeof x === 'string')) return 'tags';
    if (v.every((x) => typeof x === 'object' && x !== null && !Array.isArray(x))) return 'repeater';
    return 'tree';
  }
  return 'tree';
}

adminScreens.get('/settings/:keyName', async (c) => {
  const auth = gate(c);
  if (notAuth(auth)) return auth;
  const t = getT(c);
  const keyName = decodeURIComponent(c.req.param('keyName'));
  const all = await getAllSettings();
  if (!(keyName in all)) {
    return c.html(<AdminPage title={t('common.notFound')} t={t} user={{ ...auth.user, roleSlug: auth.role.slug }} caps={auth.role.capabilities}>{t('settings.notFound', { key: keyName })}</AdminPage>, 404);
  }
  const value = all[keyName];
  const shape = shapeOf(value);
  const flash = c.req.query('ok') ? { ok: decodeURIComponent(c.req.query('ok')!) } : undefined;

  return c.html(
    <AdminPage title={keyName} active="settings" t={t} user={{ ...auth.user, roleSlug: auth.role.slug }} caps={auth.role.capabilities}>
      <div class="top">
        <h1 style="font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:18px">{keyName}</h1>
        <a class="btn sec" href="/admin/settings">{t('settings.allSettings')}</a>
      </div>
      <div class="muted" style="margin-bottom:14px;font-size:12px">{t(`settings.shape.${shape}`)}</div>
      {flash?.ok ? <div class="ok">{flash.ok}</div> : null}
      <form method="post" action={`/admin/settings/${encodeURIComponent(keyName)}`} class="card">
        <input type="hidden" name="shape" value={shape} />
        {shape === 'string' ? (
          <div><label>{t('settings.value')}</label><input type="text" name="v" value={String(value ?? '')} /></div>
        ) : null}
        {shape === 'multiline' ? (
          <div><label>{t('settings.value')}</label><textarea name="v" rows={8}>{String(value ?? '')}</textarea></div>
        ) : null}
        {shape === 'number' ? (
          <div><label>{t('settings.value')}</label><input type="number" name="v" value={String(value ?? '')} /></div>
        ) : null}
        {shape === 'boolean' ? (
          <div><label>{t('settings.value')}</label>
            <select name="v">
              <option value="false" selected={value !== true}>{t('common.no')}</option>
              <option value="true" selected={value === true}>{t('common.yes')}</option>
            </select>
          </div>
        ) : null}
        {shape === 'tags' ? (
          <div>
            <label>{t('settings.itemsOnePerLine')}</label>
            <textarea name="v" rows={Math.min(20, Math.max(3, (value as string[]).length + 1))}>
              {(value as string[]).join('\n')}
            </textarea>
            <div class="muted" style="font-size:12px;margin-top:6px">{t.plural('common.items', (value as string[]).length)}</div>
          </div>
        ) : null}
        {shape === 'repeater' ? <RepeaterEditor value={value as Record<string, unknown>[]} t={t} /> : null}
        {shape === 'tree' ? <TreeEditor value={value as Record<string, unknown>} t={t} /> : null}
        {shape === 'empty' ? <div class="muted">{t('settings.emptyDelete')} <a href={`/admin/settings/${encodeURIComponent(keyName)}/delete`}>{t('settings.deleteSetting')}</a></div> : null}
        <div style="margin-top:18px;display:flex;gap:8px">
          <button class="btn" type="submit">{t('settings.save')}</button>
          <a class="btn sec" href="/admin/settings">{t('settings.cancel')}</a>
        </div>
      </form>
    </AdminPage>,
  );
});

const RepeaterEditor: FC<{ value: Record<string, unknown>[]; t: Translator }> = ({ value, t }) => {
  if (value.length === 0) return <div class="muted">{t('settings.noEntries')}</div>;
  const fieldNames = Array.from(new Set(value.flatMap((row) => Object.keys(row))));
  return (
    <>
      <input type="hidden" name="rep_count" value={String(value.length)} />
      {value.map((row, i) => (
        <div class="card" style="background:var(--panel2);margin-bottom:10px;padding:14px">
          <div class="muted" style="font-size:11px;text-transform:uppercase;letter-spacing:0.05em;margin-bottom:8px">#{i + 1}</div>
          {fieldNames.map((field) => {
            const v = row[field];
            const isMulti = typeof v === 'string' && (v.includes('\n') || v.length > 80);
            const name = `rep_${i}_${field}`;
            return (
              <div>
                <label>{field}</label>
                {isMulti ? (
                  <textarea name={name} rows={3}>{String(v ?? '')}</textarea>
                ) : (
                  <input type="text" name={name} value={String(v ?? '')} />
                )}
              </div>
            );
          })}
        </div>
      ))}
      <div class="muted" style="font-size:12px;margin-top:4px">{t('settings.editExistingOnly')}</div>
    </>
  );
};

const TreeEditor: FC<{ value: Record<string, unknown>; t: Translator }> = ({ value, t }) => {
  const leaves = flattenLeaves(value);
  // Group by top-level segment so big i18n bundles render as collapsed cards.
  const groups = new Map<string, FlatLeaf[]>();
  for (const leaf of leaves) {
    const top = leaf.path.split('.')[0]!;
    if (!groups.has(top)) groups.set(top, []);
    groups.get(top)!.push(leaf);
  }
  return (
    <>
      <input type="hidden" name="tree_count" value={String(leaves.length)} />
      {[...groups.entries()].map(([groupName, items]) => (
        <details style="background:var(--panel2);border:1px solid var(--line);border-radius:7px;padding:12px 14px;margin-bottom:8px" open={leaves.length < 50}>
          <summary style="cursor:pointer;font-weight:600;color:var(--acc2)">
            {groupName} <span class="muted" style="font-weight:400;font-size:12px">({t.plural('common.fields', items.length)})</span>
          </summary>
          <div style="margin-top:12px">
            {items.map((leaf) => (
              <div>
                <label style="font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px">{leaf.path}</label>
                {leaf.multiline ? (
                  <textarea name={`leaf_${leaf.path}`} rows={3}>{leaf.value}</textarea>
                ) : (
                  <input type="text" name={`leaf_${leaf.path}`} value={leaf.value} />
                )}
              </div>
            ))}
          </div>
        </details>
      ))}
    </>
  );
};

adminScreens.post('/settings/:keyName', async (c) => {
  const auth = gate(c);
  if (notAuth(auth)) return auth;
  const t = getT(c);
  if (!need(c, auth, 'manageSettings')) {
    return c.redirect('/admin/settings?ok=' + encodeURIComponent(t('common.forbidden')), 302);
  }
  const keyName = decodeURIComponent(c.req.param('keyName'));
  const body = await c.req.parseBody();
  const shape = String(body.shape ?? 'string');
  let newValue: unknown;

  switch (shape) {
    case 'string':
    case 'multiline':
      newValue = String(body.v ?? '');
      break;
    case 'number':
      newValue = body.v === '' ? null : Number(body.v);
      break;
    case 'boolean':
      newValue = String(body.v) === 'true';
      break;
    case 'tags':
      newValue = String(body.v ?? '')
        .split('\n')
        .map((s) => s.trim())
        .filter(Boolean);
      break;
    case 'repeater': {
      const all = await getAllSettings();
      const original = all[keyName] as Record<string, unknown>[];
      const count = Number(body.rep_count ?? 0);
      const result: Record<string, unknown>[] = [];
      for (let i = 0; i < count; i++) {
        const orig = original[i] ?? {};
        const row: Record<string, unknown> = { ...orig };
        for (const field of Object.keys(orig)) {
          const v = body[`rep_${i}_${field}`];
          if (v !== undefined) {
            const prev = orig[field];
            // Preserve number types if the original was numeric.
            if (typeof prev === 'number') row[field] = Number(v);
            else if (typeof prev === 'boolean') row[field] = String(v) === 'true';
            else row[field] = String(v);
          }
        }
        result.push(row);
      }
      newValue = result;
      break;
    }
    case 'tree': {
      const result: Record<string, unknown> = {};
      for (const [field, raw] of Object.entries(body)) {
        if (!field.startsWith('leaf_')) continue;
        const path = field.slice('leaf_'.length);
        setPath(result, path, String(raw));
      }
      newValue = result;
      break;
    }
    default:
      newValue = String(body.v ?? '');
  }

  await setSetting(keyName, newValue, auth.user.id);
  invalidate([`setting:${keyName}`]);
  invalidateSettingsCache();
  invalidate(['settings:all']);
  void fireEvent('setting.changed', { key: keyName }, [`setting:${keyName}`, 'settings:all']);
  return c.redirect(`/admin/settings/${encodeURIComponent(keyName)}?ok=${encodeURIComponent(t('content.flashSaved'))}`, 302);
});

// ── Media library ──────────────────────────────────────────────────────

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

const MEDIA_CSS = `
.media-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(160px,1fr));gap:14px;margin-top:14px}
.media-card{background:var(--panel);border:1px solid var(--line);border-radius:8px;overflow:hidden;cursor:pointer;transition:border-color .15s;position:relative}
.media-card:hover{border-color:var(--acc)}
.media-card.selected{border-color:var(--acc2);box-shadow:0 0 0 2px var(--acc2)}
.media-thumb{aspect-ratio:1;background:var(--panel2);display:flex;align-items:center;justify-content:center;overflow:hidden}
.media-thumb img{width:100%;height:100%;object-fit:cover;display:block}
.media-thumb .ico{font-size:32px;color:var(--mut)}
.media-meta{padding:8px 10px;font-size:11px;line-height:1.3}
.media-meta .fn{color:var(--ink);font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.media-meta .sub{color:var(--mut);margin-top:2px;font-size:10px}
.dropzone{border:2px dashed var(--line);border-radius:10px;padding:32px 18px;text-align:center;color:var(--mut);background:var(--panel);transition:all .15s}
.dropzone.over{border-color:var(--acc);background:rgba(245,158,11,.08);color:var(--ink)}
.dropzone strong{color:var(--ink);font-weight:600}
.dropzone .small{font-size:12px;margin-top:6px;color:var(--mut)}
.dropzone input[type=file]{display:none}
.dropzone label{cursor:pointer;display:inline-block;margin:0;padding:6px 14px;background:var(--acc);color:#1a1205;border-radius:6px;font-weight:600;font-size:13px}
.media-progress{height:3px;background:var(--line);border-radius:2px;overflow:hidden;margin-top:8px}
.media-progress > div{height:100%;background:var(--acc);width:0%;transition:width .15s}
.media-dialog{background:var(--panel);color:var(--ink);border:1px solid var(--line);border-radius:10px;padding:0;max-width:520px;width:90%}
.media-dialog::backdrop{background:rgba(0,0,0,0.5)}
.media-dialog-inner{padding:18px}
.media-dialog .preview{aspect-ratio:1;background:var(--panel2);border-radius:8px;overflow:hidden;max-width:260px;margin:0 auto 16px}
.media-dialog .preview img{width:100%;height:100%;object-fit:contain;display:block}
`;

adminScreens.get('/media', async (c) => {
  const auth = gate(c);
  if (notAuth(auth)) return auth;
  const t = getT(c);
  const filter = c.req.query('type') ?? '';
  const items = await listMedia({ ...(filter ? { mimeType: filter } : {}), limit: 200 });
  // Raw templates (placeholders intact) for the client-side upload script.
  const mediaI18n = {
    uploading: t('media.uploading'),
    altPrompt: t('editor.altPromptA11y'),
    skipped: t('media.skippedNoAlt'),
    failed: t('media.uploadFailed'),
    uploadedOne: t.plural('media.uploaded', 1, { n: '{n}' }),
    uploadedOther: t.plural('media.uploaded', 2, { n: '{n}' }),
  };

  return c.html(
    <AdminPage title={t('media.title')} active="media" t={t} user={{ ...auth.user, roleSlug: auth.role.slug }} caps={auth.role.capabilities}>
      <style dangerouslySetInnerHTML={{ __html: MEDIA_CSS }} />
      <div class="top">
        <h1>{t('media.title')}</h1>
        <form method="get" style="display:flex;gap:8px;margin:0">
          <select name="type" onchange="this.form.submit()" style="background:var(--panel2);border:1px solid var(--line);color:var(--ink);padding:6px 10px;border-radius:6px;font-size:13px">
            <option value="" selected={filter === ''}>{t('media.allTypes')}</option>
            <option value="image/" selected={filter === 'image/'}>{t('media.images')}</option>
            <option value="video/" selected={filter === 'video/'}>{t('media.videos')}</option>
            <option value="audio/" selected={filter === 'audio/'}>{t('media.audio')}</option>
            <option value="application/pdf" selected={filter === 'application/pdf'}>{t('media.pdfs')}</option>
          </select>
        </form>
      </div>

      <div class="card" style="margin-bottom:14px;padding:14px">
        <div id="dropzone" class="dropzone">
          <div><strong>{t('media.dropStrong')}</strong> {t('media.dropPrompt')}</div>
          <div class="small">{t('media.or')} <label for="dz-file">{t('media.chooseFiles')}</label> · {t('media.dropHint')}</div>
          <input id="dz-file" type="file" multiple accept="image/*,application/pdf,video/*" />
          <div id="dz-progress" class="media-progress" style="display:none"><div></div></div>
          <div id="dz-status" class="small" style="margin-top:6px"></div>
        </div>
      </div>

      <div class="card">
        <div class="muted" style="font-size:12px">{t.plural('common.items', items.length)}</div>
        <div id="media-grid" class="media-grid">
          {items.length === 0 ? (
            <div class="muted" style="grid-column:1/-1;text-align:center;padding:30px;font-size:13px">
              {t('media.empty')}
            </div>
          ) : items.map((m) => (
            <a class="media-card" href={`/admin/media/${m.id}`} title={m.filename}>
              <div class="media-thumb">
                {m.mimeType.startsWith('image/')
                  ? <img src={`/api/v1/media/${m.id}/raw`} alt="" loading="lazy" />
                  : <div class="ico">{m.mimeType.startsWith('video/') ? '🎬' : m.mimeType === 'application/pdf' ? '📄' : '📎'}</div>}
              </div>
              <div class="media-meta">
                <div class="fn">{m.filename}</div>
                <div class="sub">{fmtBytes(m.sizeBytes)}{m.width && m.height ? ` · ${m.width}×${m.height}` : ''}</div>
              </div>
            </a>
          ))}
        </div>
      </div>

      <script dangerouslySetInnerHTML={{ __html: `window.SKELPO_I18N=${JSON.stringify(mediaI18n)};` }} />
      <script dangerouslySetInnerHTML={{ __html: `
        (function(){
          var I18N=window.SKELPO_I18N||{};
          const dz=document.getElementById('dropzone');
          const input=document.getElementById('dz-file');
          const progress=document.getElementById('dz-progress');
          const bar=progress.firstElementChild;
          const status=document.getElementById('dz-status');
          function setOver(on){dz.classList.toggle('over',on);}
          ['dragenter','dragover'].forEach(e=>dz.addEventListener(e,(ev)=>{ev.preventDefault();setOver(true);}));
          ['dragleave','drop'].forEach(e=>dz.addEventListener(e,(ev)=>{ev.preventDefault();setOver(false);}));
          dz.addEventListener('drop',(ev)=>{uploadAll(ev.dataTransfer.files);});
          input.addEventListener('change',(ev)=>{uploadAll(input.files);});
          async function uploadAll(files){
            if(!files||files.length===0)return;
            progress.style.display='block';bar.style.width='0%';
            let done=0;
            for(const f of files){
              status.textContent=(I18N.uploading||'Uploading {file} ({done}/{total})…').replace('{file}',f.name).replace('{done}',done+1).replace('{total}',files.length);
              try{
                const isImage=f.type.startsWith('image/');
                let alt='';
                if(isImage){
                  alt=prompt((I18N.altPrompt||'Alt text for "{file}" (required for accessibility):').replace('{file}',f.name),f.name.replace(/\\.[^.]+$/,'').replace(/[-_]/g,' '))||'';
                  if(!alt){status.textContent=(I18N.skipped||'Skipped (no alt text): {file}').replace('{file}',f.name);continue;}
                }
                const fd=new FormData();
                fd.append('file',f);
                if(isImage)fd.append('altText',JSON.stringify({en:alt}));
                const r=await fetch('/admin/media/upload',{method:'POST',body:fd,credentials:'same-origin'});
                if(!r.ok)throw new Error('HTTP '+r.status);
              }catch(e){
                status.textContent=(I18N.failed||'Failed: {file} ({error})').replace('{file}',f.name).replace('{error}',e.message);
                return;
              }
              done++;bar.style.width=(done/files.length*100)+'%';
            }
            status.textContent=(done===1?(I18N.uploadedOne||'Uploaded {n} file.'):(I18N.uploadedOther||'Uploaded {n} files.')).replace('{n}',done);
            setTimeout(()=>{location.reload();},500);
          }
        })();
      ` }} />
    </AdminPage>,
  );
});

// Detail / edit modal for a single media row.
adminScreens.get('/media/:id{[0-9]+}', async (c) => {
  const auth = gate(c);
  if (notAuth(auth)) return auth;
  const t = getT(c);
  const m = await getMedia(Number(c.req.param('id')));
  if (!m) return c.html(<AdminPage title={t('common.notFound')} t={t} user={{ ...auth.user, roleSlug: auth.role.slug }} caps={auth.role.capabilities}>{t('media.notFound')}</AdminPage>, 404);
  const altObj = (typeof m.altText === 'object' && m.altText !== null ? m.altText : {}) as Record<string, string>;

  return c.html(
    <AdminPage title={m.filename} active="media" t={t} user={{ ...auth.user, roleSlug: auth.role.slug }} caps={auth.role.capabilities}>
      <style dangerouslySetInnerHTML={{ __html: MEDIA_CSS }} />
      <div class="top">
        <h1 style="font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:16px">{m.filename}</h1>
        <a class="btn sec" href="/admin/media">{t('media.allMedia')}</a>
      </div>
      <div class="grid g2" style="align-items:start">
        <div class="card">
          {m.mimeType.startsWith('image/') ? (
            <img src={`/api/v1/media/${m.id}/raw`} alt={altObj.en ?? ''} style="max-width:100%;border-radius:7px;display:block" />
          ) : (
            <div style="aspect-ratio:1;background:var(--panel2);display:flex;align-items:center;justify-content:center;font-size:48px;color:var(--mut);border-radius:7px">
              {m.mimeType.startsWith('video/') ? '🎬' : m.mimeType === 'application/pdf' ? '📄' : '📎'}
            </div>
          )}
        </div>
        <div class="card">
          <form method="post" action={`/admin/media/${m.id}`}>
            <label>{t('media.altText')} <span class="muted" style="font-weight:400">· {t('media.altTextNote')}</span></label>
            <input type="text" name="altText_en" value={altObj.en ?? ''} placeholder={t('media.altPlaceholder')} />
            <label>{t('media.filename')}</label>
            <input type="text" name="filename" value={m.filename} />
            <div class="muted" style="font-size:12px;margin-top:18px;line-height:1.6">
              <div><strong>{t('media.metaType')}</strong> {m.mimeType}</div>
              <div><strong>{t('media.metaSize')}</strong> {fmtBytes(m.sizeBytes)}</div>
              {m.width && m.height ? <div><strong>{t('media.metaDimensions')}</strong> {m.width} × {m.height}</div> : null}
              <div><strong>{t('media.metaPublicUrl')}</strong> <code style="font-size:11px;background:var(--panel2);padding:2px 6px;border-radius:4px">/api/v1/media/{m.id}/raw</code></div>
            </div>
            <div style="margin-top:18px;display:flex;gap:8px">
              <button class="btn" type="submit" name="action" value="save">{t('media.save')}</button>
              <button class="btn sec" type="submit" name="action" value="delete" style="color:var(--err);margin-left:auto"
                onclick={'return confirm(' + JSON.stringify(t('media.confirmDelete')) + ')'}>{t('media.delete')}</button>
            </div>
          </form>
        </div>
      </div>
    </AdminPage>,
  );
});

adminScreens.post('/media/:id{[0-9]+}', async (c) => {
  const auth = gate(c);
  if (notAuth(auth)) return auth;
  if (!need(c, auth, 'manageMedia')) return c.redirect('/admin/media', 302);
  const id = Number(c.req.param('id'));
  const body = await c.req.parseBody();
  if (body.action === 'delete') {
    await deleteMedia(id);
    return c.redirect('/admin/media', 302);
  }
  await updateMedia(id, {
    altText: { en: String(body.altText_en ?? '') },
    filename: String(body.filename ?? '').trim() || undefined,
  });
  return c.redirect(`/admin/media/${id}`, 302);
});

// Multipart upload from the admin (browser-side drag-drop or picker).
adminScreens.post('/media/upload', async (c) => {
  const auth = gate(c);
  if (notAuth(auth)) return auth;
  if (!need(c, auth, 'manageMedia')) return c.json({ error: 'forbidden' }, 403);
  const body = await c.req.parseBody();
  const file = body.file;
  if (!file || typeof file === 'string') return c.json({ error: 'file required' }, 422);
  if (file.size > 25 * 1024 * 1024) return c.json({ error: 'file exceeds 25MB limit' }, 413);
  let altText: Record<string, string> = {};
  try { altText = body.altText ? JSON.parse(String(body.altText)) : {}; }
  catch { altText = { en: String(body.altText ?? '') }; }
  const isImage = (file.type || '').startsWith('image/');
  if (isImage && Object.values(altText).filter(Boolean).length === 0) {
    return c.json({ error: 'altText required for images' }, 422);
  }
  const bytes = new Uint8Array(await file.arrayBuffer());
  const row = await storeMedia({
    filename: file.name || 'upload',
    mimeType: file.type || 'application/octet-stream',
    bytes,
    altText,
    uploadedBy: auth.user.id,
  });
  return c.json({ data: { id: row.id, filename: row.filename, urlRaw: `/api/v1/media/${row.id}/raw`, mimeType: row.mimeType, width: row.width, height: row.height } }, 201);
});

// Picker fragment — embedded in the content editor's modal. Returns just
// a grid (no chrome) so it can be loaded via fetch + innerHTML.
adminScreens.get('/media/picker', async (c) => {
  const auth = gate(c);
  if (notAuth(auth)) return auth;
  const t = getT(c);
  const items = await listMedia({ mimeType: 'image/', limit: 200 });
  // Returns a fragment, not a full page. CSS comes from the parent.
  return c.html(
    <div>
      <style dangerouslySetInnerHTML={{ __html: MEDIA_CSS }} />
      {items.length === 0 ? (
        <div class="muted" style="text-align:center;padding:30px;font-size:13px">
          {t('media.pickerEmpty')} <a href="/admin/media" target="_blank">{t('media.pickerGoToLibrary')}</a>
        </div>
      ) : (
        <div class="media-grid">
          {items.map((m) => {
            const alt = typeof m.altText === 'object' && m.altText ? (m.altText as Record<string, string>).en ?? '' : '';
            return (
              <button
                type="button"
                class="media-card"
                style="background:none;padding:0;font:inherit;color:inherit;border:1px solid var(--line)"
                data-id={m.id}
                data-url={`/api/v1/media/${m.id}/raw`}
                data-alt={alt}
                data-filename={m.filename}
                onclick={`window.skelpoMediaPick(${m.id}, '/api/v1/media/${m.id}/raw', ${JSON.stringify(alt)}, ${JSON.stringify(m.filename)})`}
              >
                <div class="media-thumb"><img src={`/api/v1/media/${m.id}/raw`} alt="" loading="lazy" /></div>
                <div class="media-meta">
                  <div class="fn">{m.filename}</div>
                  <div class="sub">{m.width && m.height ? `${m.width}×${m.height}` : fmtBytes(m.sizeBytes)}</div>
                </div>
              </button>
            );
          })}
        </div>
      )}
    </div>,
  );
});

// ── Forms ──────────────────────────────────────────────────────────────
// Forms ARE content rows of type `form`; submissions live in their own
// `formSubmissions` table referencing form.id. This screen wraps both:
// the list lives next to the submission counts, click a form to see
// what's come in.

adminScreens.get('/forms', async (c) => {
  const auth = gate(c);
  if (notAuth(auth)) return auth;
  const t = getT(c);
  const canManageForms = need(c, auth, 'manageForms');
  const canViewSubs    = canManageForms || need(c, auth, 'viewSubmissions');
  if (!canViewSubs) {
    return c.html(
      <AdminPage title={t('forms.title')} active="forms" t={t} user={{ ...auth.user, roleSlug: auth.role.slug }} caps={auth.role.capabilities}>
        <div class="card" style="text-align:center;padding:30px">
          <p class="muted">{t('forms.noAccess', { cap1: 'viewSubmissions', cap2: 'manageForms' })}</p>
        </div>
      </AdminPage>,
      403,
    );
  }

  // Form definitions are content rows (one per locale; show default
  // locale only for the list).
  const defaultLocale = (await queryOne<{ value: unknown }>(
    "SELECT `value` FROM `settings` WHERE `keyName` = 'site.defaultLocale'",
  ))?.value;
  const localeFilter = typeof defaultLocale === 'string'
    ? defaultLocale.replace(/^"|"$/g, '')
    : (Array.isArray(defaultLocale) ? defaultLocale[0] : 'en');

  const forms = await query<{ id: number; slug: string; title: string; status: string; locale: string }>(
    `SELECT \`id\`, \`slug\`, \`title\`, \`status\`, \`locale\`
       FROM \`content\` WHERE \`typeSlug\` = 'form' AND \`locale\` = ?
      ORDER BY \`title\``,
    [localeFilter],
  );

  // Submission + spam counts in one round-trip.
  const counts = await query<{ formId: number; total: number; spam: number }>(
    `SELECT \`formId\`, COUNT(*) AS total, SUM(\`isSpam\`) AS spam
       FROM \`formSubmissions\` GROUP BY \`formId\``,
  );
  const cMap = new Map(counts.map((c) => [c.formId, c]));

  return c.html(
    <AdminPage title={t('forms.title')} active="forms" t={t} user={{ ...auth.user, roleSlug: auth.role.slug }} caps={auth.role.capabilities}>
      <div class="top">
        <h1>{t('forms.title')}</h1>
        {canManageForms ? <a class="btn" href="/admin/content/form/new">{t('forms.newForm')}</a> : null}
      </div>
      <div class="card">
        {forms.length === 0 ? (
          <div class="muted" style="text-align:center;padding:30px;font-size:13px;line-height:1.6">
            {canManageForms ? (
              <>
                <div>{t('forms.emptyManage')}</div>
                <div style="margin-top:10px">
                  <a class="btn" href="/admin/content/form/new">{t('forms.createFirst')}</a>
                </div>
                <div style="margin-top:14px;font-size:12px;color:var(--mut)">
                  {(() => {
                    const parts = t('forms.manageHint').split('{endpoint}');
                    return <>{parts[0]}<code style="background:var(--panel2);padding:2px 6px;border-radius:4px">POST /api/v1/forms/&lt;slug&gt;/submit</code>{parts[1] ?? ''}</>;
                  })()}
                  <br />{t('forms.manageHintNote')}
                </div>
              </>
            ) : (
              <>
                <div>{t('forms.emptyNoManage')}</div>
                <div style="margin-top:10px;font-size:12px">
                  {t('forms.noManageHint')}
                </div>
              </>
            )}
          </div>
        ) : (
          <table>
            <thead>
              <tr>
                <th>{t('forms.colTitle')}</th>
                <th>{t('forms.colSlug')}</th>
                <th>{t('forms.colStatus')}</th>
                <th>{t('forms.colSubmissions')}</th>
                <th>{t('forms.colSpam')}</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {forms.map((f) => {
                const cnt = cMap.get(f.id);
                return (
                  <tr>
                    <td><a href={`/admin/forms/${f.slug}`}>{f.title}</a></td>
                    <td class="muted">{f.slug}</td>
                    <td><StatusBadge status={f.status} t={t} /></td>
                    <td>{cnt ? cnt.total : 0}</td>
                    <td class="muted">{cnt?.spam ?? 0}</td>
                    <td>{canManageForms ? <a class="muted" style="font-size:12px" href={`/admin/content/form/${f.id}`}>{t('forms.editDefinition')}</a> : null}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
      <div class="muted" style="font-size:12px;margin-top:10px;line-height:1.6">
        {t('forms.fetchHint')}
        {' '}<code style="background:var(--panel2);padding:2px 6px;border-radius:4px">GET /api/v1/forms/&lt;slug&gt;/submissions</code>
        {' '}({t('forms.fetchHintCap', { cap: 'manageForms' })}).
      </div>
    </AdminPage>,
  );
});

adminScreens.get('/forms/:slug', async (c) => {
  const auth = gate(c);
  if (notAuth(auth)) return auth;
  const t = getT(c);
  // Submissions carry PII (names, emails, IPs) — same gate as the /forms index.
  if (!need(c, auth, 'viewSubmissions') && !need(c, auth, 'manageForms')) {
    return c.html(<AdminPage title={t('common.forbidden')} t={t} user={{ ...auth.user, roleSlug: auth.role.slug }} caps={auth.role.capabilities}>{t('common.forbidden')}</AdminPage>, 403);
  }
  const slug = c.req.param('slug');
  const includeSpam = c.req.query('spam') === '1';

  const form = await queryOne<{ id: number; slug: string; title: string; status: string }>(
    `SELECT \`id\`, \`slug\`, \`title\`, \`status\`
       FROM \`content\` WHERE \`typeSlug\` = 'form' AND \`slug\` = ? LIMIT 1`,
    [slug],
  );
  if (!form) return c.html(<AdminPage title="404" t={t} user={{ ...auth.user, roleSlug: auth.role.slug }} caps={auth.role.capabilities}>{t('forms.notFound')}</AdminPage>, 404);

  const subs = await query<{ id: number; data: unknown; ip: string | null; isSpam: number; createdAt: unknown }>(
    `SELECT \`id\`, \`data\`, \`ip\`, \`isSpam\`, \`createdAt\`
       FROM \`formSubmissions\`
      WHERE \`formId\` = ? ${includeSpam ? '' : 'AND `isSpam` = 0'}
      ORDER BY \`createdAt\` DESC LIMIT 200`,
    [form.id],
  );
  const totalSpam = (await queryOne<{ n: number }>(
    'SELECT COUNT(*) AS n FROM `formSubmissions` WHERE `formId` = ? AND `isSpam` = 1',
    [form.id],
  ))?.n ?? 0;

  return c.html(
    <AdminPage title={t('forms.detailTitle', { title: form.title })} active="forms" t={t} user={{ ...auth.user, roleSlug: auth.role.slug }} caps={auth.role.capabilities}>
      <div class="top">
        <h1>{form.title} <span class="muted" style="font-size:14px;font-weight:400">· {t.plural('forms.submissionsCount', subs.length)}</span></h1>
        <div style="display:flex;gap:8px">
          <a class="btn sec" href="/admin/forms">{t('forms.allForms')}</a>
          <a class="btn sec" href={`/admin/content/form/${form.id}`}>{t('forms.editDefinitionPlain')}</a>
        </div>
      </div>
      <div class="card" style="margin-bottom:14px;padding:10px 14px">
        <div style="display:flex;justify-content:space-between;align-items:center;font-size:13px">
          <div class="muted">
            {t('forms.publicEndpoint')}{' '}
            <code style="background:var(--panel2);padding:2px 6px;border-radius:4px">POST /api/v1/forms/{form.slug}/submit</code>
          </div>
          <div>
            {includeSpam
              ? <a class="muted" style="font-size:12px" href={`/admin/forms/${form.slug}`}>{t('forms.hideSpam')}</a>
              : <a class="muted" style="font-size:12px" href={`/admin/forms/${form.slug}?spam=1`}>{t('forms.showSpam', { n: totalSpam })}</a>}
          </div>
        </div>
      </div>
      <div class="card">
        {subs.length === 0 ? (
          <div class="muted" style="text-align:center;padding:30px;font-size:13px">
            {includeSpam ? t('forms.noSubmissions') : t('forms.noNonSpamSubmissions')}
          </div>
        ) : (
          <table>
            <thead>
              <tr>
                <th style="width:36%">{t('forms.colData')}</th>
                <th>{t('forms.colIp')}</th>
                <th>{t('forms.colReceived')}</th>
                <th>{t('forms.colStatus')}</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {normalizeDates(subs).map((s) => {
                const data = typeof s.data === 'string' ? (() => { try { return JSON.parse(s.data); } catch { return s.data; } })() : s.data;
                return (
                  <tr>
                    <td>
                      <pre style="margin:0;font-size:11px;background:var(--panel2);padding:8px;border-radius:4px;max-height:160px;overflow:auto;white-space:pre-wrap">
                        {typeof data === 'object' ? JSON.stringify(data, null, 2) : String(data ?? '')}
                      </pre>
                    </td>
                    <td class="muted" style="font-size:12px">{s.ip ?? '—'}</td>
                    <td class="muted" style="font-size:12px">{String(s.createdAt).slice(0, 16).replace('T', ' ')}</td>
                    <td>{s.isSpam ? <span class="badge b-arch">{t('forms.badgeSpam')}</span> : <span class="badge b-pub">{t('forms.badgeNew')}</span>}</td>
                    <td>
                      <form method="post" action={`/admin/forms/${form.slug}/submissions/${s.id}`} style="display:inline;margin:0">
                        {!s.isSpam ? <button class="btn sm sec" name="action" value="mark-spam" style="margin-right:4px">{t('forms.markSpam')}</button> : null}
                        <button class="btn sm sec" name="action" value="delete" style="color:var(--err)"
                          onclick={'return confirm(' + JSON.stringify(t('forms.confirmDeleteSubmission')) + ')'}>{t('common.delete')}</button>
                      </form>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </AdminPage>,
  );
});

adminScreens.post('/forms/:slug/submissions/:id{[0-9]+}', async (c) => {
  const auth = gate(c);
  if (notAuth(auth)) return auth;
  if (!need(c, auth, 'manageForms')) return c.redirect(`/admin/forms/${c.req.param('slug')}`, 302);
  const slug = c.req.param('slug');
  const id = Number(c.req.param('id'));
  const body = await c.req.parseBody();
  if (body.action === 'mark-spam') {
    await execute('UPDATE `formSubmissions` SET `isSpam` = 1 WHERE `id` = ?', [id]);
  } else if (body.action === 'delete') {
    await execute('DELETE FROM `formSubmissions` WHERE `id` = ?', [id]);
  }
  return c.redirect(`/admin/forms/${slug}`, 302);
});

// ── Users ──────────────────────────────────────────────────────────────

adminScreens.get('/users', async (c) => {
  const auth = gate(c);
  if (notAuth(auth)) return auth;
  const t = getT(c);
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
    <AdminPage title={t('users.title')} active="users" t={t} user={{ ...auth.user, roleSlug: auth.role.slug }} caps={auth.role.capabilities}>
      <div class="top">
        <h1>{t('users.title')}</h1>
      </div>
      {flash ? <div class="ok">{flash}</div> : null}
      <div class="card">
        <table>
          <thead>
            <tr>
              <th>{t('users.colEmail')}</th>
              <th>{t('users.colName')}</th>
              <th>{t('users.colRole')}</th>
              <th>{t('users.colStatus')}</th>
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
                        {u.status === 'suspended' ? t('users.unsuspend') : t('users.suspend')}
                      </button>
                    </form>
                  ) : (
                    <span class="muted">{t('common.you')}</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div class="card" style="margin-top:16px">
        <h3 style="margin-top:0">{t('users.inviteTitle')}</h3>
        <form method="post" action="/admin/users">
          <div class="grid g3">
            <div>
              <label>{t('users.email')}</label>
              <input type="email" name="email" required />
            </div>
            <div>
              <label>{t('users.displayName')}</label>
              <input type="text" name="displayName" required />
            </div>
            <div>
              <label>{t('users.role')}</label>
              <select name="roleSlug">
                {roles.map((r) => (
                  <option value={r.slug}>{r.label}</option>
                ))}
              </select>
            </div>
          </div>
          <div style="margin-top:14px">
            <button class="btn" type="submit">
              {t('users.sendInvite')}
            </button>
          </div>
        </form>
      </div>
    </AdminPage>,
  );
});

adminScreens.post('/users', async (c) => {
  const auth = gate(c);
  if (notAuth(auth)) return auth;
  const t = getT(c);
  if (!need(c, auth, 'manageUsers')) return c.redirect('/admin/users?ok=' + encodeURIComponent(t('users.flashForbidden')), 302);
  const b = await c.req.parseBody();
  const email = String(b.email ?? '').toLowerCase().trim();
  const displayName = String(b.displayName ?? '').trim();
  const role = await findRoleBySlug(String(b.roleSlug ?? 'viewer'));
  if (!email || !displayName || !role) return c.redirect('/admin/users?ok=' + encodeURIComponent(t('users.flashInvalidInput')), 302);
  const dup = await queryOne<{ id: number }>('SELECT `id` FROM `users` WHERE `email`=?', [email]);
  if (dup) return c.redirect('/admin/users?ok=' + encodeURIComponent(t('users.flashEmailUsed')), 302);
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
  return c.redirect('/admin/users?ok=' + encodeURIComponent(t('users.flashInviteSent')), 302);
});

adminScreens.post('/users/:id/toggle', async (c) => {
  const auth = gate(c);
  if (notAuth(auth)) return auth;
  const t = getT(c);
  if (!need(c, auth, 'manageUsers')) return c.redirect('/admin/users?ok=' + encodeURIComponent(t('users.flashForbidden')), 302);
  const id = Number(c.req.param('id'));
  if (id === auth.user.id) return c.redirect('/admin/users?ok=' + encodeURIComponent(t('users.flashCannotChangeSelf')), 302);
  const u = await queryOne<{ status: string }>('SELECT `status` FROM `users` WHERE `id`=?', [id]);
  if (!u) return c.redirect('/admin/users?ok=' + encodeURIComponent(t('users.flashNotFound')), 302);
  const next = u.status === 'suspended' ? 'active' : 'suspended';
  await execute('UPDATE `users` SET `status`=? WHERE `id`=?', [next, id]);
  if (next === 'suspended') await execute('DELETE FROM `sessions` WHERE `userId`=?', [id]);
  return c.redirect('/admin/users?ok=' + encodeURIComponent(t('users.flashUpdated')), 302);
});

// ── Redirects ──────────────────────────────────────────────────────────

adminScreens.get('/redirects', async (c) => {
  const auth = gate(c);
  if (notAuth(auth)) return auth;
  const t = getT(c);
  const rows = await query<{ id: number; source: string; destination: string; statusCode: number; hitCount: number }>(
    'SELECT `id`,`source`,`destination`,`statusCode`,`hitCount` FROM `redirects` ORDER BY `id` DESC',
  );
  return c.html(
    <AdminPage title={t('redirects.title')} active="redirects" t={t} user={{ ...auth.user, roleSlug: auth.role.slug }} caps={auth.role.capabilities}>
      <div class="top">
        <h1>{t('redirects.title')}</h1>
      </div>
      <div class="card">
        <form method="post" action="/admin/redirects" class="row" style="gap:8px;align-items:end;flex-wrap:wrap">
          <div style="flex:1;min-width:160px">
            <label>{t('redirects.source')}</label>
            <input type="text" name="source" placeholder={t('redirects.sourcePlaceholder')} required />
          </div>
          <div style="flex:1;min-width:160px">
            <label>{t('redirects.destination')}</label>
            <input type="text" name="destination" placeholder={t('redirects.destinationPlaceholder')} required />
          </div>
          <div style="width:110px">
            <label>{t('redirects.code')}</label>
            <select name="statusCode">
              <option>301</option>
              <option>302</option>
              <option>307</option>
              <option>308</option>
            </select>
          </div>
          <button class="btn" type="submit">
            {t('redirects.add')}
          </button>
        </form>
      </div>
      <div class="card" style="margin-top:16px">
        <table>
          <thead>
            <tr>
              <th>{t('redirects.colSource')}</th>
              <th>{t('redirects.colDestination')}</th>
              <th>{t('redirects.colCode')}</th>
              <th>{t('redirects.colHits')}</th>
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
                      {t('common.delete')}
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
  if (notAuth(auth)) return auth;
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
  if (notAuth(auth)) return auth;
  if (!need(c, auth, 'manageRedirects')) return c.redirect('/admin/redirects', 302);
  await execute('DELETE FROM `redirects` WHERE `id`=?', [Number(c.req.param('id'))]);
  invalidate(['redirects', 'GET:/redirects'], { prefix: true });
  return c.redirect('/admin/redirects', 302);
});

// ── Menus ──────────────────────────────────────────────────────────────

adminScreens.get('/menus', async (c) => {
  const auth = gate(c);
  if (notAuth(auth)) return auth;
  const t = getT(c);
  const menus = await listMenus();
  const sel = c.req.query('m') ?? menus[0]?.slug ?? 'main';
  const tree = await getMenuTree(sel, 'en', 'en');
  return c.html(
    <AdminPage title={t('menus.title')} active="menus" t={t} user={{ ...auth.user, roleSlug: auth.role.slug }} caps={auth.role.capabilities}>
      <div class="top">
        <h1>{t('menus.title')}</h1>
        <div class="row">
          {menus.map((m) => (
            <a class={`btn sm ${m.slug === sel ? '' : 'sec'}`} href={`/admin/menus?m=${m.slug}`}>
              {m.label}
            </a>
          ))}
        </div>
      </div>
      <div class="card">
        <h3 style="margin-top:0">{t('menus.itemsHeading', { slug: sel })}</h3>
        <table>
          <thead>
            <tr>
              <th>{t('menus.colLabel')}</th>
              <th>{t('menus.colUrl')}</th>
              <th>{t('menus.colOrder')}</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {(tree?.items ?? []).map((i) => (
              <tr>
                <td>{i.label}</td>
                <td class="muted">{i.url ?? t('menus.contentLink')}</td>
                <td>{i.sortOrder}</td>
                <td>
                  <form method="post" action={`/admin/menus/${sel}/items/${i.id}/delete`} style="margin:0">
                    <button class="btn sec sm" type="submit">
                      {t('common.delete')}
                    </button>
                  </form>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div class="card" style="margin-top:16px">
        <h3 style="margin-top:0">{t('menus.addItem', { slug: sel })}</h3>
        <form method="post" action={`/admin/menus/${sel}/items`} class="row" style="gap:8px;align-items:end;flex-wrap:wrap">
          <div style="flex:1;min-width:140px">
            <label>{t('menus.label')}</label>
            <input type="text" name="label" required />
          </div>
          <div style="flex:1;min-width:140px">
            <label>{t('menus.url')}</label>
            <input type="text" name="url" placeholder={t('menus.urlPlaceholder')} required />
          </div>
          <div style="width:90px">
            <label>{t('menus.order')}</label>
            <input type="number" name="sortOrder" value="0" />
          </div>
          <button class="btn" type="submit">
            {t('menus.add')}
          </button>
        </form>
      </div>
    </AdminPage>,
  );
});

adminScreens.post('/menus/:slug/items', async (c) => {
  const auth = gate(c);
  if (notAuth(auth)) return auth;
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
  if (notAuth(auth)) return auth;
  if (!need(c, auth, 'manageMenus')) return c.redirect('/admin/menus', 302);
  const slug = c.req.param('slug');
  await deleteMenuItem(Number(c.req.param('id')));
  invalidate([`menu:${slug}`], { prefix: true });
  return c.redirect(`/admin/menus?m=${slug}`, 302);
});

// ── Jobs (read-only + retry) ───────────────────────────────────────────

adminScreens.get('/jobs', async (c) => {
  const auth = gate(c);
  if (notAuth(auth)) return auth;
  const stats = await jobStats();
  const recent = await query<{ id: number; kind: string; status: string; attempts: number; lastError: string | null; createdAt: unknown }>(
    'SELECT `id`,`kind`,`status`,`attempts`,`lastError`,`createdAt` FROM `jobs` ORDER BY `id` DESC LIMIT 30',
  );
  const t = getT(c);
  return c.html(
    <AdminPage title={t('jobs.title')} active="jobs" t={t} user={{ ...auth.user, roleSlug: auth.role.slug }} caps={auth.role.capabilities}>
      <div class="top">
        <h1>{t('jobs.title')}</h1>
        <span class="muted">
          {Object.entries(stats).map(([k, v]) => `${k}: ${v}`).join('  ·  ') || t('common.idle')}
        </span>
      </div>
      <div class="card">
        <table>
          <thead>
            <tr>
              <th>{t('jobs.colId')}</th>
              <th>{t('jobs.colKind')}</th>
              <th>{t('jobs.colStatus')}</th>
              <th>{t('jobs.colAttempts')}</th>
              <th>{t('jobs.colError')}</th>
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
                        {t('jobs.retry')}
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
  if (notAuth(auth)) return auth;
  if (!need(c, auth, 'manageJobs')) return c.redirect('/admin/jobs', 302);
  await retryJob(Number(c.req.param('id')));
  return c.redirect('/admin/jobs', 302);
});

// ── Webhooks ───────────────────────────────────────────────────────────

adminScreens.get('/webhooks', async (c) => {
  const auth = gate(c);
  if (notAuth(auth)) return auth;
  const t = getT(c);
  const hooks = await listWebhooks();
  const flash = c.req.query('ok');
  return c.html(
    <AdminPage title={t('webhooks.title')} active="webhooks" t={t} user={{ ...auth.user, roleSlug: auth.role.slug }} caps={auth.role.capabilities}>
      <div class="top">
        <h1>{t('webhooks.title')}</h1>
      </div>
      {flash ? <div class="ok">{decodeURIComponent(flash)}</div> : null}
      <div class="card">
        <table>
          <thead>
            <tr>
              <th>{t('webhooks.colUrl')}</th>
              <th>{t('webhooks.colEvents')}</th>
              <th>{t('webhooks.colActive')}</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {hooks.map((h) => (
              <tr>
                <td>{h.url}</td>
                <td class="muted">{h.events.join(', ')}</td>
                <td>{h.active ? t('webhooks.activeYes') : t('webhooks.activeNo')}</td>
                <td>
                  <form method="post" action={`/admin/webhooks/${h.id}/delete`} style="margin:0">
                    <button class="btn sec sm" type="submit">
                      {t('common.delete')}
                    </button>
                  </form>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div class="card" style="margin-top:16px">
        <h3 style="margin-top:0">{t('webhooks.addTitle')}</h3>
        <form method="post" action="/admin/webhooks">
          <label>{t('webhooks.url')}</label>
          <input type="url" name="url" required placeholder={t('webhooks.urlPlaceholder')} />
          <label>{t('webhooks.events')}</label>
          <input
            type="text"
            name="events"
            value="content.published,content.updated,content.unpublished,menu.updated,setting.changed"
          />
          <div style="margin-top:14px">
            <button class="btn" type="submit">
              {t('webhooks.add')}
            </button>
          </div>
        </form>
      </div>
    </AdminPage>,
  );
});

adminScreens.post('/webhooks', async (c) => {
  const auth = gate(c);
  if (notAuth(auth)) return auth;
  const t = getT(c);
  if (!need(c, auth, 'manageSettings')) return c.redirect('/admin/webhooks?ok=' + encodeURIComponent(t('webhooks.flashForbidden')), 302);
  const b = await c.req.parseBody();
  const url = String(b.url ?? '').trim();
  const events = String(b.events ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (url && events.length) {
    const { secret } = await createWebhook({ url, events });
    return c.redirect('/admin/webhooks?ok=' + encodeURIComponent(t('webhooks.flashCreated', { secret })), 302);
  }
  return c.redirect('/admin/webhooks?ok=' + encodeURIComponent(t('webhooks.flashInvalidInput')), 302);
});

adminScreens.post('/webhooks/:id/delete', async (c) => {
  const auth = gate(c);
  if (notAuth(auth)) return auth;
  const t = getT(c);
  if (!need(c, auth, 'manageSettings')) return c.redirect('/admin/webhooks', 302);
  await deleteWebhook(Number(c.req.param('id')));
  return c.redirect('/admin/webhooks?ok=' + encodeURIComponent(t('webhooks.flashDeleted')), 302);
});
