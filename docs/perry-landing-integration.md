# perry.land — First Sample Case (Integration Guide)

**Status:** Proof complete. Production cutover is a deliberate, owner-driven step.
**Date:** 2026-05-19

perry.land is the first site to run on Skelpo CMS. This documents what's
proven, how it works, and the safe path to a production cutover. The
proof scripts touch **only the CMS database** — the live
`~/projects/perry/landing` Next.js source is untouched.

## What's proven

`scripts/import-perry-landing.mjs` migrated perry.land's blog catalog
into the CMS:

- Parses `~/projects/perry/landing/src/lib/blog.ts` for post metadata
  (slug, title, date, excerpt, tags).
- Converts each `src/content/blog/<slug>/en.tsx` JSX body to clean HTML
  (strips `className`, unwraps the component, preserves `<pre><code>`,
  links, headings, lists).
- Creates + publishes each as a `post` via the CMS API.
- Idempotent: re-runs skip slugs that already exist.

Result: **17 perry.land blog posts live in Skelpo CMS, with body content.**

`scripts/render-perry-landing-proof.mjs` then renders that content back
out — sourced entirely through `@skelpo/cms-client` + `@skelpo/site-kit`
— into `.proof/perry-landing/`:

| File | What it proves |
|---|---|
| `blog-index.html` | List page fetched from CMS (`cms.content.list('post')`) |
| `post-introducing-perry.html` | Full post: 20 SEO meta tags + 3-node JSON-LD graph + 10.7 KB rendered body |
| `sitemap.xml` | `sitemapFromContent()` over real CMS posts |
| `robots.txt` | `robotsTxt()` |
| `llms.txt` | `llmsTxt()` — **perry.land currently has no llms.txt; this closes that gap** |
| `feed.xml` | `rssXml()` valid RSS 2.0 |

Run both (CMS must be up with an admin user):

```bash
cd ~/projects/skelpo-cms
node scripts/import-perry-landing.mjs --cms http://127.0.0.1:3137 --landing ~/projects/perry/landing
npx tsx scripts/render-perry-landing-proof.mjs http://127.0.0.1:3137
open .proof/perry-landing/post-introducing-perry.html
```

## Production cutover path (when the owner is ready)

perry.land is Next.js 16 static-export + a Perry-compiled Fastify static
server. The cutover keeps that architecture; only the **content source**
changes from JSX files to the CMS.

1. **Stand up the CMS** next to the site (Docker or the Perry binary):
   `cms.perry.land`, MySQL, an admin user.
2. **Run the import** once to seed the blog catalog (above). For full
   fidelity, the body migration is lossy (JSX→HTML); review each post in
   the admin before final publish, or re-author bodies in TipTap.
3. **Swap the data layer in Next.js.** Replace `src/lib/blog.ts`'s static
   array with build-time fetches:
   ```ts
   // src/lib/blog.ts
   import { createClient } from '@skelpo/cms-client';
   const cms = createClient({ url: process.env.CMS_URL! });
   export async function getPosts() {
     const { data } = await cms.content.list('post', { locale: 'en', limit: 100 });
     return data;
   }
   export async function getPost(slug: string) {
     const { data } = await cms.content.bySlug('post', slug, { locale: 'en' });
     return data;
   }
   ```
   The blog list page + `[slug]` page call these in `generateStaticParams`
   / the page body. `next build` bakes them into `out/` exactly as today.
4. **Render bodies + SEO with site-kit:**
   ```ts
   import { renderTipTap, buildMetaTags, buildJsonLd } from '@skelpo/site-kit';
   // in the post page:
   const html = renderTipTap(post.fields.body);          // body
   const meta = buildMetaTags(post, site, { imageUrl });  // <head>
   ```
   Keep the existing Tailwind/Perry-amber components; site-kit returns
   data + strings, not markup, so it slots into the existing JSX.
5. **Add the missing `/llms.txt`** as a Next route handler using
   `llmsTxt()` — perry.land has `sitemap.ts` + `robots.ts` already; this
   is the one SEO/agent artifact it lacks.
6. **Live updates without a rebuild:** for content that changes between
   deploys, register a webhook (`POST /api/v1/webhooks`,
   events `content.published`/`content.updated`) pointing at a small
   redeploy trigger, or move the blog list to runtime fetch in the Perry
   Fastify server. The SDK's `webhookHandler()` does cache invalidation
   automatically if the server keeps an in-process cache.

### What stays the same

- Next.js + Tailwind + the Perry-amber design system
- The Perry-compiled Fastify static server + `deploy.sh`
- 14-locale i18n scaffold (CMS supports per-locale content via
  `translationGroupId`; migrate non-en bodies incrementally)
- `next-intl` routing, Plausible analytics, the Resend newsletter handler

### What changes

- `src/lib/blog.ts` becomes a thin CMS client instead of a static array
- `src/content/blog/**` JSX bodies → CMS content (editable without a deploy)
- A new `/llms.txt` route
- Editors update posts in the CMS admin, not by editing `.tsx` + committing

## Caveats / follow-ups

- **JSX→HTML migration is lossy.** Tailwind classes are dropped (the
  site's prose styles should target the `.prose`-style container instead).
  Code blocks, links, headings, lists survive. Review before production.
- **Non-en locales** not yet migrated — the importer does `en` only.
  Per-locale import is a straightforward extension (loop locales, link
  via `translationOf`).
- **Showcase / compare / docs** pages are still JSX; only the blog is
  migrated in this proof. They follow the same pattern when desired.
- Body fidelity for production should likely be re-authored in TipTap
  rather than relying on the regex JSX cleaner — fine for the proof,
  not ideal as the permanent source of truth.
