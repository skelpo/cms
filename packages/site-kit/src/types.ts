// Minimal structural types — kept local so site-kit can be used without
// a hard dependency on @skelpo/cms-client's exact shapes.

export interface SkContent {
  id: number;
  type: string;
  slug: string;
  locale: string;
  title: string;
  fields: Record<string, unknown>;
  seo: {
    metaTitle?: string;
    metaDescription?: string;
    canonicalUrl?: string;
    ogImage?: number;
    ogTitle?: string;
    ogDescription?: string;
    schemaType?: string;
    noindex?: boolean;
    [k: string]: unknown;
  };
  ai: { summary?: string; [k: string]: unknown };
  url: string | null;
  publishedAt: string | null;
  updatedAt: string;
  authorId: number | null;
}

export interface SkSite {
  name: string;
  url: string;            // canonical origin, no trailing slash
  defaultLocale: string;
  locales: string[];
  logoUrl?: string;
  organizationSchema?: Record<string, unknown>;
  twitterHandle?: string;
}

export interface SkAlternate {
  locale: string;
  url: string;
}
