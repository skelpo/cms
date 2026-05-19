// @skelpo/site-kit — framework-agnostic SEO + structured-data + rendering
// helpers for Skelpo CMS customer frontends. Works with Next.js, Hono,
// Astro — anything that can render a string.

export type { SkContent, SkSite, SkAlternate } from './types.js';

export {
  buildMetaTags,
  metaTagsToHtml,
  buildJsonLd,
  jsonLdToHtml,
  type MetaTag,
} from './meta.js';

export {
  sitemapXml,
  sitemapFromContent,
  robotsTxt,
  llmsTxt,
  rssXml,
  type SitemapEntry,
} from './feeds.js';

export {
  buildResponsiveImage,
  imageHtml,
  type ResponsiveImage,
  type ImageOptions,
  type ImageVariant,
} from './image.js';

export { renderTipTap } from './richtext.js';
