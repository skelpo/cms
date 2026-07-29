// Content create/edit form. Renders an input per field from the content
// type's fieldsSchema, plus title/slug/status/SEO. Submits to admin POST
// handlers that call the writer functions directly (already inside an
// authenticated session — no API round-trip).
//
// v0.1 richtext = HTML textarea (renderTipTap passes HTML strings through).
// A TipTap enhancement layer is a follow-up; the data contract is stable.

import type { FC } from 'hono/jsx';
import type { FieldDef, ContentTypeRow } from '../content/types.js';
import type { ContentDbRow } from '../content/content.js';
import { AdminPage, StatusBadge } from './layout.js';
import { makeT, type Translator } from './i18n/index.js';
import { defaultAdminLocale } from './i18n/locales.js';

function val(fields: Record<string, unknown>, name: string): string {
  const v = fields[name];
  if (v === undefined || v === null) return '';
  if (typeof v === 'object') return JSON.stringify(v, null, 2);
  return String(v);
}

// Gallery values are stored as string[] (URLs). Render as one-per-line.
function galleryStr(v: unknown): string {
  if (Array.isArray(v)) return v.map(String).join('\n');
  return String(v ?? '');
}

// ── RepeaterField: friendly per-item card editor ─────────────────────────
// Storage stays JSON (an array of objects); the UI surfaces inputs only.
// JS-light: a hidden <template> holds the empty row markup, the "+ Add"
// button clones it, and each row has a delete button.

const RepeaterField: FC<{ def: FieldDef; value: string; t: Translator }> = ({ def, value, t }) => {
  const label = (
    <label>
      {def.label ?? def.name}
      {def.required ? <span style="color:var(--err)"> *</span> : null}
      {def.translatable ? <span class="muted" style="font-weight:400"> · {t('editor.i18nTag')}</span> : null}
    </label>
  );
  let items: Record<string, unknown>[] = [];
  try { items = JSON.parse(value) as Record<string, unknown>[]; if (!Array.isArray(items)) items = []; }
  catch { items = []; }

  const subFields = def.repeater?.fields ?? [];
  const repeaterName = `f_${def.name}`;
  // Wrapper class lets the inline JS find this repeater's container.
  return (
    <div>
      {label}
      <div
        class="skelpo-repeater"
        data-name={def.name}
        data-subfields={JSON.stringify(subFields.map((f) => ({ name: f.name, type: f.type, label: f.label ?? f.name })))}
        style="border:1px solid var(--line);border-radius:7px;padding:10px;background:var(--bg)"
      >
        <div class="skelpo-rep-items">
          {items.map((item, i) => (
            <RepeaterItemCard subFields={subFields} item={item} index={i} repeaterName={def.name} t={t} />
          ))}
        </div>
        {/* The hidden value: JSON-encoded array. JS rewrites it on every edit. */}
        <input type="hidden" name={repeaterName} value={JSON.stringify(items)} />
        <button
          type="button"
          class="btn sm sec"
          style="margin-top:8px"
          onclick={`skelpoRepeaterAdd(this.closest('.skelpo-repeater'))`}
        >{t('editor.addItem', { item: def.label?.toLowerCase().replace(/s$/, '') ?? t('editor.item') })}</button>
      </div>
    </div>
  );
};

