// Markdown renderer. Thin wrapper around `marked` that:
//   - configures sensible defaults (GFM tables/strikethrough, line-break
//     handling matching CommonMark)
//   - SANITIZES output: raw inline/block HTML is escaped (never passed through
//     live), and link/image URLs are scheme-checked. Content authors are CMS
//     users (editor/author/contributor) — not fully trusted — so an unsanitized
//     `marked.parse` would be a stored-XSS sink on the public site.
//
// Use renderMarkdown(md) for new markdown-stored content. Old TipTap JSON
// content keeps rendering via renderTipTap; auto-detect with
// `typeof body === 'string'` upstream.

import { marked, type Tokens } from 'marked';
import { safeHref, safeSrc } from './url.js';

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

marked.setOptions({
  gfm: true,
  breaks: false,
  pedantic: false,
});

// Override the renderers that can emit attacker-controlled markup.
marked.use({
  renderer: {
    // Raw HTML in the source is rendered as visible, escaped text — never as
    // live markup. This neutralizes `<script>`, `<img onerror>`, etc.
    html(token: Tokens.HTML | Tokens.Tag): string {
      return esc(token.text);
    },
    link(this: { parser: { parseInline(tokens: Tokens.Generic[]): string } }, token: Tokens.Link): string {
      const href = safeHref(token.href ?? '');
      const title = token.title ? ` title="${esc(token.title)}"` : '';
      const text = this.parser.parseInline(token.tokens);
      return `<a href="${esc(href)}"${title}>${text}</a>`;
    },
    image(token: Tokens.Image): string {
      const src = safeSrc(token.href ?? '');
      const title = token.title ? ` title="${esc(token.title)}"` : '';
      return `<img src="${esc(src)}" alt="${esc(token.text ?? '')}"${title}>`;
    },
  },
});

/** Render a Markdown string to a sanitized HTML string. Empty input → empty string. */
export function renderMarkdown(md: string | undefined | null): string {
  if (!md) return '';
  // marked.parse returns string in sync mode (async: false is the default).
  return marked.parse(String(md), { async: false }) as string;
}
