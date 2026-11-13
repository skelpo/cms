// Site screens: media library, form submissions, redirects, menus,
// background jobs and webhooks.

import { Hono } from 'hono';
import type { Context } from 'hono';
import { AdminPage, StatusBadge } from './layout.js';
import type { AuthContext } from '../auth/middleware.js';
import { getT, type Translator } from './i18n/index.js';
import { getConfiguredLocales, getDefaultLocale } from '../settings/store.js';
import { invalidate } from '../cache/deps.js';
import { fireEvent, listWebhooks, createWebhook, updateWebhook, deleteWebhook } from '../webhooks/dispatch.js';
import { execute, query, queryOne } from '../db/client.js';
import { dateToIso } from '../db/datetime.js';
import { listTypes } from '../content/types.js';
import {
  listMenus, getMenuBySlug, createMenu, deleteMenu,
  addMenuItem, updateMenuItem, deleteMenuItem,
} from '../menus/store.js';
import { jobStats, retryJob } from '../jobs/queue.js';
import { listMedia, countMedia, getMedia, storeMedia, updateMedia, deleteMedia, replaceMediaFile } from '../media/store.js';
import { gate, notAuth, allowed, pageUser, readFlash, Flash, withFlash, DateTime, Pager, fmtBytes, slugify } from './helpers.js';

export const adminSite = new Hono();

function forbidden(c: Context, auth: AuthContext, t: Translator) {
  return c.html(<AdminPage title={t('common.forbidden')} t={t} {...pageUser(auth)}><div class="card">{t('common.noAccess')}</div></AdminPage>, 403);
}

// ── Media library ──────────────────────────────────────────────────────

const MEDIA_PER_PAGE = 48;

export const MEDIA_CSS = `
.media-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(160px,1fr));gap:14px;margin-top:14px}
.media-card{background:var(--panel);border:1px solid var(--line);border-radius:8px;overflow:hidden;cursor:pointer;transition:border-color .15s;position:relative;display:block;color:inherit}
.media-card:hover{border-color:var(--acc);text-decoration:none}
.media-thumb{aspect-ratio:1;background:var(--panel2);display:flex;align-items:center;justify-content:center;overflow:hidden}
.media-thumb img{width:100%;height:100%;object-fit:cover;display:block}
.media-thumb .ico{font-size:32px;color:var(--mut)}
.media-meta{padding:8px 10px;font-size:11px;line-height:1.3;text-align:left}
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
`;

const fileIcon = (mime: string): string => (mime.startsWith('video/') ? '🎬' : mime.startsWith('audio/') ? '🎵' : mime === 'application/pdf' ? '📄' : '📎');

/** Readable default alt text from a filename ("team-photo_2.jpg" → "team photo 2"). */
function altFromFilename(name: string): string {
  return name.replace(/\.[^.]+$/, '').replace(/[-_]+/g, ' ').trim() || 'image';
}

const UPLOAD_SCRIPT = `
(function(){
  var I18N=window.SKELPO_I18N||{};
  var dz=document.getElementById('dropzone');if(!dz)return;
  var input=document.getElementById('dz-file');
  var progress=document.getElementById('dz-progress');
  var bar=progress.firstElementChild;
  var status=document.getElementById('dz-status');
  function setOver(on){dz.classList.toggle('over',on);}
  ['dragenter','dragover'].forEach(function(e){dz.addEventListener(e,function(ev){ev.preventDefault();setOver(true);});});
  ['dragleave','drop'].forEach(function(e){dz.addEventListener(e,function(ev){ev.preventDefault();setOver(false);});});
  dz.addEventListener('drop',function(ev){uploadAll(ev.dataTransfer.files);});
  input.addEventListener('change',function(){uploadAll(input.files);});
  async function uploadAll(files){
    if(!files||files.length===0)return;
    progress.style.display='block';bar.style.width='0%';
    var done=0,failed=[];
    for(var i=0;i<files.length;i++){
      var f=files[i];
      status.textContent=(I18N.uploading||'Uploading {file} ({done}/{total})…').replace('{file}',f.name).replace('{done}',i+1).replace('{total}',files.length);
      try{
        var fd=new FormData();fd.append('file',f);
        var r=await fetch('/admin/media/upload',{method:'POST',body:fd,credentials:'same-origin'});
        if(!r.ok){var msg='HTTP '+r.status;try{msg=(await r.json()).error||msg;}catch(e){}throw new Error(msg);}
        done++;
      }catch(e){failed.push(f.name+' ('+e.message+')');}
      bar.style.width=((i+1)/files.length*100)+'%';
    }
    if(failed.length){
      status.textContent=(I18N.failed||'Failed: {file}').replace('{file}',failed.join(', '));
      if(done>0)setTimeout(function(){location.reload();},2500);
      return;
    }
    status.textContent=(done===1?(I18N.uploadedOne||'Uploaded {n} file.'):(I18N.uploadedOther||'Uploaded {n} files.')).replace('{n}',done);
    setTimeout(function(){location.reload();},400);
  }
})();
`;

adminSite.get('/media', async (c) => {
  const auth = gate(c);
  if (notAuth(auth)) return auth;
  const t = getT(c);
  const type = c.req.query('type') ?? '';
  const q = (c.req.query('q') ?? '').trim().slice(0, 100);
  const page = Math.max(1, Number(c.req.query('page') ?? 1) || 1);
  const filter = { ...(type ? { mimeType: type } : {}), ...(q ? { q } : {}) };
  const total = await countMedia(filter);
  const pages = Math.max(1, Math.ceil(total / MEDIA_PER_PAGE));
  const current = Math.min(page, pages);
  const items = await listMedia({ ...filter, limit: MEDIA_PER_PAGE, offset: (current - 1) * MEDIA_PER_PAGE });
  const canUpload = allowed(auth, 'manageMedia');
  const href = (p: number): string => {
    const qs = [type ? `type=${encodeURIComponent(type)}` : '', q ? `q=${encodeURIComponent(q)}` : '', p > 1 ? `page=${p}` : ''].filter(Boolean).join('&');
    return qs ? `/admin/media?${qs}` : '/admin/media';
  };
  const mediaI18n = {
    uploading: t('media.uploading'),
    failed: t('media.uploadFailedList'),
    uploadedOne: t.plural('media.uploaded', 1, { n: '{n}' }),
    uploadedOther: t.plural('media.uploaded', 2, { n: '{n}' }),
  };

  return c.html(
    <AdminPage title={t('media.title')} active="media" t={t} {...pageUser(auth)}>
      <style dangerouslySetInnerHTML={{ __html: MEDIA_CSS }} />
      <div class="top">
        <h1>{t('media.title')}</h1>
        <form method="get" class="toolbar" style="margin:0">
          <input type="search" name="q" value={q} placeholder={t('media.searchPlaceholder')} style="min-width:200px" />
          <select name="type" onchange="this.form.submit()" aria-label={t('media.allTypes')}>
            <option value="" selected={type === ''}>{t('media.allTypes')}</option>
            <option value="image/" selected={type === 'image/'}>{t('media.images')}</option>
            <option value="video/" selected={type === 'video/'}>{t('media.videos')}</option>
            <option value="audio/" selected={type === 'audio/'}>{t('media.audio')}</option>
            <option value="application/pdf" selected={type === 'application/pdf'}>{t('media.pdfs')}</option>
          </select>
          <button class="btn sec sm" type="submit">{t('content.search')}</button>
        </form>
      </div>
      <Flash flash={readFlash(c)} />

      {canUpload ? (
        <div class="card" style="margin-bottom:14px;padding:14px">
          <div id="dropzone" class="dropzone">
            <div><strong>{t('media.dropStrong')}</strong> {t('media.dropPrompt')}</div>
            <div class="small">{t('media.or')} <label for="dz-file">{t('media.chooseFiles')}</label> · {t('media.dropHintSimple')}</div>
            <input id="dz-file" type="file" multiple accept="image/*,application/pdf,video/*,audio/*" />
            <div id="dz-progress" class="media-progress" style="display:none"><div></div></div>
            <div id="dz-status" class="small" style="margin-top:6px" role="status"></div>
          </div>
        </div>
      ) : null}

      <div class="card">
        <div class="muted" style="font-size:12px">{t.plural('common.items', total)}</div>
        <div id="media-grid" class="media-grid">
          {items.length === 0 ? (
            <div class="muted" style="grid-column:1/-1;text-align:center;padding:30px;font-size:13px">
              {q || type ? t('media.emptySearch') : t('media.empty')}
            </div>
          ) : items.map((m) => (
            <a class="media-card" href={`/admin/media/${m.id}`} title={m.filename}>
              <div class="media-thumb">
                {m.mimeType.startsWith('image/')
                  ? <img src={`/api/v1/media/${m.id}/raw`} alt="" loading="lazy" />
                  : <div class="ico">{fileIcon(m.mimeType)}</div>}
              </div>
              <div class="media-meta">
                <div class="fn">{m.filename}</div>
                <div class="sub">{fmtBytes(m.sizeBytes)}{m.width && m.height ? ` · ${m.width}×${m.height}` : ''}</div>
              </div>
            </a>
          ))}
        </div>
        <Pager page={current} pages={pages} href={href} label={t('content.pageOf', { page: current, pages, total })} />
      </div>

      <script dangerouslySetInnerHTML={{ __html: `window.SKELPO_I18N=${JSON.stringify(mediaI18n)};` }} />
      <script dangerouslySetInnerHTML={{ __html: UPLOAD_SCRIPT }} />
    </AdminPage>,
  );
});