const RepeaterItemCard: FC<{ subFields: FieldDef[]; item: Record<string, unknown>; index: number; repeaterName: string; t: Translator }> = ({ subFields, item, index, repeaterName, t }) => (
  <div class="skelpo-rep-item" data-index={index} style="background:var(--panel2);border:1px solid var(--line);border-radius:6px;padding:12px;margin-bottom:8px;position:relative">
    <div class="muted" style="font-size:11px;text-transform:uppercase;letter-spacing:0.05em;margin-bottom:8px;display:flex;justify-content:space-between;align-items:center">
      <span>#{index + 1} · {repeaterName}</span>
      <button type="button" class="btn sm sec" style="padding:2px 8px;color:var(--err)"
        onclick={`skelpoRepeaterRemove(this.closest('.skelpo-rep-item'))`}>{t('editor.removeItem')}</button>
    </div>
    {subFields.map((sf) => {
      const v = item[sf.name];
      const dataName = `${repeaterName}__${index}__${sf.name}`;
      if (sf.type === 'textarea') {
        return (
          <div>
            <label>{sf.label ?? sf.name}</label>
            <textarea data-rep-field={sf.name} data-rep-index={index} name={dataName} rows={3}>{String(v ?? '')}</textarea>
          </div>
        );
      }
      if (sf.type === 'boolean') {
        return (
          <div>
            <label>{sf.label ?? sf.name}</label>
            <select data-rep-field={sf.name} data-rep-index={index} name={dataName}>
              <option value="false" selected={v !== true}>No</option>
              <option value="true" selected={v === true}>Yes</option>
            </select>
          </div>
        );
      }
      if (sf.type === 'number') {
        return (
          <div>
            <label>{sf.label ?? sf.name}</label>
            <input type="number" data-rep-field={sf.name} data-rep-index={index} name={dataName} value={String(v ?? '')} />
          </div>
        );
      }
      if (sf.type === 'select') {
        const opts = (sf.validation?.options as string[] | undefined) ?? [];
        return (
          <div>
            <label>{sf.label ?? sf.name}</label>
            <select data-rep-field={sf.name} data-rep-index={index} name={dataName}>
              <option value="">—</option>
              {opts.map((o) => <option value={o} selected={v === o}>{o}</option>)}
            </select>
          </div>
        );
      }
      return (
        <div>
          <label>{sf.label ?? sf.name}</label>
          <input type="text" data-rep-field={sf.name} data-rep-index={index} name={dataName} value={String(v ?? '')} />
        </div>
      );
    })}
  </div>
);

