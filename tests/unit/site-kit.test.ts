import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildMetaTags,
  metaTagsToHtml,
  buildJsonLd,
  sitemapXml,
  sitemapFromContent,
  robotsTxt,
  llmsTxt,
  rssXml,
  renderTipTap,
} from '../../packages/site-kit/src/index.js';

const site = {
  name: 'Perry',
  url: 'https://perry.land',
  defaultLocale: 'en',
  locales: ['en', 'de'],
  twitterHandle: '@perry_ts',
  organizationSchema: { '@type': 'Organization', name: 'Perry' },
};
const post = {
  id: 2,
  type: 'post',
  slug: 'hello',
  locale: 'en',
  title: 'Hello Perry',
  fields: { body: '<p>Body</p>' },
  seo: { metaDescription: 'A '.repeat(40) + 'description.' },
  ai: { summary: 'Short summary.' },
  url: '/blog/hello',
  publishedAt: '2026-05-19T18:12:16Z',
  updatedAt: '2026-05-19T18:30:00Z',
  authorId: 3,
};

test('buildMetaTags emits title, description, canonical, OG, Twitter', () => {
  const tags = buildMetaTags(post, site, { imageUrl: 'https://x/og.png' });
  assert.ok(tags.some((t) => t.kind === 'title'));
  assert.ok(tags.some((t) => t.attrs.name === 'description'));
  assert.ok(tags.some((t) => t.attrs.rel === 'canonical' && t.attrs.href === 'https://perry.land/blog/hello'));
  assert.ok(tags.some((t) => t.attrs.property === 'og:type' && t.attrs.content === 'article'));
  assert.ok(tags.some((t) => t.attrs.name === 'twitter:card' && t.attrs.content === 'summary_large_image'));
  assert.ok(tags.some((t) => t.attrs.property === 'og:image'));
});

test('noindex flips robots meta', () => {
  const tags = buildMetaTags({ ...post, seo: { ...post.seo, noindex: true } }, site, {});
  assert.ok(tags.some((t) => t.attrs.name === 'robots' && t.attrs.content === 'noindex,nofollow'));
});

test('metaTagsToHtml escapes + renders', () => {
  const html = metaTagsToHtml(buildMetaTags({ ...post, title: 'A & B <x>' }, site, {}));
  assert.match(html, /<title>A &amp; B &lt;x&gt; · Perry<\/title>/);
  assert.match(html, /<meta name="description"/);
});

test('buildJsonLd graph has WebSite + Organization + typed primary', () => {
  const ld = buildJsonLd(post, site, { authorName: 'Ralph' }) as {
    '@graph': { '@type': string }[];
  };
  const types = ld['@graph'].map((g) => g['@type']).filter(Boolean);
  assert.ok(types.includes('WebSite'));
  assert.ok(types.includes('BlogPosting'));
});

test('sitemapXml well-formed + escapes', () => {
  const { body, contentType } = sitemapXml([
    { loc: 'https://perry.land/?a=1&b=2', changefreq: 'daily', priority: 1 },
  ]);
  assert.match(contentType, /xml/);
  assert.ok(body.startsWith('<?xml'));
  assert.match(body, /&amp;b=2/);
  assert.match(body, /<priority>1\.0<\/priority>/);
});

test('sitemapFromContent skips noindex + always includes root', () => {
  const entries = sitemapFromContent(site, [
    post,
    { ...post, id: 3, url: '/blog/x', seo: { ...post.seo, noindex: true } },
  ]);
  assert.equal(entries[0]!.loc, 'https://perry.land/');
  assert.equal(entries.length, 2, 'root + 1 indexable (noindex skipped)');
});

test('robotsTxt references sitemap', () => {
  assert.match(robotsTxt(site).body, /Sitemap: https:\/\/perry\.land\/sitemap\.xml/);
});

test('llmsTxt renders sections + summaries', () => {
  const out = llmsTxt(site, 'Intro line.', [{ title: 'Blog', items: [post] }]).body;
  assert.match(out, /^# Perry/m);
  assert.match(out, /> Intro line\./);
  assert.match(out, /## Blog/);
  assert.match(out, /\[Hello Perry\]\(https:\/\/perry\.land\/blog\/hello\): Short summary\./);
});

test('rssXml valid 2.0 with item', () => {
  const { body } = rssXml(site, [post], { title: 'Perry Blog' });
  assert.match(body, /<rss version="2\.0"/);
  assert.match(body, /<title>Perry Blog<\/title>/);
  assert.match(body, /<link>https:\/\/perry\.land\/blog\/hello<\/link>/);
});

test('renderTipTap: HTML string passthrough', () => {
  assert.equal(renderTipTap('<p>raw</p>'), '<p>raw</p>');
  assert.equal(renderTipTap(null), '');
  assert.equal(renderTipTap(undefined), '');
});

test('renderTipTap: doc tree → HTML', () => {
  const doc = {
    type: 'doc',
    content: [
      { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'H' }] },
      {
        type: 'paragraph',
        content: [
          { type: 'text', text: 'a ' },
          { type: 'text', marks: [{ type: 'bold' }], text: 'b' },
          { type: 'text', marks: [{ type: 'link', attrs: { href: 'https://x' } }], text: 'l' },
        ],
      },
      { type: 'codeBlock', attrs: { language: 'ts' }, content: [{ type: 'text', text: 'const x=1;' }] },
    ],
  };
  const html = renderTipTap(doc);
  assert.match(html, /<h2>H<\/h2>/);
  assert.match(html, /<strong>b<\/strong>/);
  assert.match(html, /<a href="https:\/\/x">l<\/a>/);
  assert.match(html, /<pre><code class="language-ts">const x=1;<\/code><\/pre>/);
});

test('renderTipTap escapes text + unknown nodes degrade to children', () => {
  const doc = {
    type: 'doc',
    content: [
      { type: 'paragraph', content: [{ type: 'text', text: '<script>' }] },
      { type: 'futureNode', content: [{ type: 'text', text: 'kept' }] },
    ],
  };
  const html = renderTipTap(doc);
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /kept/);
});
