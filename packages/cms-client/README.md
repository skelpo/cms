# @skelpo/cms-client

Typed client for [Skelpo CMS](https://github.com/skelpo/cms) — fetch content, settings, menus; submit forms; verify webhook signatures.

Zero runtime dependencies. Works in Node, Bun, browsers, and Perry-compiled native binaries.

## Install

```bash
npm i @skelpo/cms-client
```

## Quick start

```ts
import { createClient } from '@skelpo/cms-client';

const cms = createClient({
  url: process.env.CMS_URL ?? 'http://127.0.0.1:3137',
  cache: 'auto',       // in-memory cache with ETag revalidation
});

// List published posts in a locale, newest first
const { data: posts } = await cms.content.list('post', {
  locale: 'en',
  limit: 20,
  sort: '-publishedAt',
});

// Fetch a single piece of content by slug
const { data: post } = await cms.content.bySlug('post', 'hello-world', { locale: 'en' });

// Read a setting
const siteName = await cms.settings.get<string>('site.name');

// Submit a form
await cms.forms.submit('contact', { email: 'a@b.com', message: 'hi' });
```

## Server-side webhook verification

```ts
import { webhookHandler } from '@skelpo/cms-client';

app.post('/webhooks/cms', webhookHandler({
  secret: process.env.CMS_WEBHOOK_SECRET!,
  onEvent: async (payload) => {
    if (payload.event === 'content.published') {
      await revalidate(payload.data.url);
    }
  },
}));
```

## Caching

Pass `cache: 'auto'` (default) for an in-memory cache that revalidates with the CMS via ETags — stale-while-revalidate semantics, never serves stale data after the CMS has changed.

Pass `cache: 'none'` to disable.

For custom caches (Redis, KV, etc.) implement the small `SdkCache` interface.

## API surface

```ts
cms.content.list(type, opts)
cms.content.bySlug(type, slug, opts)
cms.content.byId(id, opts)

cms.settings.get<T>(key)
cms.settings.getAll()

cms.menus.get(slug, opts)

cms.forms.submit(slug, fields)

webhookHandler({ secret, onEvent })
```

All response bodies are typed `ContentPublic<TFields>`, `SeoFields`, `MenuTree`, etc. — see [`./dist/index.d.ts`](./dist/index.d.ts).

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