// Init script — injected into the form. Wires EasyMDE, repeater add/remove,
// and a sync-on-submit pass that JSON-encodes repeater state into the
// hidden field so parseContentForm can JSON.parse it.
const FORM_INIT_SCRIPT = `
var I18N=(typeof window!=='undefined'&&window.SKELPO_I18N)||{};
function skelpoRepeaterSerialize(wrap){
  const items=[];
  wrap.querySelectorAll('.skelpo-rep-item').forEach(card=>{
    const obj={};
    card.querySelectorAll('[data-rep-field]').forEach(el=>{
      const k=el.getAttribute('data-rep-field');
      let v=el.value;
      if(el.tagName==='SELECT'){
        if(v==='true')v=true;else if(v==='false')v=false;
      }
      if(el.type==='number')v=v===''?null:Number(v);
      obj[k]=v;
    });
    items.push(obj);
  });
  const hidden=wrap.querySelector('input[type=hidden][name="f_'+wrap.dataset.name+'"]')
    ||wrap.querySelector('input[type=hidden]');
  if(hidden)hidden.value=JSON.stringify(items);
}
function skelpoRepeaterRemove(card){
  const wrap=card.closest('.skelpo-repeater');
  card.remove();
  // Re-index the remaining cards
  wrap.querySelectorAll('.skelpo-rep-item').forEach((c,i)=>{
    c.setAttribute('data-index',i);
    c.querySelector('span').textContent='#'+(i+1)+' · '+wrap.dataset.name;
    c.querySelectorAll('[data-rep-field]').forEach(el=>{
      el.setAttribute('data-rep-index',i);
      el.name='f_'+wrap.dataset.name+'__'+i+'__'+el.getAttribute('data-rep-field');
    });
  });
  skelpoRepeaterSerialize(wrap);
}
function skelpoRepeaterAdd(wrap){
  const subFields=JSON.parse(wrap.dataset.subfields);
  const items=wrap.querySelectorAll('.skelpo-rep-item');
  const i=items.length;
  const card=document.createElement('div');
  card.className='skelpo-rep-item';
  card.setAttribute('data-index',i);
  card.style.cssText='background:var(--panel2);border:1px solid var(--line);border-radius:6px;padding:12px;margin-bottom:8px;position:relative';
  let html='<div class="muted" style="font-size:11px;text-transform:uppercase;letter-spacing:0.05em;margin-bottom:8px;display:flex;justify-content:space-between;align-items:center"><span>#'+(i+1)+' · '+wrap.dataset.name+'</span><button type="button" class="btn sm sec" style="padding:2px 8px;color:var(--err)" onclick="skelpoRepeaterRemove(this.closest(\\'.skelpo-rep-item\\'))">× Remove</button></div>';
  for(const sf of subFields){
    const name='f_'+wrap.dataset.name+'__'+i+'__'+sf.name;
    let input;
    if(sf.type==='textarea')input='<textarea data-rep-field="'+sf.name+'" data-rep-index="'+i+'" name="'+name+'" rows="3"></textarea>';
    else if(sf.type==='boolean')input='<select data-rep-field="'+sf.name+'" data-rep-index="'+i+'" name="'+name+'"><option value="false" selected>No</option><option value="true">Yes</option></select>';
    else if(sf.type==='number')input='<input type="number" data-rep-field="'+sf.name+'" data-rep-index="'+i+'" name="'+name+'" value="">';
    else input='<input type="text" data-rep-field="'+sf.name+'" data-rep-index="'+i+'" name="'+name+'" value="">';
    html+='<div><label>'+(sf.label||sf.name)+'</label>'+input+'</div>';
  }
  card.innerHTML=html;
  wrap.querySelector('.skelpo-rep-items').appendChild(card);
  // Wire change → serialize for the new fields too (handled by delegated listener below)
  skelpoRepeaterSerialize(wrap);
}
// Delegated listener: any change inside a repeater serializes that repeater.
document.addEventListener('change',function(e){
  const wrap=e.target.closest&&e.target.closest('.skelpo-repeater');
  if(wrap)skelpoRepeaterSerialize(wrap);
});
document.addEventListener('input',function(e){
  const wrap=e.target.closest&&e.target.closest('.skelpo-repeater');
  if(wrap)skelpoRepeaterSerialize(wrap);
});
// Final sync on form submit (belt-and-suspenders).
document.addEventListener('submit',function(e){
  document.querySelectorAll('.skelpo-repeater').forEach(skelpoRepeaterSerialize);
});
// EasyMDE upgrade for richtext fields, with media-picker-driven image
// insertion + drag/paste upload.
const _easymdeInstances=[];
function _skelpoUploadFile(file,onUrl,onError){
  const fd=new FormData();
  fd.append('file',file);
  const isImage=(file.type||'').startsWith('image/');
  if(isImage){
    const _p=(I18N.altPrompt||'Alt text for "{file}":').replace('{file}',file.name);
    const alt=prompt(_p,file.name.replace(/\\.[^.]+$/,'').replace(/[-_]/g,' '))||'';
    if(!alt){onError(I18N.altRequired||'Alt text required');return;}
    fd.append('altText',JSON.stringify({en:alt}));
  }
  fetch('/admin/media/upload',{method:'POST',body:fd,credentials:'same-origin'})
    .then(r=>r.ok?r.json():Promise.reject(new Error('HTTP '+r.status)))
    .then(d=>onUrl(d.data.urlRaw,d.data.id))
    .catch(e=>onError(e.message));
}
window.skelpoActiveEasyMDE=null;
document.addEventListener('DOMContentLoaded',function(){
  if(typeof EasyMDE==='undefined')return;
  document.querySelectorAll('textarea[data-easymde="1"]').forEach(function(ta){
    const mde=new EasyMDE({
      element:ta,
      spellChecker:false,
      autoDownloadFontAwesome:true,
      status:['lines','words','cursor'],
      toolbar:[
        'bold','italic','heading','|','quote','unordered-list','ordered-list','|',
        'link',
        {name:'image',action:function(editor){
          window.skelpoActiveEasyMDE=editor;
          skelpoOpenMediaPicker('__easymde__');
        },className:'fa fa-picture-o',title:(I18N.insertImageTitle||'Insert image from media library')},
        'code','|','preview','side-by-side','fullscreen','|','guide',
      ],
      uploadImage:true,
      imageUploadFunction:function(file,onSuccess,onError){
        _skelpoUploadFile(file,onSuccess,onError);
      },
      imagePathAbsolute:true,
    });
    _easymdeInstances.push(mde);
  });
});
// ── Media picker dialog (shared by image fields + EasyMDE) ───────
window.skelpoOpenMediaPicker=function(target){
  let dlg=document.getElementById('skelpo-media-picker');
  if(!dlg){
    dlg=document.createElement('dialog');
    dlg.id='skelpo-media-picker';
    dlg.className='media-dialog';
    dlg.style.maxWidth='760px';dlg.style.width='90%';
    dlg.innerHTML='<div class="media-dialog-inner"><div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px"><strong style="font-size:14px">'+(I18N.pickTitle||'Pick an image')+'</strong><form method="dialog" style="margin:0"><button class="btn sm sec" type="submit">'+(I18N.close||'Close')+'</button></form></div><div id="skelpo-picker-body" class="muted" style="font-size:13px;padding:30px;text-align:center">'+(I18N.loading||'Loading…')+'</div></div>';
    document.body.appendChild(dlg);
  }
  dlg.dataset.target=target;
  document.getElementById('skelpo-picker-body').textContent=(I18N.loading||'Loading…');
  dlg.showModal();
  fetch('/admin/media/picker',{credentials:'same-origin'})
    .then(r=>r.text())
    .then(html=>{document.getElementById('skelpo-picker-body').innerHTML=html;});
};
window.skelpoMediaPick=function(id,url,alt,filename){
  const dlg=document.getElementById('skelpo-media-picker');
  const target=dlg.dataset.target;
  dlg.close();
  if(target==='__easymde__'){
    if(!window.skelpoActiveEasyMDE)return;
    const cm=window.skelpoActiveEasyMDE.codemirror;
    cm.replaceSelection('!['+(alt||filename||'')+']('+url+')');
    window.skelpoActiveEasyMDE=null;
  } else {
    const input=document.querySelector('input[data-skelpo-imgfield-input="'+target+'"]');
    if(input){
      input.value=String(id);
      // Refresh the preview block by replacing its image
      const wrap=input.closest('.skelpo-imgfield');
      const previewSlot=wrap.querySelector('.skelpo-imgfield-preview');
      previewSlot.innerHTML='<img src="'+url+'" alt="" style="width:100%;height:100%;object-fit:cover;display:block">';
      wrap.querySelector('.muted').textContent=(I18N.mediaRef||'Media #{id}').replace('{id}',id);
    }
  }
};
window.skelpoClearMediaField=function(name){
  const input=document.querySelector('input[data-skelpo-imgfield-input="'+name+'"]');
  if(!input)return;
  input.value='';
  const wrap=input.closest('.skelpo-imgfield');
  wrap.querySelector('.skelpo-imgfield-preview').innerHTML='<span class="muted" style="font-size:11px">'+(I18N.noImage||'no image')+'</span>';
  wrap.querySelector('.muted').textContent=(I18N.noImageSelected||'No image selected');
};
`;

