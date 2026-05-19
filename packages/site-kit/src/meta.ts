// Meta-tag + JSON-LD builders. Return data structures, not framework
// JSX, so Next.js / Hono / Astro can all render them their own way.
// A `metaTagsToHtml()` convenience emits a raw HTML string for SSR
// frameworks that want it directly.

import type { SkContent, SkSite, SkAlternate } from './types.js';

export interface MetaTag {
  // either {name|property, content} for <meta>, or {rel, href, ...} for <link>
  kind: 'meta' | 'link' | 'title';
  attrs: Record<string, string>;
  text?: string;
}

function clamp(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max - 1).trimEnd() + '…';
}

export function buildMetaTags(
  content: SkContent,
  site: SkSite,
  opts: { alternates?: SkAlternate[]; imageUrl?: string } = {},
): MetaTag[] {
  const tags: MetaTag[] = [];
  const title = content.seo.metaTitle || content.title;
  const fullTitle = `${title} · ${site.name}`;
  const desc = clamp(String(content.seo.metaDescription ?? content.ai.summary ?? ''), 160);
  const canonical =
    content.seo.canonicalUrl || (content.url ? site.url + content.url : site.url);

  tags.push({ kind: 'title', attrs: {}, text: fullTitle });
  tags.push({ kind: 'meta', attrs: { name: 'description', content: desc } });
  tags.push({ kind: 'link', attrs: { rel: 'canonical', href: canonical } });
  tags.push({
    kind: 'meta',
    attrs: {
      name: 'robots',
      content: content.seo.noindex ? 'noindex,nofollow' : 'index,follow,max-image-preview:large',
    },
  });

  // hreflang alternates
  for (const alt of opts.alternates ?? []) {
    tags.push({ kind: 'link', attrs: { rel: 'alternate', hreflang: alt.locale, href: alt.url } });
  }
  if ((opts.alternates ?? []).length > 0) {
    const def = opts.alternates!.find((a) => a.locale === site.defaultLocale) ?? opts.alternates![0];
    if (def) tags.push({ kind: 'link', attrs: { rel: 'alternate', hreflang: 'x-default', href: def.url } });
  }

  // Open Graph
  const ogType = content.type === 'post' || content.type === 'doc' ? 'article' : 'website';
  const ogTitle = content.seo.ogTitle || title;
  const ogDesc = content.seo.ogDescription || desc;
  tags.push({ kind: 'meta', attrs: { property: 'og:type', content: ogType } });
  tags.push({ kind: 'meta', attrs: { property: 'og:title', content: ogTitle } });
  tags.push({ kind: 'meta', attrs: { property: 'og:description', content: ogDesc } });
  tags.push({ kind: 'meta', attrs: { property: 'og:url', content: canonical } });
  tags.push({ kind: 'meta', attrs: { property: 'og:site_name', content: site.name } });
  tags.push({ kind: 'meta', attrs: { property: 'og:locale', content: content.locale.replace('-', '_') } });
  if (opts.imageUrl) {
    tags.push({ kind: 'meta', attrs: { property: 'og:image', content: opts.imageUrl } });
    tags.push({ kind: 'meta', attrs: { property: 'og:image:width', content: '1200' } });
    tags.push({ kind: 'meta', attrs: { property: 'og:image:height', content: '630' } });
  }
  if (ogType === 'article') {
    if (content.publishedAt) tags.push({ kind: 'meta', attrs: { property: 'article:published_time', content: content.publishedAt } });
    tags.push({ kind: 'meta', attrs: { property: 'article:modified_time', content: content.updatedAt } });
  }

  // Twitter
  tags.push({ kind: 'meta', attrs: { name: 'twitter:card', content: opts.imageUrl ? 'summary_large_image' : 'summary' } });
  tags.push({ kind: 'meta', attrs: { name: 'twitter:title', content: ogTitle } });
  tags.push({ kind: 'meta', attrs: { name: 'twitter:description', content: ogDesc } });
  if (site.twitterHandle) tags.push({ kind: 'meta', attrs: { name: 'twitter:site', content: site.twitterHandle } });
  if (opts.imageUrl) tags.push({ kind: 'meta', attrs: { name: 'twitter:image', content: opts.imageUrl } });

  return tags;
}

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Render meta tags to a raw HTML string for direct SSR injection. */
export function metaTagsToHtml(tags: MetaTag[]): string {
  const out: string[] = [];
  for (const t of tags) {
    if (t.kind === 'title') {
      out.push(`<title>${esc(t.text ?? '')}</title>`);
    } else {
      const attrs = Object.entries(t.attrs)
        .map(([k, v]) => `${k}="${esc(v)}"`)
        .join(' ');
      out.push(`<${t.kind} ${attrs} />`);
    }
  }
  return out.join('\n');
}

// ────────── JSON-LD ──────────

const SCHEMA_BY_TYPE: Record<string, string> = {
  page: 'WebPage',
  post: 'BlogPosting',
  doc: 'TechArticle',
  service: 'Service',
  person: 'Person',
  event: 'Event',
  product: 'Product',
};

export function buildJsonLd(
  content: SkContent,
  site: SkSite,
  opts: { imageUrl?: string; authorName?: string } = {},
): Record<string, unknown> {
  const type = content.seo.schemaType || SCHEMA_BY_TYPE[content.type] || 'WebPage';
  const url = content.url ? site.url + content.url : site.url;
  const graph: Record<string, unknown>[] = [
    {
      '@type': 'WebSite',
      '@id': `${site.url}#website`,
      name: site.name,
      url: site.url,
    },
  ];
  if (site.organizationSchema) {
    graph.push({ '@id': `${site.url}#org`, ...site.organizationSchema });
  }
  const primary: Record<string, unknown> = {
    '@type': type,
    '@id': `${url}#main`,
    name: content.title,
    headline: content.title,
    url,
    description: content.seo.metaDescription ?? content.ai.summary ?? '',
    inLanguage: content.locale,
  };
  if (opts.imageUrl) primary.image = opts.imageUrl;
  if (content.publishedAt) primary.datePublished = content.publishedAt;
  primary.dateModified = content.updatedAt;
  if (opts.authorName) primary.author = { '@type': 'Person', name: opts.authorName };
  graph.push(primary);

  return { '@context': 'https://schema.org', '@graph': graph };
}

export function jsonLdToHtml(obj: Record<string, unknown>): string {
  return `<script type="application/ld+json">${JSON.stringify(obj)}</script>`;
}