/** Entries that reference a media item: as an image field, share image, or inside a text body. */
async function mediaUsage(id: number): Promise<{ id: number; title: string; typeSlug: string; locale: string }[]> {
  const clauses: string[] = ['CAST(`fields` AS CHAR) LIKE ?', "JSON_UNQUOTE(JSON_EXTRACT(`seo`, '$.ogImage')) = ?"];
  const params: unknown[] = [`%/media/${id}/raw%`, String(id)];
  for (const ct of await listTypes()) {
    for (const def of ct.fieldsSchema.fields) {
      if (def.type !== 'image' && def.type !== 'file') continue;
      clauses.push('(`typeSlug` = ? AND JSON_UNQUOTE(JSON_EXTRACT(`fields`, ?)) = ?)');
      params.push(ct.slug, `$."${def.name}"`, String(id));
    }
  }
  return query<{ id: number; title: string; typeSlug: string; locale: string }>(
    `SELECT \`id\`, \`title\`, \`typeSlug\`, \`locale\` FROM \`content\`
      WHERE \`status\` != 'archived' AND (${clauses.join(' OR ')}) ORDER BY \`updatedAt\` DESC LIMIT 25`,
    params,
  );
}

adminSite.get('/media/:id{[0-9]+}', async (c) => {
  const auth = gate(c);
  if (notAuth(auth)) return auth;
  const t = getT(c);
  const m = await getMedia(Number(c.req.param('id')));
  if (!m) return c.html(<AdminPage title={t('common.notFound')} t={t} {...pageUser(auth)}><div class="card">{t('media.notFound')}</div></AdminPage>, 404);
  const altObj = (typeof m.altText === 'object' && m.altText !== null ? m.altText : {}) as Record<string, string>;
  const locales = await getConfiguredLocales();
  const usage = await mediaUsage(m.id);
  const canManage = allowed(auth, 'manageMedia');
  const url = `/api/v1/media/${m.id}/raw`;
  const isImage = m.mimeType.startsWith('image/');

  return c.html(
    <AdminPage title={m.filename} active="media" t={t} {...pageUser(auth)}>
      <div class="top">
        <h1 style="font-size:17px;word-break:break-all">{m.filename}</h1>
        <a class="btn sec" href="/admin/media">{t('media.allMedia')}</a>
      </div>
      <Flash flash={readFlash(c)} />
      <div class="grid g2" style="align-items:start">
        <div class="card">
          {isImage ? (
            <img src={`${url}?v=${encodeURIComponent(m.storageKey.slice(-24))}`} alt={altObj[locales[0] ?? 'en'] ?? ''} style="max-width:100%;border-radius:7px;display:block" />
          ) : (
            <div style="aspect-ratio:2;background:var(--panel2);display:flex;align-items:center;justify-content:center;font-size:48px;color:var(--mut);border-radius:7px">
              {fileIcon(m.mimeType)}
            </div>
          )}
          <dl class="kv" style="margin:14px 0 0;font-size:12px">
            <dt>{t('media.metaType')}</dt><dd>{m.mimeType}</dd>
            <dt>{t('media.metaSize')}</dt><dd>{fmtBytes(m.sizeBytes)}</dd>
            {m.width && m.height ? <><dt>{t('media.metaDimensions')}</dt><dd>{m.width} × {m.height}</dd></> : null}
            <dt>{t('media.metaUploaded')}</dt><dd><DateTime value={m.createdAt} /></dd>
            <dt>{t('media.metaPublicUrl')}</dt>
            <dd>
              <code style="font-size:11px">{url}</code>{' '}
              <button type="button" class="linkbtn" data-copy={url} data-copied={t('common.copied')}>{t('common.copy')}</button>
              {' · '}<a href={url} target="_blank" rel="noopener">{t('media.open')} ↗</a>
            </dd>
          </dl>
        </div>
        <div class="stack">
          <form method="post" action={`/admin/media/${m.id}`} class="card">
            {isImage ? (
              <>
                <h3>{t('media.altText')}</h3>
                <div class="help" style="margin-top:0">{t('media.altHelp')}</div>
                {locales.map((l) => (
                  <>
                    <label for={`alt_${l}`}>{locales.length > 1 ? l.toUpperCase() : t('media.altText')}</label>
                    <input type="text" name={`altText_${l}`} id={`alt_${l}`} value={altObj[l] ?? ''} placeholder={t('media.altPlaceholder')} disabled={!canManage} />
                  </>
                ))}
              </>
            ) : null}
            <label for="filename">{t('media.filename')}</label>
            <input type="text" name="filename" id="filename" value={m.filename} disabled={!canManage} />
            {canManage ? (
              <div style="margin-top:18px;display:flex;gap:8px">
                <button class="btn" type="submit" name="action" value="save">{t('media.save')}</button>
                <button class="btn danger" type="submit" name="action" value="delete" style="margin-left:auto"
                  data-confirm={usage.length > 0 ? t('media.confirmDeleteUsed', { n: usage.length }) : t('media.confirmDelete')}>{t('media.delete')}</button>
              </div>
            ) : null}
          </form>
          {canManage ? (
            <form method="post" action={`/admin/media/${m.id}/replace`} enctype="multipart/form-data" class="card">
              <h3>{t('media.replaceTitle')}</h3>
              <div class="help" style="margin-top:0">{t('media.replaceHelp')}</div>
              <input type="file" name="file" required accept={isImage ? 'image/*' : undefined} style="margin-top:10px" />
              <div style="margin-top:12px">
                <button class="btn sec" type="submit" data-confirm={t('media.confirmReplace')}>{t('media.replaceButton')}</button>
              </div>
            </form>
          ) : null}
          <div class="card">
            <h3>{t('media.usedIn')}</h3>
            {usage.length === 0 ? <div class="muted" style="font-size:13px;margin-top:6px">{t('media.usedNowhere')}</div> : (
              <ul style="margin:8px 0 0;padding-left:18px;font-size:13px">
                {usage.map((u) => (
                  <li><a href={`/admin/content/${u.typeSlug}/${u.id}`}>{u.title}</a> <span class="muted" style="text-transform:uppercase;font-size:11px">{u.locale}</span></li>
                ))}
              </ul>
            )}
          </div>
        </div>
      </div>
    </AdminPage>,
  );
});

adminSite.post('/media/:id{[0-9]+}', async (c) => {
  const auth = gate(c);
  if (notAuth(auth)) return auth;
  const t = getT(c);
  const id = Number(c.req.param('id'));
  if (!allowed(auth, 'manageMedia')) return c.redirect(withFlash(`/admin/media/${id}`, 'err', t('common.noAccess')), 302);
  const existing = await getMedia(id);
  if (!existing) return c.redirect('/admin/media', 302);
  const body = await c.req.parseBody();
  if (body.action === 'delete') {
    await deleteMedia(id);
    void fireEvent('media.deleted', { id }, [`media:${id}`]);
    return c.redirect(withFlash('/admin/media', 'ok', t('media.flashDeleted')), 302);
  }
  const prev = (typeof existing.altText === 'object' && existing.altText !== null ? existing.altText : {}) as Record<string, string>;
  const altText: Record<string, string> = { ...prev };
  for (const l of await getConfiguredLocales()) {
    const v = body[`altText_${l}`];
    if (typeof v === 'string') { if (v.trim()) altText[l] = v.trim(); else delete altText[l]; }
  }
  await updateMedia(id, { altText, filename: String(body.filename ?? '').trim() || undefined });
  invalidate([`media:${id}`]);
  void fireEvent('media.updated', { id }, [`media:${id}`]);
  return c.redirect(withFlash(`/admin/media/${id}`, 'ok', t('content.flashSaved')), 302);
});