const Field: FC<{ def: FieldDef; value: string; t: Translator }> = ({ def, value, t }) => {
  const name = `f_${def.name}`;
  const label = (
    <label>
      {def.label ?? def.name}
      {def.required ? <span style="color:var(--err)"> *</span> : null}
      {def.translatable ? <span class="muted" style="font-weight:400"> · {t('editor.i18nTag')}</span> : null}
    </label>
  );
  switch (def.type) {
    case 'richtext':
      // EasyMDE-enhanced markdown editor. JS upgrade happens in
      // mountEasyMDE() at the bottom of the form (init script).
      return (
        <div>
          {label}
          <textarea name={name} rows={14} data-easymde="1" placeholder={t('editor.markdownPlaceholder')}>{value}</textarea>
        </div>
      );
    case 'textarea':
      return (
        <div>
          {label}
          <textarea name={name} rows={6}>{value}</textarea>
        </div>
      );
    case 'gallery':
      return (
        <div>
          {label}
          <textarea name={name} rows={6} placeholder={t('editor.galleryPlaceholder')}>
            {/* `value` arrives JSON-stringified from val(); re-render as URL list. */}
            {(() => { try { const arr = JSON.parse(value); return Array.isArray(arr) ? arr.join('\n') : value; } catch { return value; } })()}
          </textarea>
        </div>
      );
    case 'json':
      return (
        <div>
          {label}
          <textarea name={name} rows={6}>{value}</textarea>
        </div>
      );
    case 'repeater':
      // Render a friendly per-item card editor (no JSON visible to users).
      return <RepeaterField def={def} value={value} t={t} />;
    case 'boolean':
      return (
        <div>
          {label}
          <select name={name}>
            <option value="false" selected={value !== 'true'}>
              {t('common.no')}
            </option>
            <option value="true" selected={value === 'true'}>
              {t('common.yes')}
            </option>
          </select>
        </div>
      );
    case 'select':
    case 'multiselect': {
      const opts = (def.validation?.options as string[] | undefined) ?? [];
      return (
        <div>
          {label}
          <select name={name} multiple={def.type === 'multiselect'}>
            {def.type === 'select' ? <option value="">—</option> : null}
            {opts.map((o) => (
              <option value={o} selected={value.includes(o)}>
                {o}
              </option>
            ))}
          </select>
        </div>
      );
    }
    case 'number':
      return (
        <div>
          {label}
          <input type="number" name={name} value={value} />
        </div>
      );
    case 'boolean' as never:
      return null;
    case 'date':
      return (
        <div>
          {label}
          <input type="date" name={name} value={value} />
        </div>
      );
    case 'datetime':
      return (
        <div>
          {label}
          <input type="datetime-local" name={name} value={value} />
        </div>
      );
    case 'image':
    case 'file':
      // Stored as media id (numeric). UI shows a thumbnail + Pick button
      // that opens the shared media picker; the user never sees the id.
      return (
        <div>
          {label}
          <div class="skelpo-imgfield" data-name={def.name} style="display:flex;gap:14px;align-items:flex-start;background:var(--panel2);border:1px solid var(--line);border-radius:7px;padding:12px">
            <div class="skelpo-imgfield-preview" style="width:96px;height:96px;background:var(--bg);border:1px solid var(--line);border-radius:6px;display:flex;align-items:center;justify-content:center;overflow:hidden;flex-shrink:0">
              {value ? (
                <img src={`/api/v1/media/${value}/raw`} alt="" style="width:100%;height:100%;object-fit:cover;display:block" />
              ) : (
                <span class="muted" style="font-size:11px">{t('editor.noImage')}</span>
              )}
            </div>
            <div style="flex:1;min-width:0">
              <div class="muted" style="font-size:11px;margin-bottom:8px">{value ? t('editor.mediaRef', { id: value }) : t('editor.noImageSelected')}</div>
              <div style="display:flex;gap:6px;flex-wrap:wrap">
                <button type="button" class="btn sm" onclick={`skelpoOpenMediaPicker('${def.name}')`}>
                  {value ? t('editor.change') : t('editor.pickImage')}
                </button>
                {value ? (
                  <button type="button" class="btn sm sec" onclick={`skelpoClearMediaField('${def.name}')`}>{t('editor.clear')}</button>
                ) : null}
              </div>
              <input type="hidden" name={name} value={value} data-skelpo-imgfield-input={def.name} />
            </div>
          </div>
        </div>
      );
    case 'relation':
      return (
        <div>
          {label}
          <input
            type="text"
            name={name}
            value={value}
            placeholder={t('editor.relationPlaceholder')}
          />
        </div>
      );
    default:
      return (
        <div>
          {label}
          <input type="text" name={name} value={value} />
        </div>
      );
  }
};

