# Skelpo CMS — Database Schema

**Status:** Draft v0.1 — design contract.
**Date:** 2026-05-19
**Engine:** MySQL 8.0+ (or MariaDB 11+) via [`@perryts/mysql`](https://www.npmjs.com/package/@perryts/mysql) — pure-TypeScript wire-protocol driver, zero native deps.

This document is the authoritative SQL schema for Skelpo CMS. The migration runner in `src/db/migrate.ts` applies files from `migrations/*.sql` in lexical order and records applied versions in `schemaMigrations`.

---

## Conventions

- **Naming:** camelCase for both table and column names. Identifiers backtick-quoted in queries where ambiguity could arise (`content` is a reserved-ish word in some MySQL contexts).
- **Engine:** `InnoDB`. Foreign keys, row-level locks, transactions.
- **Charset/collation:** `utf8mb4` / `utf8mb4_0900_ai_ci`. Full Unicode incl. emoji + accent-insensitive search.
- **IDs:** `BIGINT UNSIGNED AUTO_INCREMENT` for content/users/jobs; `INT UNSIGNED` for low-cardinality lookups (roles, types, menus). All <2^53 to stay safe across JSON serialization.
- **Timestamps:** `TIMESTAMP` columns store UTC; defaults `NOW()`. `updatedAt` uses `ON UPDATE NOW()`. App treats timestamps as UTC ISO 8601 at the API boundary.
- **JSON columns:** validated at the app layer. Used liberally for flexible schemas (`fields`, `seo`, `ai`, `capabilities`, `payload`).
- **Soft delete:** content uses `status='archived'` rather than a `deletedAt` column. Hard-delete requires explicit admin action.
- **Indexes:** named `idx_<table>_<columns>` for non-unique, `uq_<table>_<columns>` for unique. FKs auto-named.
- **Foreign keys:** `ON DELETE CASCADE` for child rows (relations, revisions, items); `ON DELETE SET NULL` for soft refs (authorId, menu→content link); restricted otherwise.

---

## Migration tracking

```sql
CREATE TABLE `schemaMigrations` (
  `version`     VARCHAR(64)  NOT NULL,           -- e.g. '0001_initial'
  `appliedAt`   TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `checksum`    CHAR(64)     NOT NULL,           -- sha256 of file contents
  PRIMARY KEY (`version`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
```

Migration runner refuses to apply if a file's checksum differs from the recorded value — protects against accidental edits of already-applied migrations.

---

## 1. Content types

### `contentTypes`

Type definitions for built-in and custom content. The active `fieldsSchema` is denormalized here for read speed; full revision history lives in `contentTypeRevisions`.

```sql
CREATE TABLE `contentTypes` (
  `id`              INT UNSIGNED  NOT NULL AUTO_INCREMENT,
  `slug`            VARCHAR(64)   NOT NULL,
  `labelSingular`   VARCHAR(128)  NOT NULL,
  `labelPlural`     VARCHAR(128)  NOT NULL,
  `isBuiltin`       TINYINT(1)    NOT NULL DEFAULT 0,
  `isRoutable`      TINYINT(1)    NOT NULL DEFAULT 1,
  `urlPattern`      VARCHAR(255)  DEFAULT NULL,           -- e.g. '/blog/:slug'
  `fieldsSchema`    JSON          NOT NULL,
  `currentRevision` INT UNSIGNED  NOT NULL DEFAULT 1,
  `listQuery`       JSON          DEFAULT NULL,           -- default sort/filter for admin
  `icon`            VARCHAR(64)   DEFAULT NULL,
  `sortOrder`       INT           NOT NULL DEFAULT 0,
  `createdAt`       TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updatedAt`       TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_contentTypes_slug` (`slug`),
  KEY `idx_contentTypes_sortOrder` (`sortOrder`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
```

### `contentTypeRevisions`

Schema history. Every change creates a new revision; `contentTypes.currentRevision` points to the active one.

```sql
CREATE TABLE `contentTypeRevisions` (
  `id`             BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `typeId`         INT UNSIGNED    NOT NULL,
  `revision`       INT UNSIGNED    NOT NULL,
  `fieldsSchema`   JSON            NOT NULL,
  `changes`        JSON            NOT NULL,    -- {added, removed, renamed, retyped}
  `authorId`       BIGINT UNSIGNED DEFAULT NULL,
  `note`           VARCHAR(255)    DEFAULT NULL,
  `createdAt`      TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_contentTypeRevisions_typeRev` (`typeId`, `revision`),
  CONSTRAINT `fk_contentTypeRevisions_typeId`
    FOREIGN KEY (`typeId`) REFERENCES `contentTypes`(`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_contentTypeRevisions_authorId`
    FOREIGN KEY (`authorId`) REFERENCES `users`(`id`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
```

### `fieldsSchema` JSON shape

```json
{
  "version": 1,
  "fields": [
    {
      "name": "subtitle",
      "type": "text",
      "label": "Subtitle",
      "translatable": true,
      "required": false,
      "validation": { "maxLength": 200 }
    },
    {
      "name": "body",
      "type": "richtext",
      "label": "Body",
      "translatable": true,
      "required": true,
      "richtext": { "allowCodeBlocks": true, "allowEmbeds": true, "allowImages": true }
    },
    {
      "name": "heroImage",
      "type": "image",
      "label": "Hero",
      "required": true
    },
    {
      "name": "relatedPosts",
      "type": "relation",
      "label": "Related Posts",
      "relation": { "toType": "post", "many": true, "max": 3 }
    },
    {
      "name": "highlights",
      "type": "repeater",
      "label": "Highlights",
      "translatable": true,
      "repeater": {
        "fields": [
          { "name": "icon", "type": "select", "options": ["zap", "shield", "rocket"] },
          { "name": "title", "type": "text", "required": true },
          { "name": "description", "type": "textarea" }
        ],
        "min": 0, "max": 12
      }
    }
  ]
}
```

### `changes` JSON shape

```json
{
  "added":   [ { "name": "ctaText", "default": "Learn more" } ],
  "removed": [ { "name": "deprecatedField" } ],
  "renamed": [ { "from": "subtitle", "to": "tagline" } ],
  "retyped": [ { "name": "priority", "from": "text", "to": "number", "transform": "parseInt" } ]
}
```

---

## 2. Content

The hot-path table. Heavily indexed.

```sql
CREATE TABLE `content` (
  `id`                  BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `typeId`              INT UNSIGNED    NOT NULL,
  `typeSlug`            VARCHAR(64)     NOT NULL,        -- denormalized for index lookups
  `slug`                VARCHAR(255)    NOT NULL,
  `locale`              VARCHAR(10)     NOT NULL,        -- BCP-47, e.g. 'en' or 'de-CH'
  `translationGroupId`  BIGINT UNSIGNED NOT NULL,        -- equals self.id for the canonical row
  `status`              ENUM('draft','review','published','archived') NOT NULL DEFAULT 'draft',
  `title`               VARCHAR(512)    NOT NULL,
  `fields`              JSON            NOT NULL,        -- custom field values
  `seo`                 JSON            NOT NULL,        -- {metaTitle, metaDescription, canonicalUrl, ogImage, schemaType, noindex}
  `ai`                  JSON            NOT NULL,        -- {summary, agentContext}
  `authorId`            BIGINT UNSIGNED DEFAULT NULL,
  `publishedAt`         TIMESTAMP       NULL DEFAULT NULL,
  `scheduledAt`         TIMESTAMP       NULL DEFAULT NULL,
  `revision`            INT UNSIGNED    NOT NULL DEFAULT 1,
  `schemaRevision`      INT UNSIGNED    NOT NULL DEFAULT 1,
  `createdAt`           TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updatedAt`           TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_content_slug` (`typeSlug`, `slug`, `locale`),
  KEY `idx_content_published` (`typeSlug`, `status`, `locale`, `publishedAt` DESC),
  KEY `idx_content_scheduled` (`status`, `scheduledAt`),
  KEY `idx_content_group`     (`translationGroupId`),
  KEY `idx_content_author`    (`authorId`),
  KEY `idx_content_type`      (`typeId`),
  FULLTEXT KEY `ft_content_title` (`title`),
  CONSTRAINT `fk_content_typeId`
    FOREIGN KEY (`typeId`) REFERENCES `contentTypes`(`id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_content_authorId`
    FOREIGN KEY (`authorId`) REFERENCES `users`(`id`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
```

**`seo` JSON shape:**
```json
{
  "metaTitle": "Optional, overrides title in <title>",
  "metaDescription": "Required for publish, 70-160 chars",
  "canonicalUrl": "Optional override",
  "ogImage": 42,                  // media id
  "ogTitle": "Optional",
  "ogDescription": "Optional",
  "schemaType": "Article",        // schema.org override
  "noindex": false,
  "hreflangOverrides": {}         // optional per-locale URL overrides
}
```

**`ai` JSON shape:**
```json
{
  "summary": "1-2 sentence summary for llms.txt",
  "agentContext": "Additional context for AI/agent consumption"
}
```

**Hot-path query** (single content fetch by URL):
```sql
SELECT * FROM `content`
WHERE `typeSlug` = ? AND `slug` = ? AND `locale` = ? AND `status` = 'published'
LIMIT 1;
```
Uses `uq_content_slug` index — one row read, <1ms.

**Optional functional indexes** (add per-deployment based on query patterns):
```sql
-- For "filter posts by category JSON field"
ALTER TABLE `content`
  ADD INDEX `idx_content_category` ((CAST(`fields`->>'$.category' AS CHAR(64))));
```

### `contentRelations`

Many-to-many relation links between content rows. Used for `relation` field types.

```sql
CREATE TABLE `contentRelations` (
  `fromId`     BIGINT UNSIGNED NOT NULL,
  `fromField`  VARCHAR(64)     NOT NULL,
  `toId`       BIGINT UNSIGNED NOT NULL,
  `sortOrder`  INT             NOT NULL DEFAULT 0,
  PRIMARY KEY (`fromId`, `fromField`, `toId`),
  KEY `idx_contentRelations_reverse` (`toId`, `fromField`),
  CONSTRAINT `fk_contentRelations_fromId`
    FOREIGN KEY (`fromId`) REFERENCES `content`(`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_contentRelations_toId`
    FOREIGN KEY (`toId`)   REFERENCES `content`(`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
```

**Relation fetch query** (one trip for all relations of one content row):
```sql
SELECT cr.`fromField`, cr.`sortOrder`, c.*
FROM `contentRelations` cr
JOIN `content` c ON c.`id` = cr.`toId`
WHERE cr.`fromId` = ?
ORDER BY cr.`fromField`, cr.`sortOrder`;
```

### `contentRevisions`

Per-content edit history. One row per save (including autosaves and publishes).

```sql
CREATE TABLE `contentRevisions` (
  `id`         BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `contentId`  BIGINT UNSIGNED NOT NULL,
  `revision`   INT UNSIGNED    NOT NULL,
  `snapshot`   JSON            NOT NULL,     -- full row + relations at this revision
  `authorId`   BIGINT UNSIGNED DEFAULT NULL,
  `reason`     VARCHAR(255)    DEFAULT NULL, -- 'autosave','publish','rollback from r5'
  `createdAt`  TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_contentRevisions_contentRev` (`contentId`, `revision`),
  KEY `idx_contentRevisions_content` (`contentId`, `createdAt` DESC),
  CONSTRAINT `fk_contentRevisions_contentId`
    FOREIGN KEY (`contentId`) REFERENCES `content`(`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_contentRevisions_authorId`
    FOREIGN KEY (`authorId`)  REFERENCES `users`(`id`)   ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
```

**Retention policy** (configurable, defaults):
- Keep all `publish` and `rollback` revisions forever
- Keep autosaves for 30 days
- Background job `pruneContentRevisions` runs daily

---

## 3. Authentication

### `users`

```sql
CREATE TABLE `users` (
  `id`               BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `email`            VARCHAR(255)    NOT NULL,
  `passwordHash`     VARCHAR(255)    NOT NULL,         -- bcryptjs hash
  `displayName`      VARCHAR(128)    NOT NULL,
  `roleId`           INT UNSIGNED    NOT NULL,
  `locale`           VARCHAR(10)     NOT NULL DEFAULT 'en',
  `totpSecret`       VARCHAR(64)     DEFAULT NULL,     -- NULL = 2FA not set up
  `totpVerified`     TINYINT(1)      NOT NULL DEFAULT 0,
  `status`           ENUM('active','suspended','invited') NOT NULL DEFAULT 'invited',
  `inviteToken`      VARCHAR(64)     DEFAULT NULL,
  `inviteExpiresAt`  TIMESTAMP       NULL DEFAULT NULL,
  `lastLoginAt`      TIMESTAMP       NULL DEFAULT NULL,
  `createdAt`        TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updatedAt`        TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_users_email` (`email`),
  KEY `idx_users_role` (`roleId`),
  KEY `idx_users_inviteToken` (`inviteToken`),
  CONSTRAINT `fk_users_roleId`
    FOREIGN KEY (`roleId`) REFERENCES `roles`(`id`) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
```

### `roles`

```sql
CREATE TABLE `roles` (
  `id`            INT UNSIGNED   NOT NULL AUTO_INCREMENT,
  `slug`          VARCHAR(64)    NOT NULL,
  `label`         VARCHAR(128)   NOT NULL,
  `capabilities`  JSON           NOT NULL,
  `isBuiltin`     TINYINT(1)     NOT NULL DEFAULT 0,
  `createdAt`     TIMESTAMP      NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updatedAt`     TIMESTAMP      NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_roles_slug` (`slug`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
```

**`capabilities` JSON shape:**
```json
{
  "global": ["manageUsers", "manageRoles", "viewAnalytics"],
  "types": {
    "page":    ["read", "create", "update", "delete", "publish", "readDrafts"],
    "post":    ["read", "create", "update", "delete", "publish", "readDrafts"],
    "service": ["read", "create", "updateOwn", "deleteOwn"],
    "*":       ["read"]
  }
}
```

### `sessions`

DB-backed sessions for admin browser cookie auth. Bearer tokens use `apiTokens` instead.

```sql
CREATE TABLE `sessions` (
  `id`         CHAR(64)        NOT NULL,         -- random 256-bit hex
  `userId`     BIGINT UNSIGNED NOT NULL,
  `expiresAt`  TIMESTAMP       NOT NULL,
  `ip`         VARCHAR(45)     DEFAULT NULL,
  `userAgent`  VARCHAR(255)    DEFAULT NULL,
  `createdAt`  TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_sessions_user` (`userId`),
  KEY `idx_sessions_expiresAt` (`expiresAt`),
  CONSTRAINT `fk_sessions_userId`
    FOREIGN KEY (`userId`) REFERENCES `users`(`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
```

A background job prunes expired sessions hourly.

### `apiTokens`

Long-lived bearer tokens for SDK and mobile clients.

```sql
CREATE TABLE `apiTokens` (
  `id`           BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `userId`       BIGINT UNSIGNED NOT NULL,
  `name`         VARCHAR(128)    NOT NULL,
  `tokenHash`    CHAR(64)        NOT NULL,        -- sha256 of plaintext token
  `prefix`       VARCHAR(16)     NOT NULL,        -- first 8 chars of token for display
  `scopes`       JSON            NOT NULL,        -- ['readContent', 'submitForms', ...]
  `lastUsedAt`   TIMESTAMP       NULL DEFAULT NULL,
  `expiresAt`    TIMESTAMP       NULL DEFAULT NULL,  -- NULL = never expires
  `revokedAt`    TIMESTAMP       NULL DEFAULT NULL,
  `createdAt`    TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_apiTokens_tokenHash` (`tokenHash`),
  KEY `idx_apiTokens_user` (`userId`),
  CONSTRAINT `fk_apiTokens_userId`
    FOREIGN KEY (`userId`) REFERENCES `users`(`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
```

### `passwordResets`

Reset tokens sent via email.

```sql
CREATE TABLE `passwordResets` (
  `token`      CHAR(64)        NOT NULL,         -- random hex
  `userId`     BIGINT UNSIGNED NOT NULL,
  `expiresAt`  TIMESTAMP       NOT NULL,
  `usedAt`     TIMESTAMP       NULL DEFAULT NULL,
  `createdAt`  TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`token`),
  KEY `idx_passwordResets_user` (`userId`),
  CONSTRAINT `fk_passwordResets_userId`
    FOREIGN KEY (`userId`) REFERENCES `users`(`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
```

### `loginAttempts`

Rate-limit + brute-force detection store.

```sql
CREATE TABLE `loginAttempts` (
  `id`         BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `email`      VARCHAR(255)    NOT NULL,
  `ip`         VARCHAR(45)     NOT NULL,
  `success`    TINYINT(1)      NOT NULL DEFAULT 0,
  `createdAt`  TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_loginAttempts_emailTime` (`email`, `createdAt`),
  KEY `idx_loginAttempts_ipTime`    (`ip`, `createdAt`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
```

Pruned daily (keep last 30 days).

---

## 4. Media

```sql
CREATE TABLE `media` (
  `id`           BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `filename`     VARCHAR(255)    NOT NULL,
  `mimeType`     VARCHAR(128)    NOT NULL,
  `sizeBytes`    BIGINT UNSIGNED NOT NULL,
  `storageKey`   VARCHAR(512)    NOT NULL,         -- path in storage backend
  `width`        INT             DEFAULT NULL,
  `height`       INT             DEFAULT NULL,
  `altText`      JSON            NOT NULL,         -- {en: "...", de: "..."}
  `focalPoint`   JSON            DEFAULT NULL,     -- {x: 0.5, y: 0.4}
  `uploadedBy`   BIGINT UNSIGNED DEFAULT NULL,
  `createdAt`    TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updatedAt`    TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_media_mimeType` (`mimeType`),
  KEY `idx_media_uploadedBy` (`uploadedBy`),
  FULLTEXT KEY `ft_media_filename` (`filename`),
  CONSTRAINT `fk_media_uploadedBy`
    FOREIGN KEY (`uploadedBy`) REFERENCES `users`(`id`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
```

Media usage tracking (which content references this media) is computed via JSON path queries on `content.fields` + `content.seo.ogImage` rather than a separate join table — cheap enough for the admin-only "what links here" view.

---

## 5. Menus

### `menus`

```sql
CREATE TABLE `menus` (
  `id`         INT UNSIGNED  NOT NULL AUTO_INCREMENT,
  `slug`       VARCHAR(64)   NOT NULL,
  `label`      VARCHAR(128)  NOT NULL,
  `isBuiltin`  TINYINT(1)    NOT NULL DEFAULT 0,
  `createdAt`  TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updatedAt`  TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_menus_slug` (`slug`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
```

### `menuItems`

Self-referential adjacency-list tree.

```sql
CREATE TABLE `menuItems` (
  `id`          INT UNSIGNED  NOT NULL AUTO_INCREMENT,
  `menuId`      INT UNSIGNED  NOT NULL,
  `parentId`    INT UNSIGNED  DEFAULT NULL,
  `label`       JSON          NOT NULL,            -- {en: "About", de: "Über uns"}
  `url`         VARCHAR(512)  DEFAULT NULL,        -- explicit URL OR
  `contentId`   BIGINT UNSIGNED DEFAULT NULL,      -- link to content (mutually exclusive with url)
  `target`      ENUM('_self','_blank') NOT NULL DEFAULT '_self',
  `sortOrder`   INT           NOT NULL DEFAULT 0,
  `createdAt`   TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updatedAt`   TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_menuItems_tree` (`menuId`, `parentId`, `sortOrder`),
  KEY `idx_menuItems_content` (`contentId`),
  CONSTRAINT `fk_menuItems_menuId`
    FOREIGN KEY (`menuId`)   REFERENCES `menus`(`id`)     ON DELETE CASCADE,
  CONSTRAINT `fk_menuItems_parentId`
    FOREIGN KEY (`parentId`) REFERENCES `menuItems`(`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_menuItems_contentId`
    FOREIGN KEY (`contentId`) REFERENCES `content`(`id`)  ON DELETE SET NULL,
  CONSTRAINT `chk_menuItems_target` CHECK (
    (`url` IS NOT NULL AND `contentId` IS NULL) OR
    (`url` IS NULL AND `contentId` IS NOT NULL) OR
    (`url` IS NULL AND `contentId` IS NULL)            -- "parent label only" item
  )
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
```

Whole-menu fetch is one query over the `(menuId, parentId, sortOrder)` index; app reassembles the tree client-side (cheap).

---

## 6. Settings

```sql
CREATE TABLE `settings` (
  `keyName`     VARCHAR(128)  NOT NULL,
  `value`       JSON          NOT NULL,
  `updatedAt`   TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  `updatedBy`   BIGINT UNSIGNED DEFAULT NULL,
  PRIMARY KEY (`keyName`),
  CONSTRAINT `fk_settings_updatedBy`
    FOREIGN KEY (`updatedBy`) REFERENCES `users`(`id`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
```

Flat key-value store with dot-namespaced keys. All settings loaded into in-memory map at boot; refreshed on any write or webhook.

**Standard keys:**
- `site.name`, `site.tagline`, `site.url`, `site.defaultLocale`, `site.locales`
- `site.logoMediaId`, `site.faviconMediaId`
- `site.social.twitter`, `site.social.github`, `site.social.linkedin`, etc.
- `site.contact.email`, `site.contact.phone`, `site.contact.address`
- `seo.defaultOgImageId`, `seo.robots`, `seo.organizationSchema`
- `ai.llmsTxtIntro`
- `email.fromAddress`, `email.fromName`, `email.replyTo`
- `image.imgproxyBaseUrl` (overrides env var if set)

---

## 7. Redirects

```sql
CREATE TABLE `redirects` (
  `id`            INT UNSIGNED   NOT NULL AUTO_INCREMENT,
  `source`        VARCHAR(512)   NOT NULL,
  `destination`   VARCHAR(512)   NOT NULL,
  `statusCode`    SMALLINT       NOT NULL DEFAULT 301,
  `hitCount`      BIGINT UNSIGNED NOT NULL DEFAULT 0,
  `lastHitAt`     TIMESTAMP      NULL DEFAULT NULL,
  `createdAt`     TIMESTAMP      NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updatedAt`     TIMESTAMP      NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_redirects_source` (`source`),
  CONSTRAINT `chk_redirects_statusCode` CHECK (`statusCode` IN (301, 302, 307, 308))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
```

Loaded into in-memory map at boot for O(1) lookup. `hitCount` increment is debounced (batched updates every 60s).

---

## 8. Forms

Form definitions are content rows of type `form` (built-in type). Submissions are separate.

### `formSubmissions`

```sql
CREATE TABLE `formSubmissions` (
  `id`           BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `formId`       BIGINT UNSIGNED NOT NULL,           -- → content.id (content.typeSlug='form')
  `data`         JSON            NOT NULL,           -- field values
  `ip`           VARCHAR(45)     DEFAULT NULL,
  `userAgent`    VARCHAR(255)    DEFAULT NULL,
  `isSpam`       TINYINT(1)      NOT NULL DEFAULT 0,
  `notifiedAt`   TIMESTAMP       NULL DEFAULT NULL,
  `createdAt`    TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_formSubmissions_form` (`formId`, `createdAt` DESC),
  KEY `idx_formSubmissions_spam` (`isSpam`, `createdAt` DESC),
  CONSTRAINT `fk_formSubmissions_formId`
    FOREIGN KEY (`formId`) REFERENCES `content`(`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
```

---

## 9. Email templates

```sql
CREATE TABLE `emailTemplates` (
  `id`         INT UNSIGNED  NOT NULL AUTO_INCREMENT,
  `slug`       VARCHAR(64)   NOT NULL,
  `locale`     VARCHAR(10)   NOT NULL DEFAULT 'en',
  `subject`    VARCHAR(255)  NOT NULL,
  `bodyHtml`   MEDIUMTEXT    NOT NULL,
  `bodyText`   MEDIUMTEXT    NOT NULL,
  `variables`  JSON          DEFAULT NULL,         -- expected vars for validation
  `isBuiltin`  TINYINT(1)    NOT NULL DEFAULT 0,
  `createdAt`  TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updatedAt`  TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_emailTemplates_slugLocale` (`slug`, `locale`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
```

**Built-in slugs:** `passwordReset`, `userInvite`, `formNotification`, `formAutoresponder`, `webhookFailureAlert`.

---

## 10. Background jobs

```sql
CREATE TABLE `jobs` (
  `id`            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `kind`          VARCHAR(64)     NOT NULL,
  `payload`       JSON            NOT NULL,
  `runAt`         TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `attempts`      INT UNSIGNED    NOT NULL DEFAULT 0,
  `maxAttempts`   INT UNSIGNED    NOT NULL DEFAULT 5,
  `status`        ENUM('pending','running','done','failed','dead') NOT NULL DEFAULT 'pending',
  `lockedBy`      VARCHAR(64)     DEFAULT NULL,
  `lockedAt`      TIMESTAMP       NULL DEFAULT NULL,
  `lastError`     TEXT            DEFAULT NULL,
  `createdAt`     TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `completedAt`   TIMESTAMP       NULL DEFAULT NULL,
  PRIMARY KEY (`id`),
  KEY `idx_jobs_pending` (`status`, `runAt`),
  KEY `idx_jobs_kind`    (`kind`, `status`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
```

**Job kinds (v0.1):**

- `sendEmail` — `{ templateSlug, to, variables, locale }`
- `preRender` — `{ url, locale }` — warm a public-site cache entry
- `webhookDispatch` — `{ webhookId, event, data, depKeys }`
- `scheduledPublish` — `{ contentId }`
- `regenSitemap` — `{}`
- `regenLlmsTxt` — `{}`
- `pruneSessions` — `{}` (recurring)
- `pruneLoginAttempts` — `{}` (recurring)
- `pruneContentRevisions` — `{}` (recurring)
- `imgproxyWarm` — `{ mediaId, variants }`

**Worker locking pattern:**
```sql
UPDATE `jobs`
SET `status` = 'running', `lockedBy` = ?, `lockedAt` = NOW(), `attempts` = `attempts` + 1
WHERE `id` = (
  SELECT `id` FROM (
    SELECT `id` FROM `jobs`
    WHERE `status` = 'pending' AND `runAt` <= NOW()
    ORDER BY `runAt` ASC
    LIMIT 1
    FOR UPDATE SKIP LOCKED
  ) t
);
```

`SKIP LOCKED` is MySQL 8+ — lets multiple workers poll concurrently without blocking each other.

---

## 11. Webhooks

### `webhooks`

```sql
CREATE TABLE `webhooks` (
  `id`         BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `url`        VARCHAR(512)    NOT NULL,
  `events`     JSON            NOT NULL,            -- array of event names
  `secret`     CHAR(64)        NOT NULL,            -- HMAC signing key
  `active`     TINYINT(1)      NOT NULL DEFAULT 1,
  `description` VARCHAR(255)   DEFAULT NULL,
  `createdAt`  TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updatedAt`  TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_webhooks_active` (`active`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
```

### `webhookDeliveries`

Audit log for outbound webhook calls (keeps last N per webhook, configurable).

```sql
CREATE TABLE `webhookDeliveries` (
  `id`             BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `webhookId`      BIGINT UNSIGNED NOT NULL,
  `event`          VARCHAR(64)     NOT NULL,
  `payload`        JSON            NOT NULL,
  `requestHeaders` JSON            NOT NULL,
  `responseStatus` INT             DEFAULT NULL,
  `responseBody`   MEDIUMTEXT      DEFAULT NULL,
  `latencyMs`      INT UNSIGNED    DEFAULT NULL,
  `attempt`        INT UNSIGNED    NOT NULL DEFAULT 1,
  `succeeded`      TINYINT(1)      NOT NULL DEFAULT 0,
  `error`          TEXT            DEFAULT NULL,
  `createdAt`      TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_webhookDeliveries_webhookTime` (`webhookId`, `createdAt` DESC),
  KEY `idx_webhookDeliveries_event` (`event`, `createdAt` DESC),
  CONSTRAINT `fk_webhookDeliveries_webhookId`
    FOREIGN KEY (`webhookId`) REFERENCES `webhooks`(`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
```

Retention: keep last 100 per webhook + last 7 days; pruned daily.

---

## 12. Analytics

Partitioned monthly for retention + drop-old efficiency.

```sql
CREATE TABLE `analyticsEvents` (
  `id`              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `path`            VARCHAR(512)    NOT NULL,
  `locale`          VARCHAR(10)     DEFAULT NULL,
  `referrer`        VARCHAR(512)    DEFAULT NULL,
  `ipHash`          CHAR(64)        DEFAULT NULL,     -- sha256(ip + dailySalt)
  `userAgentHash`   CHAR(64)        DEFAULT NULL,     -- sha256(userAgent)
  `country`         CHAR(2)         DEFAULT NULL,
  `createdAt`       TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`, `createdAt`),
  KEY `idx_analyticsEvents_pathTime` (`path`, `createdAt`),
  KEY `idx_analyticsEvents_time` (`createdAt`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
PARTITION BY RANGE (TO_DAYS(`createdAt`)) (
  PARTITION p2026_05 VALUES LESS THAN (TO_DAYS('2026-06-01')),
  PARTITION p2026_06 VALUES LESS THAN (TO_DAYS('2026-07-01')),
  PARTITION pFuture  VALUES LESS THAN MAXVALUE
);
```

**GDPR notes:**
- No raw IP stored. `ipHash` uses a daily-rotated salt so cross-day correlation is impossible.
- No user-agent string stored, only a hash.
- No cookies set by the analytics ingest.
- Retention: 13 months default (configurable). Background job drops old partitions monthly.

Daily `analyticsRollups` table (optional, added in v0.2) precomputes aggregates for the admin dashboard.

---

## 13. Audit log

```sql
CREATE TABLE `auditLog` (
  `id`          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `userId`      BIGINT UNSIGNED DEFAULT NULL,
  `action`      VARCHAR(64)     NOT NULL,           -- 'contentPublished', 'userLogin', 'roleUpdated'
  `entityType`  VARCHAR(64)     DEFAULT NULL,
  `entityId`    BIGINT UNSIGNED DEFAULT NULL,
  `changes`     JSON            DEFAULT NULL,       -- diff for updates
  `ip`          VARCHAR(45)     DEFAULT NULL,
  `userAgent`   VARCHAR(255)    DEFAULT NULL,
  `createdAt`   TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_auditLog_userTime` (`userId`, `createdAt` DESC),
  KEY `idx_auditLog_entity` (`entityType`, `entityId`, `createdAt` DESC),
  KEY `idx_auditLog_actionTime` (`action`, `createdAt` DESC),
  CONSTRAINT `fk_auditLog_userId`
    FOREIGN KEY (`userId`) REFERENCES `users`(`id`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
```

Retention: 1 year default. Critical actions (`userCreated`, `roleUpdated`, `contentPublished`) optionally kept forever via config.

---

## Index summary

The indexes that matter most for hot paths:

| Query | Table | Index used |
|---|---|---|
| Resolve URL → content | `content` | `uq_content_slug` (typeSlug, slug, locale) |
| List published content of type | `content` | `idx_content_published` (typeSlug, status, locale, publishedAt DESC) |
| Find scheduled posts | `content` | `idx_content_scheduled` (status, scheduledAt) |
| Find translations of a row | `content` | `idx_content_group` (translationGroupId) |
| Fetch relations of content | `contentRelations` | PK (fromId, fromField, toId) |
| Reverse "what links here" | `contentRelations` | `idx_contentRelations_reverse` (toId, fromField) |
| User login by email | `users` | `uq_users_email` |
| Session lookup | `sessions` | PK on (id) |
| API token validation | `apiTokens` | `uq_apiTokens_tokenHash` |
| Pop next job | `jobs` | `idx_jobs_pending` (status, runAt) |
| Fetch menu tree | `menuItems` | `idx_menuItems_tree` (menuId, parentId, sortOrder) |
| Brute-force check | `loginAttempts` | `idx_loginAttempts_emailTime`, `idx_loginAttempts_ipTime` |
| Analytics time-series | `analyticsEvents` | `idx_analyticsEvents_time` + partitions |

---

## Foreign key cascade behavior

| Parent → Child | On parent delete |
|---|---|
| `users` → `content.authorId` | SET NULL (preserves content; orphan author) |
| `users` → `contentRevisions.authorId` | SET NULL |
| `users` → `sessions.userId` | CASCADE |
| `users` → `apiTokens.userId` | CASCADE |
| `users` → `passwordResets.userId` | CASCADE |
| `users` → `media.uploadedBy` | SET NULL |
| `users` → `settings.updatedBy` | SET NULL |
| `users` → `auditLog.userId` | SET NULL |
| `roles` → `users.roleId` | RESTRICT (must reassign users first) |
| `contentTypes` → `content.typeId` | RESTRICT (must delete/move content first) |
| `contentTypes` → `contentTypeRevisions.typeId` | CASCADE |
| `content` → `contentRelations.fromId/toId` | CASCADE |
| `content` → `contentRevisions.contentId` | CASCADE |
| `content` → `formSubmissions.formId` | CASCADE |
| `content` → `menuItems.contentId` | SET NULL (menu item becomes a dead link, admin warns) |
| `menus` → `menuItems.menuId` | CASCADE |
| `menuItems` → `menuItems.parentId` | CASCADE |
| `webhooks` → `webhookDeliveries.webhookId` | CASCADE |

---

## Seed data (applied on install)

### Built-in content types

| slug | labelSingular | labelPlural | isRoutable | urlPattern |
|---|---|---|---|---|
| `page` | Page | Pages | true | `/:slug` |
| `post` | Post | Posts | true | `/blog/:slug` |
| `doc` | Doc | Docs | true | `/docs/:slug` |
| `form` | Form | Forms | false | — |
| `errorPage` | Error Page | Error Pages | false | — |

Built-in types start with `isBuiltin=1` and a minimal `fieldsSchema` (title-only for most; form has `successMessage`, `redirectUrl`, `notificationEmail`, `fields` repeater).

### Built-in roles

| slug | label | summary |
|---|---|---|
| `admin` | Administrator | All capabilities |
| `editor` | Editor | Full content CRUD + publish; no user/role/settings management |
| `author` | Author | CRU + publish on own posts; read on pages |
| `contributor` | Contributor | CRU + updateOwn on assigned types; no publish |
| `viewer` | Viewer | Read-only admin |

### Built-in email templates

| slug | use |
|---|---|
| `passwordReset` | Password reset email |
| `userInvite` | New user invitation |
| `formNotification` | Sent to admin when a form is submitted |
| `formAutoresponder` | Sent to submitter as acknowledgement |
| `webhookFailureAlert` | Sent to admin when a webhook fails after max attempts |

### Built-in menus

| slug | label |
|---|---|
| `main` | Main Menu |
| `footer` | Footer Menu |

(Both start empty.)

### Built-in forms (form-type content rows)

| slug | description |
|---|---|
| `contact` | Name, email, message |
| `newsletter` | Email only |
| `quote` | Name, email, company, message, budget select |

### Default settings (seeded if missing)

```
site.name                  = "My Site"
site.url                   = "http://localhost:3000"
site.defaultLocale         = "en"
site.locales               = ["en"]
seo.robots                 = "index,follow"
seo.organizationSchema     = { "@type": "Organization", "name": "My Site" }
ai.llmsTxtIntro            = ""
email.fromAddress          = "noreply@example.com"
email.fromName             = "My Site"
```

---

## Migration ordering

Migration files in `migrations/`:

```
0001_initial.sql               # all tables, no seed data
0002_seedBuiltinTypes.sql      # contentTypes
0003_seedBuiltinRoles.sql      # roles
0004_seedBuiltinTemplates.sql  # emailTemplates
0005_seedBuiltinMenus.sql      # menus + empty menuItems
0006_seedBuiltinForms.sql      # forms (as content rows)
0007_seedDefaultSettings.sql   # settings
```

Each migration is a single transactional block. The runner records its checksum after success.

**Upgrade-safe seeding rule:** seed migrations use `INSERT IGNORE` or `INSERT ... ON DUPLICATE KEY UPDATE` only for *new* keys — never overwrite existing rows. User edits to built-in templates, roles, etc. are preserved across upgrades.

---

## Storage estimates (back-of-envelope)

Single agency-style site, 200 pages + 500 blog posts + 10 users + 5K monthly visitors:

| Table | Rows | Approx storage |
|---|---|---|
| content | ~700 | ~10 MB (JSON-heavy) |
| contentRevisions | ~5,000 | ~50 MB |
| contentRelations | ~2,000 | <1 MB |
| media | ~500 metadata | <1 MB |
| analyticsEvents | ~5,000/month | ~1 MB/month |
| auditLog | ~10,000/year | ~5 MB/year |
| jobs | ~100 pending peak | <1 MB |

Total ~100 MB for a busy small-business site after one year. Fits trivially in RAM for a small MySQL instance.

A high-traffic content site (10K posts, 1M monthly visitors): ~5 GB after a year, primarily analytics. Easily handled by a single MySQL instance with 16 GB RAM.

---

## Connection pool config (defaults)

```ts
// src/db/client.ts
import { createPool } from '@perryts/mysql';

export const pool = createPool({
  host:                process.env.DB_HOST ?? '127.0.0.1',
  port:                Number(process.env.DB_PORT ?? 3306),
  user:                process.env.DB_USER ?? 'skelpo',
  password:            process.env.DB_PASSWORD ?? '',
  database:            process.env.DB_NAME ?? 'skelpo',
  max:                 20,            // pool size
  idleTimeoutMs:       30_000,
  acquireTimeoutMs:    30_000,
  connectTimeoutMs:    10_000,
  charset:             255,           // utf8mb4_0900_ai_ci
  ssl:                 process.env.DB_SSL === 'true' ? { mode: 'verify-full' } : undefined,
  multipleStatements:  false,         // safety
  localInfile:         'refuse'       // safety
});
```

20-connection pool is plenty for a single-tenant CMS — the hot path serves from cache and doesn't touch MySQL. `@perryts/mysql` returns `QueryResult` objects: `{ rows, rowsArray, rowsRaw, fields, command, rowCount, lastInsertId, warningCount }` — *not* the mysql2 `[rows, fields]` tuple. The driver supports `pool.query()`, `pool.withConnection(cb)`, and `pool.transaction(cb)`.

---

**End of schema spec.** Once approved, the first migration file (`migrations/0001_initial.sql`) can be generated by concatenating the `CREATE TABLE` blocks above in dependency order.