adminSite.post('/media/:id{[0-9]+}/replace', async (c) => {
  const auth = gate(c);
  if (notAuth(auth)) return auth;
  const t = getT(c);
  const id = Number(c.req.param('id'));
  const back = `/admin/media/${id}`;
  if (!allowed(auth, 'manageMedia')) return c.redirect(withFlash(back, 'err', t('common.noAccess')), 302);
  const existing = await getMedia(id);
  if (!existing) return c.redirect('/admin/media', 302);
  const file = (await c.req.parseBody()).file;
  if (!file || typeof file === 'string' || file.size === 0) return c.redirect(withFlash(back, 'err', t('media.replaceNoFile')), 302);
  if (file.size > 25 * 1024 * 1024) return c.redirect(withFlash(back, 'err', t('media.tooLarge')), 302);
  // An image stays an image (and a document a document), so pages that embed
  // the file keep working.
  const kind = (mime: string) => (mime.startsWith('image/') ? 'image' : 'file');
  const mimeType = file.type || 'application/octet-stream';
  if (kind(mimeType) !== kind(existing.mimeType)) return c.redirect(withFlash(back, 'err', t('media.replaceWrongKind')), 302);
  await replaceMediaFile(id, { filename: file.name || existing.filename, mimeType, bytes: new Uint8Array(await file.arrayBuffer()) });
  invalidate([`media:${id}`]);
  void fireEvent('media.updated', { id }, [`media:${id}`]);
  return c.redirect(withFlash(back, 'ok', t('media.flashReplaced')), 302);
});

// Multipart upload from the admin (drag-drop, file picker, or the editor).
adminSite.post('/media/upload', async (c) => {
  const auth = gate(c);
  if (notAuth(auth)) return auth;
  const t = getT(c);
  if (!allowed(auth, 'manageMedia')) return c.json({ error: t('common.noAccess') }, 403);
  const body = await c.req.parseBody();
  const file = body.file;
  if (!file || typeof file === 'string') return c.json({ error: 'file required' }, 422);
  if (file.size > 25 * 1024 * 1024) return c.json({ error: t('media.tooLarge') }, 413);
  let altText: Record<string, string> = {};
  try { altText = body.altText ? JSON.parse(String(body.altText)) : {}; }
  catch { altText = {}; }
  const isImage = (file.type || '').startsWith('image/');
  if (isImage && Object.values(altText).filter(Boolean).length === 0) {
    // Never block an upload on alt text: start from the filename, in the
    // site's default language, and let the editor refine it afterwards.
    altText = { [await getDefaultLocale()]: altFromFilename(file.name || 'image') };
  }
  const bytes = new Uint8Array(await file.arrayBuffer());
  const row = await storeMedia({
    filename: file.name || 'upload',
    mimeType: file.type || 'application/octet-stream',
    bytes,
    altText,
    uploadedBy: auth.user.id,
  });
  void fireEvent('media.uploaded', { id: row.id }, [`media:${row.id}`]);
  return c.json({ data: { id: row.id, filename: row.filename, urlRaw: `/api/v1/media/${row.id}/raw`, mimeType: row.mimeType, width: row.width, height: row.height } }, 201);
});

