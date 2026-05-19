// Proof: render perry.land's blog — sourced entirely from Skelpo CMS via
// @skelpo/cms-client and @skelpo/site-kit — to standalone HTML + the full
// SEO/agent artifact set. Demonstrates the headless integration pattern
// without touching the production Next.js source.
//
// Output → ~/projects/skelpo-cms/.proof/perry-landing/
//   blog-index.html      list page (titles, excerpts, links)
//   post-<slug>.html      one fully-rendered post w/ <head> SEO + JSON-LD
//   sitemap.xml  robots.txt  llms.txt  feed.xml

import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { createClient } from '../packages/cms-client/src/index.ts';
import {
  buildMetaTags,
  metaTagsToHtml,
  buildJsonLd,
  jsonLdToHtml,
  renderTipTap,
  sitemapXml,
  sitemapFromContent,
  robotsTxt,
  llmsTxt,
  rssXml,
} from '../packages/site-kit/src/index.ts';

const CMS = process.argv[2] ?? 'http://127.0.0.1:3137';
const OUT = join(homedir(), 'projects/skelpo-cms/.proof/perry-landing');

const site = {
  name: 'Perry',
  url: 'https://perry.land',
  defaultLocale: 'en',
  locales: ['en'],
  twitterHandle: '@perry_ts',
  organizationSchema: { '@type': 'Organization', name: 'Perry', url: 'https://perry.land' },
};

const cms = createClient({ url: CMS, cache: 'auto' });

await mkdir(OUT, { recursive: true });

// ── Blog index ─────────────────────────────────────────────────────────

const list = await cms.content.list('post', { locale: 'en', limit: 50, sort: '-publishedAt' });
const posts = list.data;
console.log(`Fetched ${posts.length} posts from CMS`);

const indexHtml = `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Blog · Perry</title>
<meta name="description" content="Engineering notes from the Perry native TypeScript compiler.">
<link rel="canonical" href="https://perry.land/blog">
<link rel="alternate" type="application/rss+xml" href="https://perry.land/feed.xml">
</head><body style="font:16px/1.6 system-ui;max-width:46rem;margin:3rem auto;padding:0 1rem">
<h1>Perry Blog</h1>
<p style="color:#666">Served from Skelpo CMS — ${posts.length} posts.</p>
<ul style="list-style:none;padding:0">
${posts
  .map(
    (p) =>
      `<li style="margin:1.5rem 0"><a href="${p.url}" style="font-size:1.2rem;font-weight:600;color:#b45309;text-decoration:none">${p.title}</a><br><span style="color:#666;font-size:.9rem">${p.publishedAt?.slice(0, 10) ?? ''}</span><p>${(p.fields.excerpt ?? '')}</p></li>`,
  )
  .join('\n')}
</ul></body></html>`;
await writeFile(join(OUT, 'blog-index.html'), indexHtml);

// ── One full post (the flagship) ───────────────────────────────────────

const flagshipSlug = 'introducing-perry';
const { data: post } = await cms.content.bySlug('post', flagshipSlug, { locale: 'en' });
const imageUrl = 'https://perry.land/social-banner.png';
const meta = buildMetaTags(post, site, { imageUrl });
const ld = buildJsonLd(post, site, { imageUrl, authorName: 'Ralph Küpper' });
const bodyHtml = renderTipTap(post.fields.body);

const postHtml = `<!doctype html>
<html lang="${post.locale}"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
${metaTagsToHtml(meta)}
${jsonLdToHtml(ld)}
</head><body style="font:16px/1.7 system-ui;max-width:42rem;margin:3rem auto;padding:0 1rem">
<article>
<header><h1>${post.title}</h1>
<p style="color:#666"><time datetime="${post.publishedAt}">${post.publishedAt?.slice(0, 10)}</time></p></header>
<div>${bodyHtml}</div>
</article>
<hr style="margin:3rem 0"><p style="color:#999;font-size:.85rem">Rendered from Skelpo CMS content #${post.id} via @skelpo/cms-client + @skelpo/site-kit. URL: ${post.url}</p>
</body></html>`;
await writeFile(join(OUT, `post-${flagshipSlug}.html`), postHtml);

// ── SEO / agent artifacts ──────────────────────────────────────────────

const smEntries = sitemapFromContent(site, posts, { changefreq: 'weekly', priority: 0.7 });
await writeFile(join(OUT, 'sitemap.xml'), sitemapXml(smEntries).body);
await writeFile(join(OUT, 'robots.txt'), robotsTxt(site).body);
await writeFile(
  join(OUT, 'llms.txt'),
  llmsTxt(
    site,
    'Perry is a native TypeScript compiler written in Rust — it compiles TypeScript directly to standalone native executables. No runtime, no Electron.',
    [{ title: 'Engineering Blog', items: posts }],
  ).body,
);
await writeFile(
  join(OUT, 'feed.xml'),
  rssXml(site, posts, { title: 'Perry Blog', description: 'Engineering notes from the Perry compiler.' }).body,
);

console.log(`\nProof written to ${OUT}`);
console.log('  blog-index.html  (' + posts.length + ' posts)');
console.log('  post-' + flagshipSlug + '.html  (' + postHtml.length + ' bytes, full SEO head)');
console.log('  sitemap.xml  robots.txt  llms.txt  feed.xml');
console.log('\nMeta tags emitted:', meta.length);
console.log('JSON-LD @graph nodes:', ld['@graph'].length);
console.log('Rendered body length:', bodyHtml.length, 'chars');