export interface TranslationSibling { id: number; locale: string; status: string }

export const ContentForm: FC<{
  type: ContentTypeRow;
  row?: ContentDbRow | null;
  fields: Record<string, unknown>;
  seo: Record<string, unknown>;
  user: { displayName: string; roleSlug?: string };
  caps?: import('../auth/users.js').RoleCapabilities;
  flash?: { ok?: string; err?: string };
  /** Existing translations of this row, by locale. Used to render locale tabs. */
  siblings?: TranslationSibling[];
  /** All locales configured on site.locales (for empty-tab "add translation" affordance). */
  availableLocales?: string[];
  /** When creating a new translation, the source row id to link the group. */
  translationOf?: number;
  /** Default values when creating (pre-populated from source row when adding a translation). */
  defaultTitle?: string;
  defaultSlug?: string;
  defaultLocale?: string;
  /** Request translator (falls back to English). */
  t?: Translator;
}> = ({
  type, row, fields, seo, user, caps, flash,
  siblings, availableLocales, translationOf, defaultTitle, defaultSlug, defaultLocale, t,
}) => {
  const tr = t ?? makeT(defaultAdminLocale);
  const isNew = !row;
  const action = isNew
    ? `/admin/content/${type.slug}`
    : `/admin/content/${type.slug}/${row!.id}`;

  const currentLocale = row?.locale ?? defaultLocale ?? 'en';
  const siblingMap = new Map((siblings ?? []).map((s) => [s.locale, s]));
  const allLocales = (availableLocales ?? []).length > 0 ? availableLocales! : [currentLocale];
  // Show tabs whenever multiple locales are configured on the site — even
  // for rows with no siblings yet, so the user can click "+ de" etc. to
  // add a new translation.
  const showTabs = !isNew && allLocales.length > 1;

  // Strings the inline form JS needs (alt-text prompts, media picker chrome).
  const jsI18n = {
    altPrompt: tr('editor.altPrompt'),
    altRequired: tr('editor.altRequired'),
    insertImageTitle: tr('editor.insertImageTitle'),
    pickTitle: tr('media.pickTitle'),
    close: tr('media.close'),
    loading: tr('media.loading'),
    mediaRef: tr('editor.mediaRef'),
    noImage: tr('editor.noImage'),
    noImageSelected: tr('editor.noImageSelected'),
  };

  return (
    <AdminPage
      title={isNew ? tr('editor.newTitle', { label: type.labelSingular }) : row!.title}
      active={type.slug}
      t={tr}
      user={user}
      caps={caps}
    >
      {/* EasyMDE for richtext fields + repeater add/remove + form serialize. */}
      <link rel="stylesheet" href="/admin/static/easymde/easymde.min.css" />
      <script src="/admin/static/easymde/easymde.min.js"></script>
      <script dangerouslySetInnerHTML={{ __html: `window.SKELPO_I18N=${JSON.stringify(jsI18n)};` }} />
      <script dangerouslySetInnerHTML={{ __html: FORM_INIT_SCRIPT }} />
      <div class="top">
        <h1>
          {isNew ? tr('editor.newTitle', { label: type.labelSingular }) : tr('editor.editTitle', { title: row!.title })}{' '}
          {row ? <StatusBadge status={row.status} t={tr} /> : null}
        </h1>
        <a class="btn sec" href={`/admin/content/${type.slug}`}>
          {tr('common.back')}
        </a>
      </div>
      {flash?.ok ? <div class="ok">{flash.ok}</div> : null}
      {flash?.err ? <div class="err">{flash.err}</div> : null}
      {showTabs ? (
        <div class="card" style="margin-bottom:14px;padding:8px 12px">
          <div style="display:flex;align-items:center;gap:2px;flex-wrap:wrap;font-size:13px">
            <span class="muted" style="margin-right:8px">{tr('editor.translations')}</span>
            {allLocales.map((l) => {
              const sib = siblingMap.get(l);
              const isActive = l === currentLocale;
              const baseStyle = `padding:5px 12px;border-radius:4px;text-decoration:none;border:1px solid transparent;`;
              if (isActive) {
                return (
                  <span style={`${baseStyle}background:var(--accent,#fbbf24);color:#000;font-weight:600;text-transform:uppercase;font-size:11px;letter-spacing:0.5px`}>
                    {l}
                  </span>
                );
              }
              if (sib) {
                return (
                  <a
                    href={`/admin/content/${type.slug}/${sib.id}`}
                    style={`${baseStyle}color:#ccc;text-transform:uppercase;font-size:11px;letter-spacing:0.5px`}
                    title={tr('editor.translationStatus', { status: sib.status, locale: l })}
                  >
                    {l}
                  </a>
                );
              }
              // Empty locale — link to new-translation form. Source is the
              // currently-edited row (so the writer can grab translationGroupId).
              const newHref = row
                ? `/admin/content/${type.slug}/new?translationOf=${row.id}&locale=${l}`
                : translationOf
                  ? `/admin/content/${type.slug}/new?translationOf=${translationOf}&locale=${l}`
                  : null;
              return newHref ? (
                <a
                  href={newHref}
                  style={`${baseStyle}color:#666;text-transform:uppercase;font-size:11px;letter-spacing:0.5px;border-color:#333;border-style:dashed`}
                  title={tr('editor.addTranslation', { locale: l })}
                >
                  + {l}
                </a>
              ) : null;
            })}
          </div>
        </div>
      ) : null}
      <form method="post" action={action}>
        {translationOf ? <input type="hidden" name="translationOf" value={String(translationOf)} /> : null}
        <div class="grid g2" style="align-items:start">
          <div class="card">
            <label>
              {tr('editor.title')}<span style="color:var(--err)"> *</span>
            </label>
            <input type="text" name="title" value={row?.title ?? defaultTitle ?? ''} required />
            <label>
              {tr('editor.slug')}<span style="color:var(--err)"> *</span>
            </label>
            <input
              type="text"
              name="slug"
              value={row?.slug ?? defaultSlug ?? ''}
              required
              placeholder={tr('editor.slugPlaceholder')}
            />
            <label>{tr('editor.locale')}</label>
            <input type="text" name="locale" value={row?.locale ?? defaultLocale ?? 'en'} />
            {type.fieldsSchema.fields.map((def) => (
              <Field def={def} value={val(fields, def.name)} t={tr} />
            ))}
          </div>
          <div class="card">
            <h3 style="margin-top:0">{tr('editor.seoTitle')}</h3>
            <label>{tr('editor.metaDescription')}</label>
            <textarea name="seo_metaDescription" rows={3}>
              {String(seo.metaDescription ?? '')}
            </textarea>
            <label>{tr('editor.metaTitle')}</label>
            <input type="text" name="seo_metaTitle" value={String(seo.metaTitle ?? '')} />
            <label>{tr('editor.ogImage')}</label>
            <input type="text" name="seo_ogImage" value={String(seo.ogImage ?? '')} />
            <label>{tr('editor.schemaType')}</label>
            <input type="text" name="seo_schemaType" value={String(seo.schemaType ?? '')} />
            <label>{tr('editor.noindex')}</label>
            <select name="seo_noindex">
              <option value="false" selected={seo.noindex !== true}>
                {tr('common.no')}
              </option>
              <option value="true" selected={seo.noindex === true}>
                {tr('common.yes')}
              </option>
            </select>
            <label>{tr('editor.aiSummary')}</label>
            <textarea name="ai_summary" rows={3}>
              {''}
            </textarea>
            <div style="margin-top:18px;display:flex;gap:8px;flex-wrap:wrap">
              <button class="btn" type="submit" name="action" value="save">
                {tr('editor.save')}
              </button>
              {row && row.status !== 'published' ? (
                <button class="btn" type="submit" name="action" value="publish">
                  {tr('editor.savePublish')}
                </button>
              ) : null}
              {row && row.status === 'published' ? (
                <button class="btn sec" type="submit" name="action" value="unpublish">
                  {tr('editor.unpublish')}
                </button>
              ) : null}
              {row ? (
                <button
                  class="btn sec"
                  type="submit"
                  name="action"
                  value="delete"
                  style="margin-left:auto;color:var(--err)"
                >
                  {tr('editor.delete')}
                </button>
              ) : null}
            </div>
          </div>
        </div>
      </form>
    </AdminPage>
  );
};