// Picker fragment — loaded into the editor's dialog via fetch + innerHTML.
adminSite.get('/media/picker', async (c) => {
  const auth = gate(c);
  if (notAuth(auth)) return auth;
  const t = getT(c);
  const q = (c.req.query('q') ?? '').trim().slice(0, 100);
  const items = await listMedia({ mimeType: 'image/', ...(q ? { q } : {}), limit: 120 });
  const defaultLocale = await getDefaultLocale();
  const search = "if(event.key==='Enter'){event.preventDefault();var b=document.getElementById('skelpo-picker-body');fetch('/admin/media/picker?q='+encodeURIComponent(this.value),{credentials:'same-origin'}).then(function(r){return r.text()}).then(function(h){b.innerHTML=h;var i=b.querySelector('input[type=search]');if(i)i.focus();})}";
  return c.html(
    <div>
      <style dangerouslySetInnerHTML={{ __html: MEDIA_CSS }} />
      <input type="search" value={q} placeholder={t('media.pickerSearch')} onkeydown={search} style="margin-bottom:4px" />
      {items.length === 0 ? (
        <div class="muted" style="text-align:center;padding:30px;font-size:13px">
          {q ? t('media.emptySearch') : t('media.pickerEmpty')} <a href="/admin/media" target="_blank">{t('media.pickerGoToLibrary')}</a>
        </div>
      ) : (
        <div class="media-grid">
          {items.map((m) => {
            const altObj = (typeof m.altText === 'object' && m.altText ? m.altText : {}) as Record<string, string>;
            const alt = altObj[defaultLocale] ?? Object.values(altObj)[0] ?? '';
            return (
              <button
                type="button"
                class="media-card"
                style="padding:0;font:inherit"
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
// Forms are content rows of type `form`; submissions live in their own
// `formSubmissions` table referencing form.id.

function canSeeForms(auth: AuthContext): boolean {
  return allowed(auth, 'viewSubmissions') || allowed(auth, 'manageForms');
}

adminSite.get('/forms', async (c) => {
  const auth = gate(c);
  if (notAuth(auth)) return auth;
  const t = getT(c);
  if (!canSeeForms(auth)) return forbidden(c, auth, t);
  const canManageForms = allowed(auth, 'manageForms');
  const forms = await query<{ id: number; slug: string; title: string; status: string; locale: string }>(
    "SELECT `id`, `slug`, `title`, `status`, `locale` FROM `content` WHERE `typeSlug` = 'form' AND `locale` = ? AND `status` != 'archived' ORDER BY `title`",
    [await getDefaultLocale()],
  );
  const counts = await query<{ formId: number; total: number; spam: number; latest: unknown }>(
    'SELECT `formId`, COUNT(*) AS total, SUM(`isSpam`) AS spam, MAX(`createdAt`) AS latest FROM `formSubmissions` GROUP BY `formId`',
  );
  const cMap = new Map(counts.map((r) => [r.formId, r]));

  return c.html(
    <AdminPage title={t('forms.title')} active="forms" t={t} {...pageUser(auth)}>
      <div class="top">
        <h1>{t('forms.title')}</h1>
        {canManageForms ? <a class="btn" href="/admin/content/form/new">{t('forms.newForm')}</a> : null}
      </div>
      <Flash flash={readFlash(c)} />
      <div class="card">
        {forms.length === 0 ? (
          <div class="muted" style="text-align:center;padding:30px;font-size:13px;line-height:1.6">
            <div>{canManageForms ? t('forms.emptyManage') : t('forms.emptyNoManage')}</div>
            {canManageForms
              ? <div style="margin-top:10px"><a class="btn" href="/admin/content/form/new">{t('forms.createFirst')}</a></div>
              : <div style="margin-top:10px;font-size:12px">{t('forms.noManageHint')}</div>}
          </div>
        ) : (
          <table>
            <thead>
              <tr>
                <th>{t('forms.colTitle')}</th>
                <th>{t('forms.colStatus')}</th>
                <th>{t('forms.colSubmissions')}</th>
                <th>{t('forms.colLatest')}</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {forms.map((f) => {
                const cnt = cMap.get(f.id);
                const total = Number(cnt?.total ?? 0) - Number(cnt?.spam ?? 0);
                return (
                  <tr>
                    <td><a href={`/admin/forms/${f.slug}`} style="font-weight:600">{f.title}</a></td>
                    <td><StatusBadge status={f.status} t={t} /></td>
                    <td>{total}{Number(cnt?.spam ?? 0) > 0 ? <span class="muted"> · {t('forms.spamCount', { n: Number(cnt?.spam) })}</span> : null}</td>
                    <td class="muted">{cnt?.latest ? <DateTime value={cnt.latest} /> : '—'}</td>
                    <td style="text-align:right">
                      {canManageForms ? <a class="btn sm sec" href={`/admin/content/form/${f.id}`}>{t('forms.editForm')}</a> : null}
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

interface SubmissionRow { id: number; data: unknown; ip: string | null; isSpam: number; createdAt: unknown }

function submissionData(raw: unknown): Record<string, unknown> {
  let v = raw;
  if (typeof v === 'string') { try { v = JSON.parse(v); } catch { return { value: v }; } }
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : { value: v };
}
const cellText = (v: unknown): string => (v === null || v === undefined ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v));

async function findForm(slug: string): Promise<{ id: number; slug: string; title: string } | null> {
  return queryOne<{ id: number; slug: string; title: string }>(
    "SELECT `id`, `slug`, `title` FROM `content` WHERE `typeSlug` = 'form' AND `slug` = ? ORDER BY `id` LIMIT 1", [slug]);
}

adminSite.get('/forms/:slug', async (c) => {
  const auth = gate(c);
  if (notAuth(auth)) return auth;
  const t = getT(c);
  // Submissions carry personal data (names, emails, IPs).
  if (!canSeeForms(auth)) return forbidden(c, auth, t);
  const canManageForms = allowed(auth, 'manageForms');
  const includeSpam = c.req.query('spam') === '1';
  const form = await findForm(c.req.param('slug'));
  if (!form) return c.html(<AdminPage title={t('common.notFound')} t={t} {...pageUser(auth)}><div class="card">{t('forms.notFound')}</div></AdminPage>, 404);

  const subs = await query<SubmissionRow>(
    `SELECT \`id\`, \`data\`, \`ip\`, \`isSpam\`, \`createdAt\` FROM \`formSubmissions\`
      WHERE \`formId\` = ? ${includeSpam ? '' : 'AND `isSpam` = 0'} ORDER BY \`createdAt\` DESC LIMIT 200`,
    [form.id],
  );
  const totalSpam = Number((await queryOne<{ n: number }>(
    'SELECT COUNT(*) AS n FROM `formSubmissions` WHERE `formId` = ? AND `isSpam` = 1', [form.id]))?.n ?? 0);

  return c.html(
    <AdminPage title={form.title} active="forms" t={t} {...pageUser(auth)}>
      <div class="top">
        <h1>{form.title} <span class="muted" style="font-size:14px;font-weight:400">· {t.plural('forms.submissionsCount', subs.length)}</span></h1>
        <div class="toolbar">
          <a class="btn sec" href="/admin/forms">{t('forms.allForms')}</a>
          {subs.length > 0 ? <a class="btn sec" href={`/admin/forms/${form.slug}/export.csv${includeSpam ? '?spam=1' : ''}`}>{t('forms.exportCsv')}</a> : null}
          {canManageForms ? <a class="btn sec" href={`/admin/content/form/${form.id}`}>{t('forms.editForm')}</a> : null}
        </div>
      </div>
      <Flash flash={readFlash(c)} />
      {totalSpam > 0 || includeSpam ? (
        <div class="subtabs">
          <a href={`/admin/forms/${form.slug}`} class={includeSpam ? '' : 'on'}>{t('forms.tabInbox')}</a>
          <a href={`/admin/forms/${form.slug}?spam=1`} class={includeSpam ? 'on' : ''}>{t('forms.tabWithSpam', { n: totalSpam })}</a>
        </div>
      ) : null}
      {subs.length === 0 ? (
        <div class="card muted" style="text-align:center;padding:30px;font-size:13px">{t('forms.noSubmissions')}</div>
      ) : subs.map((s) => {
        const data = submissionData(s.data);
        return (
          <div class="card" style="margin-bottom:10px">
            <div style="display:flex;justify-content:space-between;gap:10px;align-items:center;flex-wrap:wrap;margin-bottom:10px">
              <div class="muted" style="font-size:12px">
                <DateTime value={s.createdAt} />
                {s.isSpam ? <span class="badge b-arch" style="margin-left:8px">{t('forms.badgeSpam')}</span> : null}
              </div>
              {canManageForms ? (
                <form method="post" action={`/admin/forms/${form.slug}/submissions/${s.id}`} class="toolbar" style="margin:0">
                  {includeSpam ? <input type="hidden" name="spam" value="1" /> : null}
                  {s.isSpam
                    ? <button class="btn sm sec" name="action" value="not-spam">{t('forms.notSpam')}</button>
                    : <button class="btn sm sec" name="action" value="mark-spam">{t('forms.markSpam')}</button>}
                  <button class="btn sm danger" name="action" value="delete" data-confirm={t('forms.confirmDeleteSubmission')}>{t('common.delete')}</button>
                </form>
              ) : null}
            </div>
            <dl class="kv">
              {Object.entries(data).map(([k, v]) => (
                <><dt>{k}</dt><dd style="white-space:pre-wrap">{cellText(v) || '—'}</dd></>
              ))}
            </dl>
          </div>
        );
      })}
    </AdminPage>,
  );
});

adminSite.get('/forms/:slug/export.csv', async (c) => {
  const auth = gate(c);
  if (notAuth(auth)) return auth;
  const t = getT(c);
  if (!canSeeForms(auth)) return forbidden(c, auth, t);
  const form = await findForm(c.req.param('slug'));
  if (!form) return c.text('Not found', 404);
  const includeSpam = c.req.query('spam') === '1';
  const subs = await query<SubmissionRow>(
    `SELECT \`id\`, \`data\`, \`ip\`, \`isSpam\`, \`createdAt\` FROM \`formSubmissions\`
      WHERE \`formId\` = ? ${includeSpam ? '' : 'AND `isSpam` = 0'} ORDER BY \`createdAt\` DESC LIMIT 10000`,
    [form.id],
  );
  const rows = subs.map((s) => ({ s, data: submissionData(s.data) }));
  const keys = [...new Set(rows.flatMap((r) => Object.keys(r.data)))];
  // Quote every cell; prefix formula-looking values so spreadsheets don't run them.
  const cell = (v: string): string => `"${(/^[=+\-@\t\r]/.test(v) ? `'${v}` : v).replace(/"/g, '""')}"`;
  const lines = [['received', ...keys, ...(includeSpam ? ['spam'] : [])].map(cell).join(',')];
  for (const { s, data } of rows) {
    lines.push([dateToIso(s.createdAt) ?? '', ...keys.map((k) => cellText(data[k])), ...(includeSpam ? [s.isSpam ? 'yes' : 'no'] : [])].map(cell).join(','));
  }
  c.header('Content-Type', 'text/csv; charset=utf-8');
  c.header('Content-Disposition', `attachment; filename="${form.slug}-submissions.csv"`);
  c.header('Cache-Control', 'no-store');
  return c.body(`﻿${lines.join('\r\n')}\r\n`);
});

adminSite.post('/forms/:slug/submissions/:id{[0-9]+}', async (c) => {
  const auth = gate(c);
  if (notAuth(auth)) return auth;
  const t = getT(c);
  const slug = c.req.param('slug');
  const form = await findForm(slug);
  const body = await c.req.parseBody();
  const back = `/admin/forms/${slug}${body.spam === '1' ? '?spam=1' : ''}`;
  if (!form || !allowed(auth, 'manageForms')) return c.redirect(withFlash(back, 'err', t('common.noAccess')), 302);
  const id = Number(c.req.param('id'));
  if (body.action === 'mark-spam') await execute('UPDATE `formSubmissions` SET `isSpam` = 1 WHERE `id` = ? AND `formId` = ?', [id, form.id]);
  else if (body.action === 'not-spam') await execute('UPDATE `formSubmissions` SET `isSpam` = 0 WHERE `id` = ? AND `formId` = ?', [id, form.id]);
  else if (body.action === 'delete') await execute('DELETE FROM `formSubmissions` WHERE `id` = ? AND `formId` = ?', [id, form.id]);
  return c.redirect(back, 302);
});

// ── Redirects ──────────────────────────────────────────────────────────

adminSite.get('/redirects', async (c) => {
  const auth = gate(c);
  if (notAuth(auth)) return auth;
  const t = getT(c);
  if (!allowed(auth, 'manageRedirects')) return forbidden(c, auth, t);
  const rows = await query<{ id: number; source: string; destination: string; statusCode: number; hitCount: number }>(
    'SELECT `id`,`source`,`destination`,`statusCode`,`hitCount` FROM `redirects` ORDER BY `id` DESC',
  );
  const editId = Number(c.req.query('edit') ?? 0);
  const editing = rows.find((r) => r.id === editId);
  return c.html(
    <AdminPage title={t('redirects.title')} active="redirects" t={t} {...pageUser(auth)}>
      <div class="top"><h1>{t('redirects.title')}</h1></div>
      <Flash flash={readFlash(c)} />
      <div class="card">
        <h3>{editing ? t('redirects.editTitle') : t('redirects.addTitle')}</h3>
        <div class="help" style="margin-top:0">{t('redirects.intro')}</div>
        <form method="post" action="/admin/redirects" class="row" style="gap:8px;align-items:end;flex-wrap:wrap">
          {editing ? <input type="hidden" name="id" value={String(editing.id)} /> : null}
          <div style="flex:1;min-width:160px">
            <label for="source">{t('redirects.source')}</label>
            <input type="text" name="source" id="source" value={editing?.source ?? ''} placeholder={t('redirects.sourcePlaceholder')} required pattern="/.*" />
          </div>
          <div style="flex:1;min-width:160px">
            <label for="destination">{t('redirects.destination')}</label>
            <input type="text" name="destination" id="destination" value={editing?.destination ?? ''} placeholder={t('redirects.destinationPlaceholder')} required />
          </div>
          <div style="width:190px">
            <label for="statusCode">{t('redirects.kind')}</label>
            <select name="statusCode" id="statusCode">
              <option value="301" selected={!editing || editing.statusCode === 301 || editing.statusCode === 308}>{t('redirects.permanent')}</option>
              <option value="302" selected={!!editing && (editing.statusCode === 302 || editing.statusCode === 307)}>{t('redirects.temporary')}</option>
            </select>
          </div>
          <button class="btn" type="submit">{editing ? t('common.save') : t('redirects.add')}</button>
          {editing ? <a class="btn sec" href="/admin/redirects">{t('common.cancel')}</a> : null}
        </form>
      </div>
      <div class="card" style="margin-top:16px">
        {rows.length === 0 ? <div class="muted">{t('redirects.empty')}</div> : (
          <table>
            <thead>
              <tr>
                <th>{t('redirects.colSource')}</th>
                <th>{t('redirects.colDestination')}</th>
                <th>{t('redirects.kind')}</th>
                <th>{t('redirects.colHits')}</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr>
                  <td>{r.source}</td>
                  <td class="muted">{r.destination}</td>
                  <td class="muted">{r.statusCode === 301 || r.statusCode === 308 ? t('redirects.permanent') : t('redirects.temporary')}</td>
                  <td class="muted">{r.hitCount}</td>
                  <td style="text-align:right;white-space:nowrap">
                    <a class="btn sec sm" href={`/admin/redirects?edit=${r.id}`} style="margin-right:6px">{t('common.edit')}</a>
                    <form method="post" action={`/admin/redirects/${r.id}/delete`} style="margin:0;display:inline">
                      <button class="btn danger sm" type="submit" data-confirm={t('redirects.confirmDelete', { source: r.source })}>{t('common.delete')}</button>
                    </form>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </AdminPage>,
  );
});

function redirectsChanged(): void {
  invalidate(['redirects', 'GET:/redirects'], { prefix: true });
  void fireEvent('redirect.updated', {}, ['redirects']);
}

adminSite.post('/redirects', async (c) => {
  const auth = gate(c);
  if (notAuth(auth)) return auth;
  const t = getT(c);
  if (!allowed(auth, 'manageRedirects')) return forbidden(c, auth, t);
  const b = await c.req.parseBody();
  const source = String(b.source ?? '').trim();
  const destination = String(b.destination ?? '').trim();
  const statusCode = Number(b.statusCode) === 302 ? 302 : 301;
  const id = Number(b.id ?? 0);
  if (!source.startsWith('/') || !destination) return c.redirect(withFlash('/admin/redirects', 'err', t('redirects.errInvalid')), 302);
  if (source === destination) return c.redirect(withFlash('/admin/redirects', 'err', t('redirects.errLoop')), 302);
  const clash = await queryOne<{ id: number }>('SELECT `id` FROM `redirects` WHERE `source` = ? AND `id` <> ?', [source, id]);
  if (clash) return c.redirect(withFlash('/admin/redirects', 'err', t('redirects.errExists', { source })), 302);
  if (id) {
    await execute('UPDATE `redirects` SET `source` = ?, `destination` = ?, `statusCode` = ? WHERE `id` = ?', [source, destination, statusCode, id]);
  } else {
    await execute('INSERT INTO `redirects` (`source`,`destination`,`statusCode`) VALUES (?,?,?)', [source, destination, statusCode]);
  }
  redirectsChanged();
  return c.redirect(withFlash('/admin/redirects', 'ok', t('content.flashSaved')), 302);
});

adminSite.post('/redirects/:id{[0-9]+}/delete', async (c) => {
  const auth = gate(c);
  if (notAuth(auth)) return auth;
  const t = getT(c);
  if (!allowed(auth, 'manageRedirects')) return forbidden(c, auth, t);
  await execute('DELETE FROM `redirects` WHERE `id`=?', [Number(c.req.param('id'))]);
  redirectsChanged();
  return c.redirect(withFlash('/admin/redirects', 'ok', t('redirects.flashDeleted')), 302);
});

// ── Menus ──────────────────────────────────────────────────────────────

interface MenuItemRow {
  id: number; parentId: number | null; label: unknown; url: string | null; contentId: number | null;
  target: '_self' | '_blank'; sortOrder: number; contentTitle: string | null; contentType: string | null;
}

const MENU_DND_CSS = `
.drag-handle{cursor:grab;color:var(--mut);margin-right:8px;user-select:none}
tr.dragging{opacity:.4}
tr.drop-before td{box-shadow:inset 0 2px 0 var(--acc)}
tr.drop-after td{box-shadow:inset 0 -2px 0 var(--acc)}
@media (pointer:coarse){.drag-handle{display:none}}
`;

// Rows can be dragged among their siblings (same parent). The new order is
// posted, then the page reloads so nested items follow their parent.
const MENU_DND_SCRIPT = `
(function(){
  var table=document.getElementById('menu-items');if(!table)return;
  var dragged=null;
  function row(e){var r=e.target&&e.target.closest?e.target.closest('tr[data-menu-item]'):null;return r&&table.contains(r)?r:null;}
  function clear(){table.querySelectorAll('.drop-before,.drop-after').forEach(function(r){r.classList.remove('drop-before','drop-after');});}
  function valid(r){return dragged&&r&&r!==dragged&&r.getAttribute('data-parent')===dragged.getAttribute('data-parent');}
  function after(r,e){var b=r.getBoundingClientRect();return e.clientY>b.top+b.height/2;}
  table.addEventListener('dragstart',function(e){
    var r=row(e);if(!r)return;dragged=r;r.classList.add('dragging');
    e.dataTransfer.effectAllowed='move';try{e.dataTransfer.setData('text/plain',r.getAttribute('data-menu-item'));}catch(x){}
  });
  table.addEventListener('dragend',function(){if(dragged)dragged.classList.remove('dragging');dragged=null;clear();});
  table.addEventListener('dragover',function(e){
    var r=row(e);clear();if(!valid(r))return;
    e.preventDefault();e.dataTransfer.dropEffect='move';
    r.classList.add(after(r,e)?'drop-after':'drop-before');
  });
  table.addEventListener('drop',function(e){
    var r=row(e);if(!valid(r))return;e.preventDefault();
    var parent=dragged.getAttribute('data-parent'),moved=dragged.getAttribute('data-menu-item'),target=r.getAttribute('data-menu-item');
    var ids=[];table.querySelectorAll('tr[data-menu-item]').forEach(function(x){
      if(x.getAttribute('data-parent')===parent&&x!==dragged)ids.push(x.getAttribute('data-menu-item'));
    });
    ids.splice(ids.indexOf(target)+(after(r,e)?1:0),0,moved);
    clear();
    fetch(table.getAttribute('data-reorder-url'),{method:'POST',credentials:'same-origin',
      headers:{'Content-Type':'application/x-www-form-urlencoded'},body:'ids='+encodeURIComponent(ids.join(','))})
      .then(function(){location.reload();},function(){location.reload();});
  });
})();
`;

function labelsOf(v: unknown): Record<string, string> {
  if (typeof v === 'string') { try { return JSON.parse(v) as Record<string, string>; } catch { return { en: v }; } }
  return (v && typeof v === 'object' ? v : {}) as Record<string, string>;
}

async function menuItems(menuId: number): Promise<MenuItemRow[]> {
  return query<MenuItemRow>(
    `SELECT mi.\`id\`, mi.\`parentId\`, mi.\`label\`, mi.\`url\`, mi.\`contentId\`, mi.\`target\`, mi.\`sortOrder\`,
            c.\`title\` AS contentTitle, c.\`typeSlug\` AS contentType
       FROM \`menuItems\` mi LEFT JOIN \`content\` c ON c.\`id\` = mi.\`contentId\`
      WHERE mi.\`menuId\` = ? ORDER BY mi.\`sortOrder\`, mi.\`id\``,
    [menuId],
  );
}

function menuChanged(slug: string): void {
  invalidate([`menu:${slug}`], { prefix: true });
  void fireEvent('menu.updated', { slug }, [`menu:${slug}`]);
}

adminSite.get('/menus', async (c) => {
  const auth = gate(c);
  if (notAuth(auth)) return auth;
  const t = getT(c);
  if (!allowed(auth, 'manageMenus')) return forbidden(c, auth, t);
  const menus = await listMenus();
  const sel = c.req.query('m') ?? menus[0]?.slug ?? '';
  const menu = menus.find((m) => m.slug === sel) ?? null;
  const locales = await getConfiguredLocales();
  const defaultLocale = await getDefaultLocale();
  const items = menu ? await menuItems(menu.id) : [];
  const editing = items.find((i) => i.id === Number(c.req.query('edit') ?? 0)) ?? null;
  const editLabels = editing ? labelsOf(editing.label) : {};
  const roots = items.filter((i) => i.parentId === null);
  const childrenOf = (id: number) => items.filter((i) => i.parentId === id);
  const pages = menu ? await query<{ id: number; title: string; typeSlug: string; locale: string }>(
    `SELECT c.\`id\`, c.\`title\`, c.\`typeSlug\`, c.\`locale\` FROM \`content\` c
       JOIN \`contentTypes\` ct ON ct.\`id\` = c.\`typeId\`
      WHERE ct.\`isRoutable\` = 1 AND c.\`status\` != 'archived' AND c.\`locale\` = ?
      ORDER BY c.\`typeSlug\`, c.\`title\` LIMIT 500`,
    [defaultLocale],
  ) : [];
  const typeLabels = new Map((await listTypes()).map((ct) => [ct.slug, ct.labelPlural]));
  const pageGroups = new Map<string, typeof pages>();
  for (const p of pages) {
    if (!pageGroups.has(p.typeSlug)) pageGroups.set(p.typeSlug, []);
    pageGroups.get(p.typeSlug)!.push(p);
  }
  const base = `/admin/menus?m=${encodeURIComponent(sel)}`;

  const itemRow = (i: MenuItemRow, depth: number) => {
    const labels = labelsOf(i.label);
    return (
      <tr draggable="true" data-menu-item={String(i.id)} data-parent={String(i.parentId ?? 0)}>
        <td style={`padding-left:${12 + depth * 24}px`}>
          <span class="drag-handle" title={t('menus.dragHint')} aria-hidden="true">⠿</span>
          {depth > 0 ? <span class="muted">↳ </span> : null}
          <strong>{labels[defaultLocale] ?? Object.values(labels)[0] ?? '—'}</strong>
          {locales.filter((l) => l !== defaultLocale && labels[l]).map((l) => (
            <span class="muted" style="font-size:11px"> · {l.toUpperCase()}: {labels[l]}</span>
          ))}
        </td>
        <td class="muted">
          {i.contentId
            ? (i.contentTitle ? <a href={`/admin/content/${i.contentType}/${i.contentId}`}>{i.contentTitle}</a> : t('menus.contentMissing'))
            : i.url}
          {i.target === '_blank' ? <span class="muted" style="font-size:11px"> ↗</span> : null}
        </td>
        <td style="text-align:right;white-space:nowrap">
          <form method="post" action={`/admin/menus/${sel}/items/${i.id}/move`} style="margin:0;display:inline">
            <button class="btn sec sm" type="submit" name="dir" value="up" title={t('menus.moveUp')} aria-label={t('menus.moveUp')}>↑</button>{' '}
            <button class="btn sec sm" type="submit" name="dir" value="down" title={t('menus.moveDown')} aria-label={t('menus.moveDown')}>↓</button>
          </form>{' '}
          <a class="btn sec sm" href={`${base}&edit=${i.id}#item-form`}>{t('common.edit')}</a>{' '}
          <form method="post" action={`/admin/menus/${sel}/items/${i.id}/delete`} style="margin:0;display:inline">
            <button class="btn danger sm" type="submit" data-confirm={t('menus.confirmDeleteItem')}>{t('common.delete')}</button>
          </form>
        </td>
      </tr>
    );
  };

  return c.html(
    <AdminPage title={t('menus.title')} active="menus" t={t} {...pageUser(auth)}>
      <div class="top"><h1>{t('menus.title')}</h1></div>
      <Flash flash={readFlash(c)} />
      <div class="tabs">
        {menus.map((m) => <a class={m.slug === sel ? 'on' : ''} href={`/admin/menus?m=${m.slug}`}>{m.label}</a>)}
        <a class={!menu ? 'on' : ''} href="/admin/menus?m=_new">{t('menus.newMenu')}</a>
      </div>

      {!menu ? (
        <form method="post" action="/admin/menus" class="card" style="max-width:480px">
          <h3>{t('menus.newMenuTitle')}</h3>
          <label for="menu-label">{t('menus.menuName')}</label>
          <input type="text" name="label" id="menu-label" required maxlength={128} placeholder={t('menus.menuNamePlaceholder')} />
          <div class="help">{t('menus.newMenuHelp')}</div>
          <div style="margin-top:14px"><button class="btn" type="submit">{t('menus.createMenu')}</button></div>
        </form>
      ) : (
        <>
          <div class="card">
            {items.length === 0 ? <div class="muted">{t('menus.empty')}</div> : (
              <table id="menu-items" data-reorder-url={`/admin/menus/${sel}/reorder`}>
                <thead><tr><th>{t('menus.colLabel')}</th><th>{t('menus.colLink')}</th><th></th></tr></thead>
                <tbody>
                  {roots.map((r) => <>{itemRow(r, 0)}{childrenOf(r.id).map((ch) => <>{itemRow(ch, 1)}{childrenOf(ch.id).map((g) => itemRow(g, 2))}</>)}</>)}
                </tbody>
              </table>
            )}
            {items.length > 1 ? <div class="help">{t('menus.dragHelp')}</div> : null}
            <style dangerouslySetInnerHTML={{ __html: MENU_DND_CSS }} />
            <script dangerouslySetInnerHTML={{ __html: MENU_DND_SCRIPT }} />
          </div>
          <form method="post" action={`/admin/menus/${sel}/items`} class="card" style="margin-top:16px" id="item-form">
            <h3>{editing ? t('menus.editItem') : t('menus.addItemTitle')}</h3>
            {editing ? <input type="hidden" name="id" value={String(editing.id)} /> : null}
            <div class="grid" style={`grid-template-columns:repeat(${Math.min(locales.length, 3)},1fr)`}>
              {locales.map((l) => (
                <div>
                  <label for={`label_${l}`}>{locales.length > 1 ? t('menus.labelIn', { locale: l.toUpperCase() }) : t('menus.label')}</label>
                  <input type="text" name={`label_${l}`} id={`label_${l}`} value={editLabels[l] ?? ''} required={l === defaultLocale} maxlength={128} />
                </div>
              ))}
            </div>
            <div class="grid g2">
              <div>
                <label for="contentId">{t('menus.linkToPage')}</label>
                <select name="contentId" id="contentId">
                  <option value="">{t('menus.linkCustom')}</option>
                  {[...pageGroups.entries()].map(([slug, group]) => (
                    <optgroup label={typeLabels.get(slug) ?? slug}>
                      {group.map((p) => <option value={String(p.id)} selected={editing?.contentId === p.id}>{p.title}</option>)}
                    </optgroup>
                  ))}
                </select>
              </div>
              <div>
                <label for="url">{t('menus.customUrl')}</label>
                <input type="text" name="url" id="url" value={editing?.url ?? ''} placeholder={t('menus.urlPlaceholder')} />
              </div>
            </div>
            <div class="help">{t('menus.linkHelp')}</div>
            <div class="grid g2">
              <div>
                <label for="parentId">{t('menus.parent')}</label>
                <select name="parentId" id="parentId">
                  <option value="">{t('menus.parentNone')}</option>
                  {items.filter((i) => i.id !== editing?.id && i.parentId !== editing?.id).map((i) => {
                    const l = labelsOf(i.label);
                    return <option value={String(i.id)} selected={editing?.parentId === i.id}>{i.parentId ? '— ' : ''}{l[defaultLocale] ?? Object.values(l)[0] ?? ''}</option>;
                  })}
                </select>
              </div>
              <div style="display:flex;align-items:flex-end">
                <label class="check"><input type="checkbox" name="newTab" value="1" checked={editing?.target === '_blank'} /> {t('menus.openNewTab')}</label>
              </div>
            </div>
            <div style="margin-top:14px;display:flex;gap:8px">
              <button class="btn" type="submit">{editing ? t('common.save') : t('menus.add')}</button>
              {editing ? <a class="btn sec" href={base}>{t('common.cancel')}</a> : null}
            </div>
          </form>
          {!menu.isBuiltin ? (
            <form method="post" action={`/admin/menus/${sel}/delete`} style="margin-top:16px">
              <button class="btn danger sm" type="submit" data-confirm={t('menus.confirmDeleteMenu', { name: menu.label })}>{t('menus.deleteMenu')}</button>
            </form>
          ) : null}
        </>
      )}
    </AdminPage>,
  );
});

adminSite.post('/menus', async (c) => {
  const auth = gate(c);
  if (notAuth(auth)) return auth;
  const t = getT(c);
  if (!allowed(auth, 'manageMenus')) return forbidden(c, auth, t);
  const label = String((await c.req.parseBody()).label ?? '').trim().slice(0, 128);
  const slug = slugify(label).slice(0, 64);
  if (!label || !slug) return c.redirect(withFlash('/admin/menus?m=_new', 'err', t('menus.errName')), 302);
  if (await getMenuBySlug(slug)) return c.redirect(withFlash('/admin/menus?m=_new', 'err', t('menus.errExists')), 302);
  await createMenu({ slug, label });
  menuChanged(slug);
  return c.redirect(withFlash(`/admin/menus?m=${slug}`, 'ok', t('menus.flashCreated')), 302);
});

adminSite.post('/menus/:slug/delete', async (c) => {
  const auth = gate(c);
  if (notAuth(auth)) return auth;
  const t = getT(c);
  if (!allowed(auth, 'manageMenus')) return forbidden(c, auth, t);
  const slug = c.req.param('slug');
  const ok = await deleteMenu(slug);
  if (ok) menuChanged(slug);
  return c.redirect(withFlash('/admin/menus', ok ? 'ok' : 'err', ok ? t('menus.flashDeleted') : t('menus.errBuiltin')), 302);
});

adminSite.post('/menus/:slug/items', async (c) => {
  const auth = gate(c);
  if (notAuth(auth)) return auth;
  const t = getT(c);
  if (!allowed(auth, 'manageMenus')) return forbidden(c, auth, t);
  const slug = c.req.param('slug');
  const back = `/admin/menus?m=${encodeURIComponent(slug)}`;
  const menu = await getMenuBySlug(slug);
  if (!menu) return c.redirect('/admin/menus', 302);
  const b = await c.req.parseBody();
  const label: Record<string, string> = {};
  for (const l of await getConfiguredLocales()) {
    const v = String(b[`label_${l}`] ?? '').trim();
    if (v) label[l] = v;
  }
  const contentId = Number(b.contentId ?? 0) || null;
  const url = contentId ? null : String(b.url ?? '').trim() || null;
  if (Object.keys(label).length === 0) return c.redirect(withFlash(back, 'err', t('menus.errLabel')), 302);
  if (!contentId && !url) return c.redirect(withFlash(back, 'err', t('menus.errLink')), 302);
  if (url && !/^(\/|#|https?:\/\/|mailto:|tel:)/i.test(url)) return c.redirect(withFlash(back, 'err', t('menus.errUrl')), 302);

  const items = await menuItems(menu.id);
  const id = Number(b.id ?? 0);
  let parentId = Number(b.parentId ?? 0) || null;
  // The parent must be another item of this menu, and never the item itself or one of its children.
  if (parentId && (!items.some((i) => i.id === parentId) || parentId === id || items.find((i) => i.id === parentId)?.parentId === id)) parentId = null;
  const target = b.newTab === '1' ? '_blank' : '_self';
  if (id) {
    if (!items.some((i) => i.id === id)) return c.redirect(back, 302);
    await updateMenuItem(id, { label, url, contentId, parentId, target });
  } else {
    const last = Math.max(0, ...items.filter((i) => i.parentId === parentId).map((i) => i.sortOrder));
    await addMenuItem(slug, { label, url, contentId, parentId, target, sortOrder: last + 10 });
  }
  menuChanged(slug);
  return c.redirect(withFlash(back, 'ok', t('content.flashSaved')), 302);
});

// Drag-and-drop: the new order of one group of siblings, as a comma list of ids.
adminSite.post('/menus/:slug/reorder', async (c) => {
  const auth = gate(c);
  if (notAuth(auth)) return auth;
  if (!allowed(auth, 'manageMenus')) return c.json({ error: 'forbidden' }, 403);
  const slug = c.req.param('slug');
  const menu = await getMenuBySlug(slug);
  if (!menu) return c.json({ error: 'not found' }, 404);
  const ids = String((await c.req.parseBody()).ids ?? '').split(',').map(Number).filter((n) => Number.isInteger(n) && n > 0);
  const items = await menuItems(menu.id);
  const first = items.find((i) => i.id === ids[0]);
  if (!first) return c.json({ error: 'invalid' }, 422);
  const siblings = items.filter((i) => i.parentId === first.parentId);
  // Must be exactly the existing siblings, each once — nothing added, dropped or moved between levels.
  if (ids.length !== siblings.length || new Set(ids).size !== ids.length || !ids.every((id) => siblings.some((sib) => sib.id === id))) {
    return c.json({ error: 'invalid' }, 422);
  }
  for (let n = 0; n < ids.length; n++) {
    await execute('UPDATE `menuItems` SET `sortOrder` = ? WHERE `id` = ?', [(n + 1) * 10, ids[n]]);
  }
  menuChanged(slug);
  return c.json({ ok: true });
});

adminSite.post('/menus/:slug/items/:id{[0-9]+}/move', async (c) => {
  const auth = gate(c);
  if (notAuth(auth)) return auth;
  const t = getT(c);
  if (!allowed(auth, 'manageMenus')) return forbidden(c, auth, t);
  const slug = c.req.param('slug');
  const menu = await getMenuBySlug(slug);
  if (!menu) return c.redirect('/admin/menus', 302);
  const id = Number(c.req.param('id'));
  const dir = String((await c.req.parseBody()).dir ?? '');
  const items = await menuItems(menu.id);
  const me = items.find((i) => i.id === id);
  if (me) {
    const siblings = items.filter((i) => i.parentId === me.parentId);
    const at = siblings.findIndex((i) => i.id === id);
    const to = dir === 'up' ? at - 1 : at + 1;
    if (to >= 0 && to < siblings.length) {
      [siblings[at], siblings[to]] = [siblings[to]!, siblings[at]!];
      for (let n = 0; n < siblings.length; n++) {
        await execute('UPDATE `menuItems` SET `sortOrder` = ? WHERE `id` = ?', [(n + 1) * 10, siblings[n]!.id]);
      }
      menuChanged(slug);
    }
  }
  return c.redirect(`/admin/menus?m=${encodeURIComponent(slug)}`, 302);
});

adminSite.post('/menus/:slug/items/:id{[0-9]+}/delete', async (c) => {
  const auth = gate(c);
  if (notAuth(auth)) return auth;
  const t = getT(c);
  if (!allowed(auth, 'manageMenus')) return forbidden(c, auth, t);
  const slug = c.req.param('slug');
  const menu = await getMenuBySlug(slug);
  const id = Number(c.req.param('id'));
  if (menu && (await menuItems(menu.id)).some((i) => i.id === id)) {
    await deleteMenuItem(id);
    menuChanged(slug);
  }
  return c.redirect(`/admin/menus?m=${encodeURIComponent(slug)}`, 302);
});

// ── Jobs (read-only + retry) ───────────────────────────────────────────

adminSite.get('/jobs', async (c) => {
  const auth = gate(c);
  if (notAuth(auth)) return auth;
  const t = getT(c);
  if (!allowed(auth, 'manageJobs')) return forbidden(c, auth, t);
  const stats = await jobStats();
  const recent = await query<{ id: number; kind: string; status: string; attempts: number; lastError: string | null; createdAt: unknown }>(
    'SELECT `id`,`kind`,`status`,`attempts`,`lastError`,`createdAt` FROM `jobs` ORDER BY `id` DESC LIMIT 50',
  );
  return c.html(
    <AdminPage title={t('jobs.title')} active="jobs" t={t} {...pageUser(auth)}>
      <div class="top">
        <h1>{t('jobs.title')}</h1>
        <span class="muted">{Object.entries(stats).map(([k, v]) => `${k}: ${v}`).join('  ·  ') || t('common.idle')}</span>
      </div>
      <div class="help" style="margin:0 0 14px">{t('jobs.intro')}</div>
      <div class="card">
        <table>
          <thead>
            <tr>
              <th>{t('jobs.colKind')}</th>
              <th>{t('jobs.colStatus')}</th>
              <th>{t('jobs.colAttempts')}</th>
              <th>{t('jobs.colCreated')}</th>
              <th>{t('jobs.colError')}</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {recent.map((j) => (
              <tr>
                <td>{j.kind}</td>
                <td>{j.status}</td>
                <td>{j.attempts}</td>
                <td class="muted"><DateTime value={j.createdAt} /></td>
                <td class="muted" style="max-width:280px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title={j.lastError ?? ''}>{j.lastError ?? ''}</td>
                <td>
                  {j.status === 'failed' || j.status === 'dead' ? (
                    <form method="post" action={`/admin/jobs/${j.id}/retry`} style="margin:0">
                      <button class="btn sec sm" type="submit">{t('jobs.retry')}</button>
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

adminSite.post('/jobs/:id{[0-9]+}/retry', async (c) => {
  const auth = gate(c);
  if (notAuth(auth)) return auth;
  if (!allowed(auth, 'manageJobs')) return c.redirect('/admin', 302);
  await retryJob(Number(c.req.param('id')));
  return c.redirect('/admin/jobs', 302);
});

// ── Webhooks ───────────────────────────────────────────────────────────

const WEBHOOK_EVENT_GROUPS: Array<{ key: string; events: string[] }> = [
  { key: 'content', events: ['content.created', 'content.updated', 'content.published', 'content.unpublished', 'content.deleted'] },
  { key: 'media', events: ['media.uploaded', 'media.updated', 'media.deleted'] },
  { key: 'site', events: ['menu.updated', 'setting.changed', 'redirect.updated', 'form.submitted', 'type.schemaChanged'] },
];
const ALL_WEBHOOK_EVENTS = WEBHOOK_EVENT_GROUPS.flatMap((g) => g.events);
const DEFAULT_WEBHOOK_EVENTS = ['content.created', 'content.updated', 'content.published', 'content.unpublished', 'content.deleted', 'menu.updated', 'setting.changed'];

async function renderWebhooks(c: Context, auth: AuthContext, t: Translator, extra: { secret?: string; flash?: { ok?: string; err?: string } } = {}) {
  const hooks = await listWebhooks();
  const last = await query<{ webhookId: number; succeeded: number; responseStatus: number | null; createdAt: unknown }>(
    `SELECT d.\`webhookId\`, d.\`succeeded\`, d.\`responseStatus\`, d.\`createdAt\` FROM \`webhookDeliveries\` d
       JOIN (SELECT \`webhookId\`, MAX(\`id\`) AS id FROM \`webhookDeliveries\` GROUP BY \`webhookId\`) x ON x.id = d.\`id\``,
  ).catch(() => []);
  const lastBy = new Map(last.map((d) => [d.webhookId, d]));
  return c.html(
    <AdminPage title={t('webhooks.title')} active="webhooks" t={t} {...pageUser(auth)}>
      <div class="top"><h1>{t('webhooks.title')}</h1></div>
      <div class="help" style="margin:0 0 14px">{t('webhooks.intro')}</div>
      <Flash flash={extra.flash ?? readFlash(c)} />
      {extra.secret ? (
        <div class="ok">
          <strong>{t('webhooks.secretTitle')}</strong>
          <code class="secret">{extra.secret}</code>
          <button type="button" class="btn sm sec" data-copy={extra.secret} data-copied={t('common.copied')}>{t('common.copy')}</button>
        </div>
      ) : null}
      <div class="card">
        {hooks.length === 0 ? <div class="muted">{t('webhooks.empty')}</div> : (
          <table>
            <thead>
              <tr>
                <th>{t('webhooks.colUrl')}</th>
                <th>{t('webhooks.colEvents')}</th>
                <th>{t('webhooks.colLast')}</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {hooks.map((h) => {
                const d = lastBy.get(h.id);
                return (
                  <tr>
                    <td style="word-break:break-all">
                      {h.url}
                      {!h.active ? <span class="badge b-draft" style="margin-left:8px">{t('webhooks.paused')}</span> : null}
                    </td>
                    <td class="muted" style="font-size:12px">{h.events.includes('*') ? t('webhooks.allEvents') : h.events.join(', ')}</td>
                    <td class="muted" style="font-size:12px;white-space:nowrap">
                      {d ? (
                        <>
                          <span class={`badge ${d.succeeded ? 'b-pub' : 'b-arch'}`}>{d.succeeded ? t('webhooks.delivered') : t('webhooks.failed')}{d.responseStatus ? ` ${d.responseStatus}` : ''}</span>{' '}
                          <DateTime value={d.createdAt} />
                        </>
                      ) : t('webhooks.neverSent')}
                    </td>
                    <td style="text-align:right;white-space:nowrap">
                      <form method="post" action={`/admin/webhooks/${h.id}/toggle`} style="margin:0;display:inline">
                        <button class="btn sec sm" type="submit">{h.active ? t('webhooks.pause') : t('webhooks.resume')}</button>
                      </form>{' '}
                      <form method="post" action={`/admin/webhooks/${h.id}/delete`} style="margin:0;display:inline">
                        <button class="btn danger sm" type="submit" data-confirm={t('webhooks.confirmDelete')}>{t('common.delete')}</button>
                      </form>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
      <div class="card" style="margin-top:16px">
        <h3>{t('webhooks.addTitle')}</h3>
        <form method="post" action="/admin/webhooks">
          <label for="hook-url">{t('webhooks.url')}</label>
          <input type="url" name="url" id="hook-url" required placeholder={t('webhooks.urlPlaceholder')} />
          <label>{t('webhooks.eventsLabel')}</label>
          {WEBHOOK_EVENT_GROUPS.map((g) => (
            <div style="display:flex;flex-wrap:wrap;gap:2px 18px">
              {g.events.map((e) => (
                <label class="check"><input type="checkbox" name="events" value={e} checked={DEFAULT_WEBHOOK_EVENTS.includes(e)} /> {e}</label>
              ))}
            </div>
          ))}
          <div style="margin-top:14px"><button class="btn" type="submit">{t('webhooks.add')}</button></div>
        </form>
      </div>
    </AdminPage>,
  );
}

adminSite.get('/webhooks', async (c) => {
  const auth = gate(c);
  if (notAuth(auth)) return auth;
  const t = getT(c);
  if (!allowed(auth, 'manageSettings')) return forbidden(c, auth, t);
  return renderWebhooks(c, auth, t);
});

adminSite.post('/webhooks', async (c) => {
  const auth = gate(c);
  if (notAuth(auth)) return auth;
  const t = getT(c);
  if (!allowed(auth, 'manageSettings')) return forbidden(c, auth, t);
  const b = await c.req.parseBody({ all: true });
  const url = String(b.url ?? '').trim();
  const raw = b.events;
  const events = (Array.isArray(raw) ? raw : raw ? [raw] : []).map(String).filter((e) => ALL_WEBHOOK_EVENTS.includes(e));
  if (!url || events.length === 0) return c.redirect(withFlash('/admin/webhooks', 'err', t('webhooks.errInput')), 302);
  try {
    const { secret } = await createWebhook({ url, events });
    // Rendered directly (no redirect) so the secret never lands in a URL or log.
    c.header('Cache-Control', 'no-store');
    return renderWebhooks(c, auth, t, { secret, flash: {} });
  } catch (e) {
    return c.redirect(withFlash('/admin/webhooks', 'err', t('webhooks.errUrl', { reason: e instanceof Error ? e.message : String(e) })), 302);
  }
});

adminSite.post('/webhooks/:id{[0-9]+}/toggle', async (c) => {
  const auth = gate(c);
  if (notAuth(auth)) return auth;
  const t = getT(c);
  if (!allowed(auth, 'manageSettings')) return forbidden(c, auth, t);
  const id = Number(c.req.param('id'));
  const hook = (await listWebhooks()).find((h) => h.id === id);
  if (hook) await updateWebhook(id, { active: !hook.active });
  return c.redirect('/admin/webhooks', 302);
});

adminSite.post('/webhooks/:id{[0-9]+}/delete', async (c) => {
  const auth = gate(c);
  if (notAuth(auth)) return auth;
  const t = getT(c);
  if (!allowed(auth, 'manageSettings')) return forbidden(c, auth, t);
  await deleteWebhook(Number(c.req.param('id')));
  return c.redirect(withFlash('/admin/webhooks', 'ok', t('webhooks.flashDeleted')), 302);
});
