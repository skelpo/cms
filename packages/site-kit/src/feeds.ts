// sitemap.xml / robots.txt / llms.txt / RSS feed generators. All return
// strings + recommended Content-Type so any framework can serve them.

import type { SkContent, SkSite } from './types.js';

function xmlEsc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

export interface SitemapEntry {
  loc: string;
  lastmod?: string;
  changefreq?: 'always' | 'hourly' | 'daily' | 'weekly' | 'monthly' | 'yearly' | 'never';
  priority?: number;
  alternates?: Array<{ locale: string; href: string }>;
}

export function sitemapXml(entries: SitemapEntry[]): { body: string; contentType: string } {
  const urls = entries
    .map((e) => {
      const alts = (e.alternates ?? [])
        .map(
          (a) =>
            `<xhtml:link rel="alternate" hreflang="${xmlEsc(a.locale)}" href="${xmlEsc(a.href)}"/>`,
        )
        .join('');
      return (
        `<url><loc>${xmlEsc(e.loc)}</loc>` +
        (e.lastmod ? `<lastmod>${xmlEsc(e.lastmod)}</lastmod>` : '') +
        (e.changefreq ? `<changefreq>${e.changefreq}</changefreq>` : '') +
        (e.priority !== undefined ? `<priority>${e.priority.toFixed(1)}</priority>` : '') +
        alts +
        `</url>`
      );
    })
    .join('');
  const body =
    `<?xml version="1.0" encoding="UTF-8"?>` +
    `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" ` +
    `xmlns:xhtml="http://www.w3.org/1999/xhtml">${urls}</urlset>`;
  return { body, contentType: 'application/xml; charset=utf-8' };
}

/** Build sitemap entries from CMS content lists. */
export function sitemapFromContent(
  site: SkSite,
  items: SkContent[],
  opts: { changefreq?: SitemapEntry['changefreq']; priority?: number } = {},
): SitemapEntry[] {
  const entries: SitemapEntry[] = [
    { loc: site.url + '/', changefreq: 'daily', priority: 1.0 },
  ];
  for (const c of items) {
    if (!c.url || c.seo.noindex) continue;
    const entry: SitemapEntry = { loc: site.url + c.url, lastmod: c.updatedAt };
    if (opts.changefreq) entry.changefreq = opts.changefreq;
    if (opts.priority !== undefined) entry.priority = opts.priority;
    entries.push(entry);
  }
  return entries;
}

export function robotsTxt(
  site: SkSite,
  opts: { disallow?: string[]; allowAll?: boolean } = {},
): { body: string; contentType: string } {
  const lines = ['User-agent: *'];
  if (opts.allowAll === false && opts.disallow?.length) {
    for (const d of opts.disallow) lines.push(`Disallow: ${d}`);
  } else {
    lines.push('Disallow:');
  }
  lines.push('', `Sitemap: ${site.url}/sitemap.xml`);
  return { body: lines.join('\n') + '\n', contentType: 'text/plain; charset=utf-8' };
}

/**
 * llms.txt — a curated, LLM-friendly index of the site's key content.
 * Format follows the emerging llms.txt convention: H1 site name, blockquote
 * summary, then sectioned link lists with one-line descriptions.
 */
export function llmsTxt(
  site: SkSite,
  intro: string,
  sections: Array<{ title: string; items: SkContent[] }>,
): { body: string; contentType: string } {
  const out: string[] = [`# ${site.name}`, ''];
  if (intro) out.push(`> ${intro}`, '');
  for (const sec of sections) {
    out.push(`## ${sec.title}`, '');
    for (const c of sec.items) {
      if (!c.url) continue;
      const summary = c.ai.summary || c.seo.metaDescription || '';
      out.push(`- [${c.title}](${site.url}${c.url})${summary ? `: ${summary}` : ''}`);
    }
    out.push('');
  }
  return { body: out.join('\n'), contentType: 'text/plain; charset=utf-8' };
}

export function rssXml(
  site: SkSite,
  posts: SkContent[],
  opts: { title?: string; description?: string; feedPath?: string } = {},
): { body: string; contentType: string } {
  const title = opts.title ?? site.name;
  const desc = opts.description ?? '';
  const self = site.url + (opts.feedPath ?? '/feed.xml');
  const items = posts
    .filter((p) => p.url)
    .map((p) => {
      const link = site.url + p.url;
      const pub = p.publishedAt ? new Date(p.publishedAt).toUTCString() : '';
      const summary = p.ai.summary || p.seo.metaDescription || '';
      return (
        `<item>` +
        `<title>${xmlEsc(p.title)}</title>` +
        `<link>${xmlEsc(link)}</link>` +
        `<guid isPermaLink="true">${xmlEsc(link)}</guid>` +
        (pub ? `<pubDate>${pub}</pubDate>` : '') +
        `<description>${xmlEsc(summary)}</description>` +
        `</item>`
      );
    })
    .join('');
  const body =
    `<?xml version="1.0" encoding="UTF-8"?>` +
    `<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">` +
    `<channel><title>${xmlEsc(title)}</title>` +
    `<link>${xmlEsc(site.url)}</link>` +
    `<description>${xmlEsc(desc)}</description>` +
    `<atom:link href="${xmlEsc(self)}" rel="self" type="application/rss+xml"/>` +
    items +
    `</channel></rss>`;
  return { body, contentType: 'application/rss+xml; charset=utf-8' };
}