/**
 * Reconstruct fields/seo/ai objects from the posted form body, coercing
 * by the type schema (booleans, numbers, JSON, relation id arrays).
 */
export function parseContentForm(
  body: Record<string, string | File>,
  schema: FieldDef[],
): {
  title: string;
  slug: string;
  locale: string;
  fields: Record<string, unknown>;
  seo: Record<string, unknown>;
  ai: Record<string, unknown>;
  action: string;
  translationOf?: number;
} {
  const get = (k: string): string => String(body[k] ?? '');
  const fields: Record<string, unknown> = {};
  for (const def of schema) {
    const raw = get(`f_${def.name}`);
    if (raw === '' && !def.required) continue;
    switch (def.type) {
      case 'number':
        fields[def.name] = raw === '' ? null : Number(raw);
        break;
      case 'boolean':
        fields[def.name] = raw === 'true';
        break;
      case 'json':
      case 'repeater':
        try {
          fields[def.name] = raw ? JSON.parse(raw) : (def.type === 'repeater' ? [] : {});
        } catch {
          fields[def.name] = raw;
        }
        break;
      case 'gallery':
        // Gallery is one URL per line; split + trim + drop blanks.
        fields[def.name] = raw.split('\n').map((s) => s.trim()).filter(Boolean);
        break;
      case 'relation':
        fields[def.name] = raw
          .split(',')
          .map((s) => Number(s.trim()))
          .filter((n) => Number.isFinite(n));
        break;
      case 'multiselect':
        fields[def.name] = raw ? raw.split(',').map((s) => s.trim()) : [];
        break;
      default:
        fields[def.name] = raw;
    }
  }
  return {
    title: get('title'),
    slug: get('slug'),
    locale: get('locale') || 'en',
    fields,
    seo: {
      metaDescription: get('seo_metaDescription'),
      metaTitle: get('seo_metaTitle') || undefined,
      ogImage: get('seo_ogImage') ? Number(get('seo_ogImage')) : undefined,
      schemaType: get('seo_schemaType') || undefined,
      noindex: get('seo_noindex') === 'true',
    },
    ai: { summary: get('ai_summary') || undefined },
    action: get('action') || 'save',
    translationOf: get('translationOf') ? Number(get('translationOf')) : undefined,
  };
}
