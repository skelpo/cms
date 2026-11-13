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
import { dateToIso } from '../db/datetime.js';
import { DateTime } from './helpers.js';

/** HTML drops one newline right after <textarea>; double it so text that
 *  really starts with a blank line survives an open-and-save round trip. */
const ta = (v: string): string => (v.startsWith('\n') ? `\n${v}` : v);

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
/** Media-picker dialog + field wiring. Shared by the content editor and the
 *  settings screens, so image ids never have to be typed by hand. */
export const MEDIA_PICKER_SCRIPT = `
var I18N=(typeof window!=='undefined'&&window.SKELPO_I18N)||{};
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
  if(target==='__tui__'){
    if(window.skelpoActiveTui)window.skelpoActiveTui.exec('addImage',{imageUrl:url,altText:alt||filename||''});
    window.skelpoActiveTui=null;
  } else if(target==='__easymde__'){
    if(!window.skelpoActiveEasyMDE)return;
    const cm=window.skelpoActiveEasyMDE.codemirror;
    cm.replaceSelection('!['+(alt||filename||'')+']('+url+')');
    window.skelpoActiveEasyMDE=null;
  } else if(target.indexOf('__gallery__')===0){
    const ta=document.querySelector('textarea[name="'+target.slice(11)+'"]');
    if(ta){ta.value=(ta.value.trim()?ta.value.trim()+'\\n':'')+url;if(window.skelpoMarkDirty)window.skelpoMarkDirty();}
  } else {
    const input=document.querySelector('input[data-skelpo-imgfield-input="'+target+'"]');
    if(input){
      input.value=String(id);
      if(window.skelpoMarkDirty)window.skelpoMarkDirty();
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
  if(window.skelpoMarkDirty)window.skelpoMarkDirty();
  const wrap=input.closest('.skelpo-imgfield');
  wrap.querySelector('.skelpo-imgfield-preview').innerHTML='<span class="muted" style="font-size:11px">'+(I18N.noImage||'no image')+'</span>';
  wrap.querySelector('.muted').textContent=(I18N.noImageSelected||'No image selected');
};
`;

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
  let html='<div class="muted" style="font-size:11px;text-transform:uppercase;letter-spacing:0.05em;margin-bottom:8px;display:flex;justify-content:space-between;align-items:center"><span>#'+(i+1)+' · '+wrap.dataset.name+'</span><button type="button" class="btn sm sec" style="padding:2px 8px;color:var(--err)" onclick="skelpoRepeaterRemove(this.closest(\\'.skelpo-rep-item\\'))">'+(I18N.removeItem||'× Remove')+'</button></div>';
  for(const sf of subFields){
    const name='f_'+wrap.dataset.name+'__'+i+'__'+sf.name;
    let input;
    if(sf.type==='textarea')input='<textarea data-rep-field="'+sf.name+'" data-rep-index="'+i+'" name="'+name+'" rows="3"></textarea>';
    else if(sf.type==='boolean')input='<select data-rep-field="'+sf.name+'" data-rep-index="'+i+'" name="'+name+'"><option value="false" selected>'+(I18N.no||'No')+'</option><option value="true">'+(I18N.yes||'Yes')+'</option></select>';
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

// ── Editor niceties: slug from title, live counters, local date pickers ──
function skelpoSlugify(s){
  return s.normalize('NFKD').replace(/[\\u0300-\\u036f]/g,'').replace(/ß/g,'ss').toLowerCase()
    .replace(/[^a-z0-9]+/g,'-').replace(/^-+|-+$/g,'').slice(0,75).replace(/-+$/g,'');
}
function skelpoPad(n){return String(n).padStart(2,'0');}
function skelpoToLocalInput(iso){
  var d=new Date(iso);if(isNaN(d))return '';
  return d.getFullYear()+'-'+skelpoPad(d.getMonth()+1)+'-'+skelpoPad(d.getDate())+'T'+skelpoPad(d.getHours())+':'+skelpoPad(d.getMinutes());
}
document.addEventListener('DOMContentLoaded',function(){
  var title=document.getElementById('title'),slug=document.getElementById('slug');
  var preview=document.querySelector('[data-slug-preview]');
  function showSlug(){if(preview)preview.textContent=slug.value;}
  if(title&&slug){
    title.addEventListener('input',function(){
      if(slug.getAttribute('data-auto')==='1'){slug.value=skelpoSlugify(title.value);showSlug();}
    });
    slug.addEventListener('input',function(){slug.setAttribute('data-auto','0');showSlug();});
    slug.addEventListener('blur',function(){slug.value=skelpoSlugify(slug.value);showSlug();});
  }
  document.querySelectorAll('[data-count]').forEach(function(el){
    var out=document.querySelector('[data-counter-for="'+el.id+'"]');if(!out)return;
    var min=Number(el.getAttribute('data-min')||0),max=Number(el.getAttribute('data-max')||0);
    function upd(){
      var n=el.value.trim().length;
      out.textContent=n+(max?' / '+max:'');
      var bad=(max&&n>max)||(min&&n>0&&n<min);
      out.className='counter'+(bad?' bad':(n>0?' good':''));
    }
    el.addEventListener('input',upd);upd();
  });
  var pubBtn=document.querySelector('[data-publish-btn]');
  document.querySelectorAll('input[data-utc-target]').forEach(function(el){
    var hidden=document.querySelector('input[type=hidden][name="'+el.getAttribute('data-utc-target')+'"]');
    var iso=el.getAttribute('data-utc');if(iso)el.value=skelpoToLocalInput(iso);
    function sync(){
      var d=el.value?new Date(el.value):null;
      if(hidden)hidden.value=d&&!isNaN(d)?d.toISOString():'';
      if(pubBtn&&el.hasAttribute('data-schedule')){
        pubBtn.textContent=d&&!isNaN(d)&&d.getTime()>Date.now()?(I18N.schedule||'Schedule'):(I18N.publish||'Publish');
      }
    }
    el.addEventListener('input',sync);el.addEventListener('change',sync);sync();
  });
});
// EasyMDE upgrade for richtext fields, with media-picker-driven image
// insertion + drag/paste upload.
const _easymdeInstances=[];
function _skelpoUploadFile(file,onUrl,onError){
  const fd=new FormData();
  fd.append('file',file);
  const isImage=(file.type||'').startsWith('image/');
  if(isImage){
    // Alt text starts as a readable version of the filename; edit it in Media.
    const alt=file.name.replace(/\\.[^.]+$/,'').replace(/[-_]+/g,' ').trim()||'image';
    fd.append('altText',JSON.stringify({en:alt}));
  }
  fetch('/admin/media/upload',{method:'POST',body:fd,credentials:'same-origin'})
    .then(r=>r.ok?r.json():Promise.reject(new Error('HTTP '+r.status)))
    .then(d=>onUrl(d.data.urlRaw,d.data.id))
    .catch(e=>onError(e.message));
}
window.skelpoActiveEasyMDE=null;
window.skelpoActiveTui=null;
// ── Body editor: Markdown (EasyMDE) with an optional visual mode ──
// The stored value is always Markdown. Visual mode edits the same text
// through a WYSIWYG surface and only rewrites it when something changed.
var _skelpoRich=[];
var RT_KEY='skelpoEditorMode';
function skelpoRtPref(){try{return localStorage.getItem(RT_KEY)||'visual';}catch(e){return 'visual';}}
// Markdown the visual editor cannot represent faithfully (raw HTML, MDX,
// footnotes, forced line breaks) stays in Markdown mode so nothing is lost.
function skelpoRtUnsafe(md){
  var plain=md.replace(/(^|\\n)(\\x60\\x60\\x60|~~~)[\\s\\S]*?\\n\\2[^\\n]*/g,'$1').replace(/\\x60[^\\x60\\n]*\\x60/g,'');
  return /<\\/?[A-Za-z][A-Za-z0-9-]*(\\s[^>]*)?\\/?>/.test(plain)||/<!--/.test(plain)
    ||/(^|\\n)(import|export)\\s/.test(plain)||/\\[\\^[^\\]]+\\]/.test(plain)
    ||/(  |\\\\)\\n(?!\\n|$)/.test(plain);
}
function skelpoLoadTui(cb){
  if(window.toastui&&window.toastui.Editor){cb();return;}
  if(window._skelpoTuiWaiting){window._skelpoTuiWaiting.push(cb);return;}
  window._skelpoTuiWaiting=[cb];
  ['toastui-editor.min.css','toastui-editor-dark.css'].forEach(function(f){
    var l=document.createElement('link');l.rel='stylesheet';l.href='/admin/static/tui/'+f;document.head.appendChild(l);
  });
  var sc=document.createElement('script');sc.src='/admin/static/tui/toastui-editor-all.min.js';
  sc.onload=function(){var w=window._skelpoTuiWaiting;window._skelpoTuiWaiting=null;w.forEach(function(f){f();});};
  sc.onerror=function(){window._skelpoTuiWaiting=null;};
  document.head.appendChild(sc);
}
function skelpoRtButtons(f){
  if(!f.modes)return;
  f.modes.querySelectorAll('[data-rt-mode]').forEach(function(b){
    b.classList.toggle('on',b.getAttribute('data-rt-mode')===f.mode);
  });
}
function skelpoRtWrite(f,v){
  if(f.mde.value()===v)return;
  f.mde.value(v);
  if(window.skelpoMarkDirty)window.skelpoMarkDirty();
}
function skelpoRtSetMode(f,mode){
  var note=f.modes?f.modes.querySelector('[data-rt-note]'):null;
  if(note)note.hidden=true;
  if(mode==='visual'){
    if(skelpoRtUnsafe(f.mde.value())){
      if(note)note.hidden=false;
      mode='markdown';
    }
  }
  if(mode==='visual'){
    if(f.tui)return;
    f.mode='visual';skelpoRtButtons(f);
    skelpoLoadTui(function(){
      if(f.mode!=='visual'||f.tui)return;
      f.original=f.mde.value();
      f.wrap.style.display='none';f.host.style.display='';
      var imgBtn=document.createElement('button');
      imgBtn.type='button';imgBtn.className='toastui-editor-toolbar-icons image';imgBtn.style.margin='0';
      imgBtn.setAttribute('aria-label',I18N.insertImageTitle||'Insert image');
      imgBtn.addEventListener('click',function(){window.skelpoActiveTui=f.tui;skelpoOpenMediaPicker('__tui__');});
      f.tui=new toastui.Editor({
        el:f.host,initialEditType:'wysiwyg',hideModeSwitch:true,usageStatistics:false,autofocus:false,
        height:'520px',initialValue:f.original,
        theme:document.documentElement.getAttribute('data-theme')==='light'?'light':'dark',
        toolbarItems:[['heading','bold','italic'],['ul','ol'],
          ['link',{el:imgBtn,name:'skelpoImage',tooltip:I18N.insertImageTitle||'Insert image'}],['quote','hr','table'],['strike','code','codeblock']],
        hooks:{addImageBlobHook:function(blob,cb){
          _skelpoUploadFile(blob,function(url){cb(url,(blob.name||'').replace(/\\.[^.]+$/,'').replace(/[-_]+/g,' '));},function(m){alert(m);});
        }},
      });
      f.baseline=f.tui.getMarkdown();
      f.tui.on('change',function(){
        if(!f.tui)return;
        var md=f.tui.getMarkdown();
        // Back at the starting point → keep the text exactly as it was stored.
        skelpoRtWrite(f,md===f.baseline?f.original:md);
      });
    });
    return;
  }
  f.mode='markdown';skelpoRtButtons(f);
  if(f.tui){try{f.tui.destroy();}catch(e){}f.tui=null;f.host.innerHTML='';}
  f.host.style.display='none';f.wrap.style.display='';
  f.mde.codemirror.refresh();
}
// Used by draft restore: put a value into a body field whatever mode it is in.
window.skelpoSetRich=function(ta,v){
  for(var i=0;i<_skelpoRich.length;i++){
    var f=_skelpoRich[i];if(f.ta!==ta)continue;
    f.mde.value(v);
    if(f.tui){
      if(skelpoRtUnsafe(v)){skelpoRtSetMode(f,'markdown');}
      else{f.original=v;f.tui.setMarkdown(v,false);f.baseline=f.tui.getMarkdown();f.mde.value(v);}
    }
    return true;
  }
  return false;
};
document.addEventListener('DOMContentLoaded',function(){
  if(typeof EasyMDE==='undefined')return;
  document.querySelectorAll('textarea[data-easymde="1"]').forEach(function(ta){
    const mde=new EasyMDE({
      element:ta,
      spellChecker:false,
      forceSync:true,
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
    mde.codemirror.on('change',function(cm,ch){if(ch&&ch.origin!=='setValue'&&window.skelpoMarkDirty)window.skelpoMarkDirty();});
    var box=ta.closest('[data-rt]');
    var wrap=mde.codemirror.getWrapperElement().closest('.EasyMDEContainer');
    if(!box||!wrap)return;
    var f={ta:ta,mde:mde,wrap:wrap,host:box.querySelector('[data-rt-host]'),modes:box.querySelector('[data-rt-modes]'),tui:null,mode:'markdown',original:'',baseline:''};
    _skelpoRich.push(f);
    f.modes.querySelectorAll('[data-rt-mode]').forEach(function(b){
      b.addEventListener('click',function(){
        var m=b.getAttribute('data-rt-mode');
        skelpoRtSetMode(f,m);
        // Remember the choice only when it took effect.
        if(f.mode===m){try{localStorage.setItem(RT_KEY,m);}catch(e){}}
      });
    });
    skelpoRtSetMode(f,skelpoRtPref());
    var note=f.modes.querySelector('[data-rt-note]');if(note&&f.mode==='markdown')note.hidden=!skelpoRtUnsafe(mde.value())||skelpoRtPref()!=='visual';
  });
});

// ── Local backup of unsaved changes ──
// Every few seconds the form is copied into this browser's storage; if the
// tab closes or the session expires, the next visit offers to restore it.
function skelpoFormState(form){
  var out=[];
  Array.prototype.forEach.call(form.elements,function(el){
    if(!el.name||el.disabled)return;
    var t=el.type;
    if(t==='file'||t==='password'||t==='submit'||t==='button')return;
    if(el.name==='translationOf')return;
    if(t==='checkbox'||t==='radio')out.push([el.name,el.value,el.checked?1:0]);
    else out.push([el.name,el.value]);
  });
  return out;
}
function skelpoApplyState(form,state){
  // Repeaters first: rebuild their cards from the saved JSON.
  state.forEach(function(e){
    var wrap=null;
    form.querySelectorAll('.skelpo-repeater').forEach(function(w){if('f_'+w.dataset.name===e[0])wrap=w;});
    if(!wrap||e.length!==2)return;
    var items=[];try{items=JSON.parse(e[1]);}catch(x){return;}
    if(!Array.isArray(items))return;
    wrap.querySelectorAll('.skelpo-rep-item').forEach(function(c){c.remove();});
    items.forEach(function(item){
      skelpoRepeaterAdd(wrap);
      var cards=wrap.querySelectorAll('.skelpo-rep-item'),card=cards[cards.length-1];
      card.querySelectorAll('[data-rep-field]').forEach(function(el){
        var v=item?item[el.getAttribute('data-rep-field')]:'';
        el.value=v===null||v===undefined?'':String(v);
      });
    });
    skelpoRepeaterSerialize(wrap);
  });
  state.forEach(function(e){
    var name=e[0],value=e[1],found=null;
    Array.prototype.forEach.call(form.elements,function(el){
      if(found||el.name!==name)return;
      var box=el.type==='checkbox'||el.type==='radio';
      if(e.length===3){if(box&&el.value===value)found=el;}
      else if(!box)found=el;
    });
    if(!found)return;
    if(e.length===3){found.checked=e[2]===1;return;}
    if(found.closest('.skelpo-repeater'))return;
    if(found.tagName==='TEXTAREA'&&window.skelpoSetRich(found,value))return;
    found.value=value;
    var pick=found.getAttribute('data-skelpo-imgfield-input');
    if(pick){
      var slot=found.closest('.skelpo-imgfield').querySelector('.skelpo-imgfield-preview');
      slot.innerHTML=value&&/^[0-9]+$/.test(value)?'<img src="/api/v1/media/'+value+'/raw" alt="" style="width:100%;height:100%;object-fit:cover;display:block">':'';
    }
  });
  form.querySelectorAll('input[data-utc-target]').forEach(function(el){
    var hidden=form.querySelector('input[type=hidden][name="'+el.getAttribute('data-utc-target')+'"]');
    if(hidden){el.value=hidden.value?skelpoToLocalInput(hidden.value):'';el.dispatchEvent(new Event('input'));}
  });
  var slug=document.getElementById('slug');if(slug){slug.setAttribute('data-auto','0');var pv=document.querySelector('[data-slug-preview]');if(pv)pv.textContent=slug.value;}
  form.querySelectorAll('[data-count]').forEach(function(el){el.dispatchEvent(new Event('input'));});
}
document.addEventListener('DOMContentLoaded',function(){
  var form=document.querySelector('form[data-autosave]');if(!form)return;
  var key='skelpo-draft:'+form.getAttribute('data-autosave');
  var banner=document.getElementById('skelpo-draft-banner'),status=document.querySelector('[data-autosave-status]');
  function read(){try{return JSON.parse(localStorage.getItem(key)||'null');}catch(e){return null;}}
  function drop(){try{localStorage.removeItem(key);}catch(e){}}
  function clock(ms){try{return new Date(ms).toLocaleString(document.documentElement.lang||undefined,{month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'});}catch(e){return '';}}
  // Wait a tick so the editors have attached and the form reflects the page.
  setTimeout(function(){
    var initial=JSON.stringify(skelpoFormState(form));
    var lastSaved=initial;
    var draft=read();
    if(draft&&draft.data&&JSON.stringify(draft.data)!==initial&&banner){
      banner.hidden=false;
      banner.querySelector('[data-draft-time]').textContent=clock(draft.t);
      banner.querySelector('[data-draft-restore]').addEventListener('click',function(){
        skelpoApplyState(form,draft.data);
        if(window.skelpoMarkDirty)window.skelpoMarkDirty();
        banner.hidden=true;
      });
      banner.querySelector('[data-draft-discard]').addEventListener('click',function(){drop();banner.hidden=true;});
    } else if(draft){drop();}
    setInterval(function(){
      // While an older backup is still on offer, do not overwrite it.
      if(banner&&!banner.hidden)return;
      var now=JSON.stringify(skelpoFormState(form));
      if(now===lastSaved)return;
      lastSaved=now;
      if(now===initial){drop();if(status)status.textContent='';return;}
      try{
        localStorage.setItem(key,JSON.stringify({t:Date.now(),data:JSON.parse(now)}));
        if(status)status.textContent=(I18N.backupSaved||'Backup saved in this browser at {time}').replace('{time}',clock(Date.now()));
      }catch(e){}
    },4000);
  },600);
  form.addEventListener('submit',function(){drop();});
});
${MEDIA_PICKER_SCRIPT}
`;

const EDITOR_CSS = `
.rt-modes{display:flex;gap:2px;align-items:center;margin-bottom:6px;font-size:12px}
.rt-modes button{background:none;border:1px solid var(--line);color:var(--mut);padding:4px 12px;font-size:12px;font-weight:600;cursor:pointer;border-radius:6px 0 0 6px}
.rt-modes button+button{border-radius:0 6px 6px 0;border-left:0}
.rt-modes button.on{background:var(--panel2);color:var(--ink)}
.rt-modes span{margin-left:10px}
[data-rt-host] .toastui-editor-defaultUI{border-radius:7px}
[data-rt-host] .toastui-editor-contents{font-size:15px}
[data-rt-host] th{text-transform:none;letter-spacing:0;font-size:inherit}
[data-rt-host] .toastui-editor-popup input[type=text]{background:#fff;color:#222}
.toastui-editor-dark[data-rt-host] .toastui-editor-popup input[type=text],[data-rt-host] .toastui-editor-dark .toastui-editor-popup input[type=text]{background:#1e1f24;color:#eee}
`;

/** Thumbnail + "Pick image" control bound to a hidden input holding a media id. */
export const ImagePickerField: FC<{ name: string; pickerKey: string; value: string; t: Translator }> = ({ name, pickerKey, value, t }) => (
  <div class="skelpo-imgfield" style="display:flex;gap:14px;align-items:flex-start;background:var(--panel2);border:1px solid var(--line);border-radius:7px;padding:12px">
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
        <button type="button" class="btn sm" onclick={`skelpoOpenMediaPicker('${pickerKey}')`}>
          {value ? t('editor.change') : t('editor.pickImage')}
        </button>
        <button type="button" class="btn sm sec" onclick={`skelpoClearMediaField('${pickerKey}')`}>{t('editor.clear')}</button>
      </div>
      <input type="hidden" name={name} value={value} data-skelpo-imgfield-input={pickerKey} />
    </div>
  </div>
);

export interface RelationOption { id: number; title: string }

/** Parse a stored list value (JSON array, or comma list) into strings. */
function listValue(value: string): string[] {
  try {
    const p = JSON.parse(value);
    if (Array.isArray(p)) return p.map(String);
    if (p !== null && p !== undefined && p !== '') return [String(p)];
    return [];
  } catch {
    return value.split(',').map((s) => s.trim()).filter(Boolean);
  }
}

const FieldInput: FC<{ def: FieldDef; value: string; t: Translator; relationOptions?: RelationOption[] }> = ({ def, value, t, relationOptions }) => {
  const name = `f_${def.name}`;
  const label = (
    <label for={name}>
      {def.label ?? def.name}
      {def.required ? <span style="color:var(--err)"> *</span> : null}
    </label>
  );
  switch (def.type) {
    case 'richtext':
      // EasyMDE-enhanced markdown editor (upgraded by the init script).
      return (
        <div>
          {label}
          <div data-rt="1">
            <div class="rt-modes" data-rt-modes="1">
              <button type="button" data-rt-mode="visual">{t('editor.modeVisual')}</button>
              <button type="button" data-rt-mode="markdown">{t('editor.modeMarkdown')}</button>
              <span class="muted" data-rt-note="1" hidden>{t('editor.visualUnavailable')}</span>
            </div>
            <div data-rt-host="1" style="display:none"></div>
            <textarea name={name} id={name} rows={14} data-easymde="1" placeholder={t('editor.markdownPlaceholder')}>{ta(value)}</textarea>
          </div>
        </div>
      );
    case 'textarea':
      return (
        <div>
          {label}
          <textarea name={name} id={name} rows={4}>{ta(value)}</textarea>
        </div>
      );
    case 'gallery':
      return (
        <div>
          {label}
          <textarea name={name} id={name} rows={5} placeholder={t('editor.galleryPlaceholder')}>
            {listValue(value).join('\n')}
          </textarea>
          <button type="button" class="btn sm sec" style="margin-top:6px" onclick={`skelpoOpenMediaPicker('__gallery__${name}')`}>
            {t('editor.addFromLibrary')}
          </button>
        </div>
      );
    case 'json':
      return (
        <div>
          {label}
          <textarea name={name} id={name} rows={6} style="font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px" spellcheck={false}>{value}</textarea>
          <div class="help">{t('editor.jsonHelp')}</div>
        </div>
      );
    case 'repeater':
      // Friendly per-item card editor (no JSON visible to users).
      return <RepeaterField def={def} value={value} t={t} />;
    case 'boolean':
      return (
        <div>
          <label class="check" style="margin-top:14px">
            <input type="hidden" name={name} value="false" />
            <input type="checkbox" name={name} value="true" checked={value === 'true'} /> {def.label ?? def.name}
          </label>
        </div>
      );
    case 'select': {
      const opts = (def.validation?.options as string[] | undefined) ?? [];
      return (
        <div>
          {label}
          <select name={name} id={name}>
            <option value="">—</option>
            {opts.map((o) => (
              <option value={o} selected={value === o}>{o}</option>
            ))}
          </select>
        </div>
      );
    }
    case 'multiselect': {
      const opts = (def.validation?.options as string[] | undefined) ?? [];
      const selected = listValue(value);
      if (opts.length === 0) {
        // No fixed option list → free-form tags, comma separated.
        return (
          <div>
            {label}
            <input type="text" name={name} id={name} value={selected.join(', ')} placeholder={t('editor.tagsPlaceholder')} autocomplete="off" />
            <div class="help">{t('editor.tagsHelp')}</div>
          </div>
        );
      }
      // Fixed options render as checkboxes (`name[]` → parseBody array).
      return (
        <div>
          {label}
          <div style="display:flex;flex-wrap:wrap;gap:2px 18px;padding:2px">
            {opts.map((o) => (
              <label class="check">
                <input type="checkbox" name={`${name}[]`} value={o} checked={selected.includes(o)} /> {o}
              </label>
            ))}
          </div>
        </div>
      );
    }
    case 'number':
      return (
        <div>
          {label}
          <input type="number" step="any" name={name} id={name} value={value} />
        </div>
      );
    case 'date':
      return (
        <div>
          {label}
          <input type="date" name={name} id={name} value={value.slice(0, 10)} style="max-width:220px" />
        </div>
      );
    case 'datetime':
      return (
        <div>
          {label}
          <input type="datetime-local" name={name} id={name} value={value.slice(0, 16)} style="max-width:260px" />
        </div>
      );
    case 'image':
    case 'file':
      // Stored as a media id; the editor only ever sees the thumbnail.
      return (
        <div>
          {label}
          <ImagePickerField name={name} pickerKey={def.name} value={value} t={t} />
        </div>
      );
    case 'relation': {
      const selected = listValue(value);
      if (!relationOptions) {
        return (
          <div>
            {label}
            <input type="text" name={name} id={name} value={selected.join(', ')} placeholder={t('editor.relationPlaceholder')} />
          </div>
        );
      }
      if (def.relation && def.relation.many === false) {
        return (
          <div>
            {label}
            <select name={name} id={name}>
              <option value="">—</option>
              {relationOptions.map((o) => (
                <option value={String(o.id)} selected={selected.includes(String(o.id))}>{o.title}</option>
              ))}
            </select>
          </div>
        );
      }
      return (
        <div>
          {label}
          <div style="max-height:180px;overflow:auto;border:1px solid var(--line);border-radius:7px;padding:6px 10px;background:var(--panel2)">
            {relationOptions.length === 0 ? <span class="muted" style="font-size:12px">{t('editor.relationEmpty')}</span> : null}
            {relationOptions.map((o) => (
              <label class="check">
                <input type="checkbox" name={`${name}[]`} value={String(o.id)} checked={selected.includes(String(o.id))} /> {o.title}
              </label>
            ))}
          </div>
        </div>
      );
    }
    default:
      return (
        <div>
          {label}
          <input type="text" name={name} id={name} value={value} />
        </div>
      );
  }
};

/** A field input plus the help text the content type defines for it. */
const Field: FC<{ def: FieldDef; value: string; t: Translator; relationOptions?: RelationOption[] }> = (props) => {
  const help = props.def.admin?.help;
  return (
    <>
      <FieldInput {...props} />
      {typeof help === 'string' && help ? <div class="help">{help}</div> : null}
    </>
  );
};

export interface TranslationSibling { id: number; locale: string; status: string }

export interface EditorMeta {
  /** Site base URL (no trailing slash) for the permalink preview. */
  siteUrl?: string;
  /** Full public URL of this row, when it is routable. */
  viewUrl?: string | null;
  authorName?: string | null;
  revisionCount?: number;
  canPublish?: boolean;
  canDelete?: boolean;
  /** Options for relation fields, keyed by field name. */
  relationOptions?: Record<string, RelationOption[]>;
}

export const SCHEMA_TYPES = [
  'Article', 'BlogPosting', 'NewsArticle', 'WebPage', 'AboutPage', 'ContactPage', 'FAQPage',
  'Product', 'Service', 'SoftwareApplication', 'CreativeWork', 'Event', 'Organization', 'Person',
];

export const ContentForm: FC<{
  type: ContentTypeRow;
  row?: ContentDbRow | null;
  fields: Record<string, unknown>;
  seo: Record<string, unknown>;
  ai?: Record<string, unknown>;
  user: { displayName: string; roleSlug?: string };
  caps?: import('../auth/users.js').RoleCapabilities;
  flash?: { ok?: string; err?: string };
  /** Validation problems to list above the form (already human-readable). */
  errors?: string[];
  /** Existing translations of this row, by locale. Used to render locale tabs. */
  siblings?: TranslationSibling[];
  /** All locales configured on site.locales. */
  availableLocales?: string[];
  /** When creating a new translation, the source row id to link the group. */
  translationOf?: number;
  /** Title/slug to show instead of the stored ones (new rows, or a failed save). */
  defaultTitle?: string;
  defaultSlug?: string;
  defaultLocale?: string;
  /** Posted publish/schedule times to re-show after a failed save (ISO). */
  draftTimes?: { publishedAt?: string; scheduledAt?: string };
  meta?: EditorMeta;
  /** Request translator (falls back to English). */
  t?: Translator;
}> = ({
  type, row, fields, seo, ai, user, caps, flash, errors,
  siblings, availableLocales, translationOf, defaultTitle, defaultSlug, defaultLocale, draftTimes, meta, t,
}) => {
  const tr = t ?? makeT(defaultAdminLocale);
  const m = meta ?? {};
  const isNew = !row;
  const action = isNew
    ? `/admin/content/${type.slug}`
    : `/admin/content/${type.slug}/${row!.id}`;

  const currentLocale = row?.locale ?? defaultLocale ?? 'en';
  const siblingMap = new Map((siblings ?? []).map((s) => [s.locale, s]));
  const allLocales = (availableLocales ?? []).length > 0 ? availableLocales! : [currentLocale];
  const localeChoices = allLocales.includes(currentLocale) ? allLocales : [currentLocale, ...allLocales];
  // Show tabs whenever multiple locales are configured — even for rows with
  // no siblings yet, so the editor can click "+ de" to add a translation.
  const showTabs = !isNew && allLocales.length > 1;

  const title = defaultTitle ?? row?.title ?? '';
  const slug = defaultSlug ?? row?.slug ?? '';
  const publishedIso = draftTimes?.publishedAt ?? dateToIso(row?.publishedAt) ?? '';
  const scheduledIso = draftTimes?.scheduledAt ?? dateToIso(row?.scheduledAt) ?? '';
  const isPublished = row?.status === 'published';
  const isTrashed = row?.status === 'archived';
  const isScheduled = !!row && !isPublished && !isTrashed && !!scheduledIso && new Date(scheduledIso).getTime() > Date.now();
  const canPublish = m.canPublish !== false;
  const permalinkBase = type.isRoutable && type.urlPattern
    ? `${m.siteUrl ?? ''}${type.urlPattern.split(':slug')[0]}`
    : null;

  // Strings the inline form JS needs.
  const jsI18n = {
    insertImageTitle: tr('editor.insertImageTitle'),
    pickTitle: tr('media.pickTitle'),
    close: tr('media.close'),
    loading: tr('media.loading'),
    mediaRef: tr('editor.mediaRef'),
    noImage: tr('editor.noImage'),
    noImageSelected: tr('editor.noImageSelected'),
    removeItem: tr('editor.removeItem'),
    publish: tr('editor.publish'),
    schedule: tr('editor.schedule'),
    backupSaved: tr('editor.backupSaved'),
    yes: tr('common.yes'),
    no: tr('common.no'),
  };
  const heading = isNew ? tr('editor.newTitle', { label: type.labelSingular }) : tr('editor.editHeading', { label: type.labelSingular });

  return (
    <AdminPage title={isNew ? heading : title || heading} active={type.slug} t={tr} user={user} caps={caps}>
      {/* EasyMDE for richtext fields + repeater add/remove + form helpers. */}
      <link rel="stylesheet" href="/admin/static/easymde/easymde.min.css" />
      <script src="/admin/static/easymde/easymde.min.js"></script>
      <script dangerouslySetInnerHTML={{ __html: `window.SKELPO_I18N=${JSON.stringify(jsI18n)};` }} />
      <script dangerouslySetInnerHTML={{ __html: FORM_INIT_SCRIPT }} />
      <div class="top">
        <h1>
          {heading}{' '}
          {row ? <StatusBadge status={isScheduled ? 'scheduled' : row.status} t={tr} /> : null}
        </h1>
        <a class="btn sec" href={`/admin/content/${type.slug}`}>
          {tr('editor.backToList', { label: type.labelPlural })}
        </a>
      </div>
      {flash?.ok ? <div class="ok" role="status">{flash.ok}</div> : null}
      {flash?.err ? <div class="err" role="alert">{flash.err}</div> : null}
      {errors && errors.length > 0 ? (
        <div class="err" role="alert">
          <strong>{tr('editor.fixProblems')}</strong>
          <ul style="margin:6px 0 0;padding-left:18px">{errors.map((e) => <li>{e}</li>)}</ul>
        </div>
      ) : null}
      {isTrashed ? <div class="err">{tr('editor.inTrashNotice')}</div> : null}
      {showTabs ? (
        <div class="card" style="margin-bottom:14px;padding:8px 12px">
          <div style="display:flex;align-items:center;gap:4px;flex-wrap:wrap;font-size:13px">
            <span class="muted" style="margin-right:8px">{tr('editor.translations')}</span>
            {allLocales.map((l) => {
              const sib = siblingMap.get(l);
              const base = 'padding:5px 12px;border-radius:5px;text-decoration:none;border:1px solid transparent;text-transform:uppercase;font-size:11px;letter-spacing:0.5px;';
              if (l === currentLocale) {
                return <span style={`${base}background:var(--acc);color:#1a1205;font-weight:600`}>{l}</span>;
              }
              if (sib) {
                return (
                  <a href={`/admin/content/${type.slug}/${sib.id}`} style={`${base}color:var(--ink);border-color:var(--line)`}
                    title={tr('editor.translationStatus', { status: tr(`status.${sib.status}`), locale: l })}>
                    {l}
                  </a>
                );
              }
              return (
                <a href={`/admin/content/${type.slug}/new?translationOf=${row!.id}&locale=${l}`}
                  style={`${base}color:var(--mut);border-color:var(--line);border-style:dashed`}
                  title={tr('editor.addTranslation', { locale: l })}>
                  + {l}
                </a>
              );
            })}
          </div>
        </div>
      ) : null}
      <div class="ok" id="skelpo-draft-banner" hidden>
        {tr('editor.backupFound')} <strong data-draft-time="1"></strong>{' '}
        <button type="button" class="btn sm" data-draft-restore="1" style="margin-left:8px">{tr('editor.backupRestore')}</button>{' '}
        <button type="button" class="btn sm sec" data-draft-discard="1">{tr('editor.backupDiscard')}</button>
      </div>
      <style dangerouslySetInnerHTML={{ __html: EDITOR_CSS }} />
      <form method="post" action={action} data-guard="1" data-autosave={isNew ? `${action}#new${translationOf ? `-${translationOf}` : ''}-${currentLocale}` : action}>
        {translationOf ? <input type="hidden" name="translationOf" value={String(translationOf)} /> : null}
        <div class="editor-grid">
          <div class="card">
            <label for="title" style="margin-top:0">
              {tr('editor.title')}<span style="color:var(--err)"> *</span>
              <span class="counter" data-counter-for="title"></span>
            </label>
            <input type="text" name="title" id="title" value={title} required autofocus={isNew} data-count="1" data-max="70" style="font-size:16px;font-weight:600" />
            <label for="slug">
              {tr('editor.slug')}<span style="color:var(--err)"> *</span>
            </label>
            <input
              type="text"
              name="slug"
              id="slug"
              value={slug}
              required
              pattern="[a-z0-9]([a-z0-9-]*[a-z0-9])?"
              maxlength={75}
              data-auto={isNew && !slug ? '1' : '0'}
              placeholder={tr('editor.slugPlaceholder')}
            />
            <div class="help">
              {permalinkBase !== null
                ? <>{tr('editor.permalink')} <code>{permalinkBase}<span data-slug-preview="1">{slug}</span></code></>
                : tr('editor.slugHelp')}
            </div>
            {type.fieldsSchema.fields.map((def) => (
              <Field def={def} value={val(fields, def.name)} t={tr} relationOptions={m.relationOptions?.[def.name]} />
            ))}
          </div>

          <div class="stack">
            <div class="card">
              <h3>{tr('editor.publishBox')}</h3>
              <dl class="kv" style="margin:10px 0 0">
                <dt>{tr('editor.status')}</dt>
                <dd>{row ? <StatusBadge status={isScheduled ? 'scheduled' : row.status} t={tr} /> : <StatusBadge status="draft" t={tr} />}</dd>
                <dt>{tr('editor.locale')}</dt>
                <dd>
                  {isNew ? (
                    <select name="locale" style="padding:4px 8px;width:auto">
                      {localeChoices.map((l) => <option value={l} selected={l === currentLocale}>{l}</option>)}
                    </select>
                  ) : (
                    <><span style="text-transform:uppercase">{currentLocale}</span><input type="hidden" name="locale" value={currentLocale} /></>
                  )}
                </dd>
                {m.authorName ? <><dt>{tr('editor.author')}</dt><dd>{m.authorName}</dd></> : null}
                {row ? <><dt>{tr('editor.lastSaved')}</dt><dd><DateTime value={row.updatedAt} /></dd></> : null}
              </dl>

              {canPublish && !isTrashed ? (
                <>
                  {isPublished || publishedIso ? (
                    <>
                      <label for="publishedAt_local">{tr('editor.publishedOn')}</label>
                      <input type="datetime-local" id="publishedAt_local" data-utc={publishedIso} data-utc-target="publishedAt" />
                      <input type="hidden" name="publishedAt" value={publishedIso} />
                    </>
                  ) : null}
                  {!isPublished ? (
                    <>
                      <label for="scheduledAt_local">{tr('editor.scheduleFor')}</label>
                      <input type="datetime-local" id="scheduledAt_local" data-utc={scheduledIso} data-utc-target="scheduledAt" data-schedule="1" />
                      <input type="hidden" name="scheduledAt" value={scheduledIso} />
                      <div class="help">{tr('editor.scheduleHelp')}</div>
                    </>
                  ) : null}
                </>
              ) : null}

              {!isTrashed ? (
                <div style="margin-top:16px;display:flex;gap:8px;flex-wrap:wrap">
                  <button class={isPublished || !canPublish ? 'btn' : 'btn sec'} type="submit" name="action" value="save">
                    {isPublished ? tr('editor.update') : tr('editor.saveDraft')}
                  </button>
                  {!isPublished && canPublish ? (
                    <button class="btn" type="submit" name="action" value="publish" data-publish-btn="1">
                      {tr('editor.publish')}
                    </button>
                  ) : null}
                  {isPublished && canPublish ? (
                    <button class="btn sec" type="submit" name="action" value="unpublish">
                      {tr('editor.unpublish')}
                    </button>
                  ) : null}
                </div>
              ) : (
                <div style="margin-top:16px;display:flex;gap:8px;flex-wrap:wrap">
                  <button class="btn" type="submit" name="action" value="restore" formnovalidate>{tr('content.restore')}</button>
                  {m.canDelete !== false ? (
                    <button class="btn danger" type="submit" name="action" value="purge" formnovalidate data-confirm={tr('content.confirmPurge')}>
                      {tr('content.deletePermanently')}
                    </button>
                  ) : null}
                </div>
              )}

              <div class="help" data-autosave-status="1" aria-live="polite"></div>
              {row && !isTrashed ? (
                <div style="margin-top:14px;padding-top:12px;border-top:1px solid var(--line);display:flex;gap:14px;flex-wrap:wrap;font-size:13px;align-items:center">
                  {m.viewUrl && isPublished ? <a href={m.viewUrl} target="_blank" rel="noopener">{tr('editor.viewOnSite')} ↗</a> : null}
                  <a href={`${action}/revisions`}>{tr('editor.revisions', { n: m.revisionCount ?? 0 })}</a>
                  <button class="linkbtn" type="submit" formaction={`${action}/duplicate`} formnovalidate>{tr('content.duplicate')}</button>
                  {m.canDelete !== false ? (
                    <button class="linkbtn danger" type="submit" name="action" value="delete" formnovalidate style="margin-left:auto"
                      data-confirm={tr('content.confirmTrash')}>
                      {tr('content.moveToTrash')}
                    </button>
                  ) : null}
                </div>
              ) : null}
            </div>

            <div class="card">
              <h3>{tr('editor.seoTitle')}</h3>
              <label for="seo_metaDescription">
                {tr('editor.metaDescription')}
                <span class="counter" data-counter-for="seo_metaDescription"></span>
              </label>
              <textarea name="seo_metaDescription" id="seo_metaDescription" rows={3} data-count="1" data-min="70" data-max="160">
                {String(seo.metaDescription ?? '')}
              </textarea>
              <div class="help">{tr('editor.metaDescriptionHelp')}</div>
              <label for="seo_metaTitle">{tr('editor.metaTitle')}</label>
              <input type="text" name="seo_metaTitle" id="seo_metaTitle" value={String(seo.metaTitle ?? '')} placeholder={title} />
              <label>{tr('editor.ogImage')}</label>
              <ImagePickerField name="seo_ogImage" pickerKey="seo_ogImage" value={seo.ogImage ? String(seo.ogImage) : ''} t={tr} />
              <label class="check" style="margin-top:14px">
                <input type="checkbox" name="seo_noindex" value="true" checked={seo.noindex === true} /> {tr('editor.noindex')}
              </label>
              <details style="margin-top:10px">
                <summary class="muted" style="cursor:pointer;font-size:12px;font-weight:600">{tr('editor.advanced')}</summary>
                <label for="seo_schemaType">{tr('editor.schemaType')}</label>
                <input type="text" name="seo_schemaType" id="seo_schemaType" value={String(seo.schemaType ?? '')} list="skelpo-schema-types" placeholder="Article" />
                <datalist id="skelpo-schema-types">{SCHEMA_TYPES.map((s) => <option value={s} />)}</datalist>
                <label for="ai_summary">{tr('editor.aiSummary')}</label>
                <textarea name="ai_summary" id="ai_summary" rows={3}>{String(ai?.summary ?? '')}</textarea>
                <div class="help">{tr('editor.aiSummaryHelp')}</div>
              </details>
            </div>
          </div>
        </div>
      </form>
    </AdminPage>
  );
};

