// Markdown renderer. Thin wrapper around `marked` that:
//   - configures sensible defaults (GFM tables/strikethrough, line-break
//     handling matching CommonMark)
//   - returns plain HTML strings (no DOM, no sanitization layer — the
//     CMS controls what reaches this function, content authors are
//     trusted users)
//
// Use renderMarkdown(md) for new markdown-stored content. Old TipTap
// JSON content keeps rendering via renderTipTap; auto-detect with
// `typeof body === 'string'` upstream.

import { marked } from 'marked';

marked.setOptions({
  gfm: true,
  breaks: false,
  pedantic: false,
});

/** Render a Markdown string to an HTML string. Empty input → empty string. */
export function renderMarkdown(md: string | undefined | null): string {
  if (!md) return '';
  // marked.parse returns string in sync mode (async: false is the default).
  return marked.parse(String(md), { async: false }) as string;
}
