// TipTap JSON → HTML renderer. Pure function, no framework. Handles the
// node/mark set the CMS allows (no raw HTML). Unknown nodes render their
// children so forward-compat additions degrade gracefully.

import { safeHref, safeSrc } from './url.js';

interface TipTapMark {
  type: string;
  attrs?: Record<string, unknown>;
}

interface TipTapNode {
  type: string;
  attrs?: Record<string, unknown>;
  content?: TipTapNode[];
  marks?: TipTapMark[];
  text?: string;
}

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
function attrEsc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
}

function applyMarks(text: string, marks: TipTapMark[] = []): string {
  let out = esc(text);
  for (const m of marks) {
    switch (m.type) {
      case 'bold':   out = `<strong>${out}</strong>`; break;
      case 'italic': out = `<em>${out}</em>`; break;
      case 'code':   out = `<code>${out}</code>`; break;
      case 'strike': out = `<s>${out}</s>`; break;
      case 'underline': out = `<u>${out}</u>`; break;
      case 'link': {
        const href = safeHref(String(m.attrs?.href ?? '#'));
        const tgt = m.attrs?.target ? ` target="${attrEsc(String(m.attrs.target))}" rel="noopener"` : '';
        out = `<a href="${attrEsc(href)}"${tgt}>${out}</a>`;
        break;
      }
    }
  }
  return out;
}

function renderNode(node: TipTapNode): string {
  switch (node.type) {
    case 'doc':
      return (node.content ?? []).map(renderNode).join('');
    case 'paragraph':
      return `<p>${(node.content ?? []).map(renderNode).join('')}</p>`;
    case 'heading': {
      const lvl = Math.min(Math.max(Number(node.attrs?.level ?? 2), 1), 6);
      return `<h${lvl}>${(node.content ?? []).map(renderNode).join('')}</h${lvl}>`;
    }
    case 'text':
      return applyMarks(node.text ?? '', node.marks);
    case 'bulletList':
      return `<ul>${(node.content ?? []).map(renderNode).join('')}</ul>`;
    case 'orderedList':
      return `<ol>${(node.content ?? []).map(renderNode).join('')}</ol>`;
    case 'listItem':
      return `<li>${(node.content ?? []).map(renderNode).join('')}</li>`;
    case 'blockquote':
      return `<blockquote>${(node.content ?? []).map(renderNode).join('')}</blockquote>`;
    case 'codeBlock': {
      const lang = node.attrs?.language ? ` class="language-${attrEsc(String(node.attrs.language))}"` : '';
      const code = (node.content ?? []).map((n) => esc(n.text ?? '')).join('');
      return `<pre><code${lang}>${code}</code></pre>`;
    }
    case 'hardBreak':
      return '<br>';
    case 'horizontalRule':
      return '<hr>';
    case 'image': {
      const src = attrEsc(safeSrc(String(node.attrs?.src ?? '')));
      const alt = attrEsc(String(node.attrs?.alt ?? ''));
      return `<img src="${src}" alt="${alt}" loading="lazy">`;
    }
    default:
      // Unknown node — render children so new node types degrade safely.
      return (node.content ?? []).map(renderNode).join('');
  }
}

export function renderTipTap(doc: unknown): string {
  if (doc == null) return '';
  // Already-HTML legacy/migrated content passes through untouched.
  if (typeof doc === 'string') return doc;
  if (typeof doc !== 'object') return '';
  const node = doc as TipTapNode;
  if (node.type !== 'doc') {
    // Some content stores body as { type:'doc', content:[...] }; others
    // may pass content array directly.
    if (Array.isArray((doc as { content?: unknown }).content)) {
      return renderNode({ type: 'doc', content: (doc as { content: TipTapNode[] }).content });
    }
    return '';
  }
  return renderNode(node);
}