export interface ParsedContentForm {
  title: string;
  slug: string;
  locale: string;
  fields: Record<string, unknown>;
  seo: Record<string, unknown>;
  ai: Record<string, unknown>;
  action: string;
  translationOf?: number;
  /** ISO strings from the publish box ('' = not provided / cleared). */
  publishedAt: string;
  scheduledAt: string;
}

/**
 * Reconstruct fields/seo/ai objects from the posted form body, coercing
 * by the type schema (booleans, numbers, JSON, relation id arrays).
 */
export function parseContentForm(
  body: Record<string, string | string[] | File | (string | File)[]>,
  schema: FieldDef[],
): ParsedContentForm {
  // A checkbox with a hidden fallback posts the key twice → take the last.
  const get = (k: string): string => {
    const v = body[k];
    if (Array.isArray(v)) return String(v[v.length - 1] ?? '');
    return typeof v === 'string' ? v : '';
  };
  const list = (k: string): string[] | null => {
    const v = body[`${k}[]`];
    if (Array.isArray(v)) return v.map(String);
    if (typeof v === 'string') return [v];
    return null;
  };
  const fields: Record<string, unknown> = {};
  for (const def of schema) {
    const raw = get(`f_${def.name}`);
    const isList = def.type === 'multiselect' || def.type === 'relation';
    // List fields are never skipped: all-unchecked boxes submit no key at all,
    // and skipping would drop the field instead of storing the `[]` it means.
    if (raw === '' && !def.required && !isList) continue;
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
      case 'relation': {
        const picked = list(`f_${def.name}`) ?? raw.split(',');
        fields[def.name] = picked
          .map((s) => s.trim())
          .filter(Boolean)
          .map(Number)
          .filter((n) => Number.isFinite(n));
        break;
      }
      case 'multiselect':
        // Checkboxes post `f_<name>[]`; the free-form tag input (and API/legacy
        // posts) send one comma-separated string.
        fields[def.name] = list(`f_${def.name}`) ?? raw.split(',').map((s) => s.trim()).filter(Boolean);
        break;
      default:
        fields[def.name] = raw;
    }
  }
  return {
    title: get('title').trim(),
    slug: get('slug').trim(),
    locale: get('locale') || 'en',
    fields,
    seo: {
      metaDescription: get('seo_metaDescription').trim(),
      metaTitle: get('seo_metaTitle') || undefined,
      ogImage: get('seo_ogImage') ? Number(get('seo_ogImage')) : undefined,
      schemaType: get('seo_schemaType') || undefined,
      noindex: get('seo_noindex') === 'true' ? true : undefined,
    },
    ai: get('ai_summary').trim() ? { summary: get('ai_summary').trim() } : {},
    action: get('action') || 'save',
    translationOf: get('translationOf') ? Number(get('translationOf')) : undefined,
    publishedAt: get('publishedAt'),
    scheduledAt: get('scheduledAt'),
  };
}
