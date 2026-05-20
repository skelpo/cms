# @skelpo/site-kit

Framework-agnostic SEO + structured-data helpers for sites driven by [Skelpo CMS](https://github.com/skelpo/cms) — or any CMS that produces similar shapes.

Generates `sitemap.xml`, `robots.txt`, `llms.txt`, RSS feeds, OpenGraph + JSON-LD tags, responsive `<picture>` markup, and renders TipTap rich-text JSON to safe HTML. Plain ESM, zero runtime dependencies.

Works with Next.js, Hono, Astro, Express, Cloudflare Workers, Perry — anywhere you can return a string.

## Install

```bash
npm i @skelpo/site-kit
```

## Quick start

```ts
import {
  sitemapXml, sitemapFromContent,
  robotsTxt, llmsTxt, rssXml,
  buildMetaTags, metaTagsToHtml, buildJsonLd, jsonLdToHtml,
  renderTipTap,
} from '@skelpo/site-kit';

const site = {
  name: 'My Site',
  url: 'https://example.com',
  defaultLocale: 'en',
  locales: ['en', 'de', 'fr'],
};

// 1. sitemap.xml
const xml = sitemapXml(sitemapFromContent(site, posts, { changefreq: 'weekly' }));
return new Response(xml.body, { headers: { 'Content-Type': xml.contentType } });

// 2. robots.txt
const r = robotsTxt(site);

// 3. llms.txt (LLM/agent-friendly content index)
const txt = llmsTxt(site, 'Engineering notes on Perry.', [{ title: 'Blog', items: posts }]);

// 4. RSS feed
const rss = rssXml(site, posts, { title: 'My Blog', description: '…', feedPath: '/feed.xml' });

// 5. <head> meta tags
const head = metaTagsToHtml(buildMetaTags(site, {
  title: post.title,
  description: post.seo.metaDescription,
  url: `${site.url}${post.url}`,
  image: `${site.url}/og/${post.slug}.svg`,
  type: 'article',
}));

// 6. JSON-LD
const jsonld = jsonLdToHtml(buildJsonLd.article(site, post));

// 7. TipTap rich-text → HTML
const bodyHtml = renderTipTap(post.fields.body);
```

## What's in the box

| Module    | Helpers                                                                |
| --------- | ---------------------------------------------------------------------- |
| `meta`    | `buildMetaTags`, `metaTagsToHtml`, `buildJsonLd`, `jsonLdToHtml`       |
| `feeds`   | `sitemapXml`, `sitemapFromContent`, `robotsTxt`, `llmsTxt`, `rssXml`   |
| `image`   | `buildResponsiveImage`, `imageHtml` (srcset/sizes from a base URL)    |
| `richtext`| `renderTipTap` — safe TipTap JSON → HTML, no DOMPurify, no JSDOM       |

All inputs are plain shapes (`SkSite`, `SkContent`) — adapt other CMSes by mapping their responses.

## Compatibility

| Runtime          | Supported |
| ---------------- | --------- |
| Node ≥ 22        | ✓         |
| Bun ≥ 1.1        | ✓         |
| Perry (native)   | ✓         |
| Browsers (ESM)   | ✓         |
| Cloudflare Workers | ✓       |

## License

MIT © [Skelpo GmbH](https://skelpo.com)
