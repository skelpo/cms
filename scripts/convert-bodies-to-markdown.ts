// Bulk-convert every content row's `fields.body` to Markdown.
//
//   - String body that looks like HTML → run through `turndown` (HTML→MD).
//   - Object body (TipTap JSON `doc`) → walk the tree and emit MD.
//   - String body that's already MD-ish (no HTML tags) → leave as-is.
//   - Empty / missing → leave as-is.
//
// Writes via direct mysql update so we skip the publish-validation pass.
// Updates `updatedAt` automatically via the column default.

import { query, execute } from '../src/db/client.js';
// @ts-expect-error — turndown has no types in this devDep install
import TurndownService from 'turndown';

const turndown = new TurndownService({
  headingStyle: 'atx',
  hr: '---',
  bulletListMarker: '-',
  codeBlockStyle: 'fenced',
  emDelimiter: '*',
});

// ── TipTap → Markdown walker ────────────────────────────────────────

function renderInline(nodes = []) {
  return nodes.map((n) => {
    if (n.type === 'text') {
      let text = String(n.text ?? '');
      const marks = n.marks ?? [];
      for (const m of marks) {
        switch (m.type) {
          case 'bold':      text = `**${text}**`; break;
          case 'italic':    text = `*${text}*`; break;
          case 'code':      text = `\`${text}\``; break;
          case 'strike':    text = `~~${text}~~`; break;
          case 'underline': text = `<u>${text}</u>`; break;
          case 'link': {
            const href = m.attrs?.href ?? '#';
            text = `[${text}](${href})`;
            break;
          }
        }
      }
      return text;
    }
    if (n.type === 'hardBreak') return '  \n';
    if (n.type === 'image') {
      const src = n.attrs?.src ?? '';
      const alt = n.attrs?.alt ?? '';
      return `![${alt}](${src})`;
    }
    return renderInline(n.content ?? []);
  }).join('');
}

function renderTipTapToMarkdown(doc) {
  const parts = [];
  for (const node of (doc.content ?? [])) {
    switch (node.type) {
      case 'paragraph':
        parts.push(renderInline(node.content ?? []));
        break;
      case 'heading': {
        const lvl = Math.min(Math.max(Number(node.attrs?.level ?? 2), 1), 6);
        parts.push(`${'#'.repeat(lvl)} ${renderInline(node.content ?? [])}`);
        break;
      }
      case 'bulletList':
        parts.push((node.content ?? []).map((li) => {
          const text = (li.content ?? []).map((p) => renderInline(p.content ?? [])).join('\n  ');
          return `- ${text}`;
        }).join('\n'));
        break;
      case 'orderedList':
        parts.push((node.content ?? []).map((li, i) => {
          const text = (li.content ?? []).map((p) => renderInline(p.content ?? [])).join('\n   ');
          return `${i + 1}. ${text}`;
        }).join('\n'));
        break;
      case 'blockquote':
        parts.push((node.content ?? []).map((p) => `> ${renderInline(p.content ?? [])}`).join('\n> \n'));
        break;
      case 'codeBlock': {
        const lang = node.attrs?.language ?? '';
        const code = (node.content ?? []).map((t) => t.text ?? '').join('');
        parts.push(`\`\`\`${lang}\n${code}\n\`\`\``);
        break;
      }
      case 'horizontalRule':
        parts.push('---');
        break;
      default:
        // unknown block — emit inline rendering
        parts.push(renderInline(node.content ?? []));
    }
  }
  return parts.join('\n\n').trim();
}

// ── Detect + convert ───────────────────────────────────────────────

function looksLikeHtml(s) {
  return /<\/?(p|div|span|h[1-6]|ul|ol|li|a|strong|em|code|pre|blockquote|br|hr|img|table)\b/i.test(s);
}

function convertBody(body) {
  if (body == null) return { changed: false };
  if (typeof body === 'object' && body.type === 'doc') {
    return { changed: true, value: renderTipTapToMarkdown(body), from: 'tiptap' };
  }
  if (typeof body === 'string') {
    if (looksLikeHtml(body)) {
      // Some posts use literal "\n" escapes from JSON storage — unescape first.
      const clean = body.replace(/\\n/g, '\n');
      return { changed: true, value: turndown.turndown(clean), from: 'html' };
    }
    return { changed: false }; // already markdown-ish
  }
  return { changed: false };
}

// ── Main ───────────────────────────────────────────────────────────

interface Row { id: number; typeSlug: string; slug: string; locale: string; fields: unknown }

const rows = await query<Row>(
  "SELECT `id`, `typeSlug`, `slug`, `locale`, `fields` FROM `content` WHERE JSON_TYPE(JSON_EXTRACT(`fields`, '$.body')) IS NOT NULL ORDER BY `id`",
);
console.log(`Scanning ${rows.length} rows with a body field…`);

let converted = 0, skipped = 0, fromTiptap = 0, fromHtml = 0;
for (const r of rows) {
  const fields = (typeof r.fields === 'string' ? JSON.parse(r.fields) : r.fields) as Record<string, unknown>;
  const result = convertBody(fields.body);
  if (!result.changed) { skipped++; continue; }
  fields.body = result.value;
  await execute(
    'UPDATE `content` SET `fields` = ? WHERE `id` = ?',
    [JSON.stringify(fields), r.id],
  );
  converted++;
  if (result.from === 'tiptap') fromTiptap++;
  if (result.from === 'html') fromHtml++;
  if (converted % 20 === 0) console.log(`  …${converted} converted`);
}

console.log(`\nDone: ${converted} converted (${fromTiptap} TipTap, ${fromHtml} HTML), ${skipped} skipped.`);
process.exit(0);
