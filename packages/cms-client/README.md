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

## Full API surface

Every endpoint the CMS exposes is mirrored as a typed method. Public reads work without a token; mutations require a Bearer API token created via `skelpo-cms tokens create` (or POSTing to `/api/v1/auth/tokens`).

```ts
// Authentication
cms.auth.login(email, password, totpCode?)
cms.auth.logout()
cms.auth.me()
cms.auth.refresh()
cms.auth.tokens.list / create({ name, scopes?, ttlDays? }) / revoke(id)

// Content — read + write
cms.content.list(type, { locale?, limit?, cursor?, sort?, include? })
cms.content.bySlug(type, slug, { locale?, include? })
cms.content.byId(id, { include? })
cms.content.byPath('/blog/hello')
cms.content.create({ type, slug, locale, title, fields, seo?, ai?, status?, translationOf? })
cms.content.update(id, patch)
cms.content.publish(id) / unpublish(id) / delete(id)

// Content types (registry + schema evolution)
cms.types.list / get(slug) / revisions(slug)
cms.types.create({ slug, labelSingular, labelPlural, fieldsSchema, ... })
cms.types.evolve(slug, patch, { dryRun? })
cms.types.delete(slug, { force? })

// Settings
cms.settings.all() / get<T>(key) / set(key, value) / setMany({ ... })

// Menus
cms.menus.list / bySlug(slug, { locale? })
cms.menus.create({ slug, label })
cms.menus.update(slug, { label? }) / delete(slug)
cms.menus.addItem(slug, { label, url, target?, sortOrder?, parentId? })
cms.menus.updateItem(slug, id, patch) / removeItem(slug, id)
cms.menus.reorderItems(slug, items)

// Media (storage-agnostic backend: local disk or S3-compatible)
cms.media.list({ mimeType?, limit? }) / get(id)
cms.media.rawUrl(id)                       // public URL (302 → CDN if configured)
cms.media.signedUrl(id, { w, h, format, quality, fit })
cms.media.upload({ file: Blob, filename, mimeType?, altText, focalPoint? })
cms.media.update(id, { altText?, focalPoint?, filename? })
cms.media.delete(id)

// Users + roles
cms.users.list / create({ email, displayName, password, roleSlug })
cms.users.update(id, patch) / suspend(id) / unsuspend(id)
cms.roles.list / create({ slug, label, capabilities }) / update(slug, patch) / delete(slug)

// Redirects
cms.redirects.list / create({ fromPath, toPath, statusCode? })
cms.redirects.update(id, patch) / delete(id) / resolve(path)

// Webhooks
cms.webhooks.list / create({ url, events, secret?, active? })
cms.webhooks.update(id, patch) / delete(id) / deliveries(id)

// Jobs (queue inspection + retry)
cms.jobs.stats / list({ status?, limit? }) / get(id) / retry(id)

// Forms
cms.forms.submit(slug, data)                       // public
cms.forms.submissions(slug, { limit? })            // authed
cms.forms.deleteSubmission(id) / markSpam(id)

// Webhook receiver (server side)
webhookHandler({ secret, onEvent })
```

All response bodies are typed: `ContentPublic<TFields>`, `MediaRow`, `UserRow`, `MenuTree`, `JobRow`, `ApiTokenCreated`, etc. — see [`./dist/index.d.ts`](./dist/index.d.ts) for the full set.

## Writes + cache invalidation

When `cache: 'auto'` is set and a write op runs in-process, the client invalidates cached reads of the affected resource (`GET:/content`, `GET:/menus`, etc.). Cross-process invalidation should still come via webhooks — wire `webhookHandler` to forward `surrogate-key` deps to `cms.invalidate(deps)`.

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
