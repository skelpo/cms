-- Skelpo CMS — initial schema.
-- Idempotent: every CREATE uses IF NOT EXISTS.
-- The migration runner records this file's checksum in schemaMigrations
-- and refuses to re-apply if the checksum changes.

-- ============================================================
-- Migration tracking
-- ============================================================

CREATE TABLE IF NOT EXISTS `schemaMigrations` (
  `version`    VARCHAR(64)  NOT NULL,
  `appliedAt`  TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `checksum`   CHAR(64)     NOT NULL,
  PRIMARY KEY (`version`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- ============================================================
-- Roles (created before users; FK target)
-- ============================================================

CREATE TABLE IF NOT EXISTS `roles` (
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

-- ============================================================
-- Users
-- ============================================================

CREATE TABLE IF NOT EXISTS `users` (
  `id`               BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `email`            VARCHAR(255)    NOT NULL,
  `passwordHash`     VARCHAR(255)    NOT NULL,
  `displayName`      VARCHAR(128)    NOT NULL,
  `roleId`           INT UNSIGNED    NOT NULL,
  `locale`           VARCHAR(10)     NOT NULL DEFAULT 'en',
  `totpSecret`       VARCHAR(64)     DEFAULT NULL,
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

-- ============================================================
-- Sessions
-- ============================================================

CREATE TABLE IF NOT EXISTS `sessions` (
  `id`         CHAR(64)        NOT NULL,
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

-- ============================================================
-- API tokens
-- ============================================================

CREATE TABLE IF NOT EXISTS `apiTokens` (
  `id`         BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `userId`     BIGINT UNSIGNED NOT NULL,
  `name`       VARCHAR(128)    NOT NULL,
  `tokenHash`  CHAR(64)        NOT NULL,
  `prefix`     VARCHAR(16)     NOT NULL,
  `scopes`     JSON            NOT NULL,
  `lastUsedAt` TIMESTAMP       NULL DEFAULT NULL,
  `expiresAt`  TIMESTAMP       NULL DEFAULT NULL,
  `revokedAt`  TIMESTAMP       NULL DEFAULT NULL,
  `createdAt`  TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_apiTokens_tokenHash` (`tokenHash`),
  KEY `idx_apiTokens_user` (`userId`),
  CONSTRAINT `fk_apiTokens_userId`
    FOREIGN KEY (`userId`) REFERENCES `users`(`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- ============================================================
-- Password resets
-- ============================================================

CREATE TABLE IF NOT EXISTS `passwordResets` (
  `token`      CHAR(64)        NOT NULL,
  `userId`     BIGINT UNSIGNED NOT NULL,
  `expiresAt`  TIMESTAMP       NOT NULL,
  `usedAt`     TIMESTAMP       NULL DEFAULT NULL,
  `createdAt`  TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`token`),
  KEY `idx_passwordResets_user` (`userId`),
  CONSTRAINT `fk_passwordResets_userId`
    FOREIGN KEY (`userId`) REFERENCES `users`(`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- ============================================================
-- Login attempts (brute-force tracking)
-- ============================================================

CREATE TABLE IF NOT EXISTS `loginAttempts` (
  `id`         BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `email`      VARCHAR(255)    NOT NULL,
  `ip`         VARCHAR(45)     NOT NULL,
  `success`    TINYINT(1)      NOT NULL DEFAULT 0,
  `createdAt`  TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_loginAttempts_emailTime` (`email`, `createdAt`),
  KEY `idx_loginAttempts_ipTime`    (`ip`, `createdAt`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- ============================================================
-- Content types
-- ============================================================

CREATE TABLE IF NOT EXISTS `contentTypes` (
  `id`              INT UNSIGNED  NOT NULL AUTO_INCREMENT,
  `slug`            VARCHAR(64)   NOT NULL,
  `labelSingular`   VARCHAR(128)  NOT NULL,
  `labelPlural`     VARCHAR(128)  NOT NULL,
  `isBuiltin`       TINYINT(1)    NOT NULL DEFAULT 0,
  `isRoutable`      TINYINT(1)    NOT NULL DEFAULT 1,
  `urlPattern`      VARCHAR(255)  DEFAULT NULL,
  `fieldsSchema`    JSON          NOT NULL,
  `currentRevision` INT UNSIGNED  NOT NULL DEFAULT 1,
  `listQuery`       JSON          DEFAULT NULL,
  `icon`            VARCHAR(64)   DEFAULT NULL,
  `sortOrder`       INT           NOT NULL DEFAULT 0,
  `createdAt`       TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updatedAt`       TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_contentTypes_slug` (`slug`),
  KEY `idx_contentTypes_sortOrder` (`sortOrder`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- ============================================================
-- Content (the hot path)
-- ============================================================

CREATE TABLE IF NOT EXISTS `content` (
  `id`                  BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `typeId`              INT UNSIGNED    NOT NULL,
  `typeSlug`            VARCHAR(64)     NOT NULL,
  `slug`                VARCHAR(255)    NOT NULL,
  `locale`              VARCHAR(10)     NOT NULL,
  `translationGroupId`  BIGINT UNSIGNED NOT NULL,
  `status`              ENUM('draft','review','published','archived') NOT NULL DEFAULT 'draft',
  `title`               VARCHAR(512)    NOT NULL,
  `fields`              JSON            NOT NULL,
  `seo`                 JSON            NOT NULL,
  `ai`                  JSON            NOT NULL,
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
    FOREIGN KEY (`typeId`)   REFERENCES `contentTypes`(`id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_content_authorId`
    FOREIGN KEY (`authorId`) REFERENCES `users`(`id`)        ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- ============================================================
-- Content type revisions
-- ============================================================

CREATE TABLE IF NOT EXISTS `contentTypeRevisions` (
  `id`            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `typeId`        INT UNSIGNED    NOT NULL,
  `revision`      INT UNSIGNED    NOT NULL,
  `fieldsSchema`  JSON            NOT NULL,
  `changes`       JSON            NOT NULL,
  `authorId`      BIGINT UNSIGNED DEFAULT NULL,
  `note`          VARCHAR(255)    DEFAULT NULL,
  `createdAt`     TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_contentTypeRevisions_typeRev` (`typeId`, `revision`),
  CONSTRAINT `fk_contentTypeRevisions_typeId`
    FOREIGN KEY (`typeId`)   REFERENCES `contentTypes`(`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_contentTypeRevisions_authorId`
    FOREIGN KEY (`authorId`) REFERENCES `users`(`id`)        ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- ============================================================
-- Content relations (M2M)
-- ============================================================

CREATE TABLE IF NOT EXISTS `contentRelations` (
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

-- ============================================================
-- Content revisions (history)
-- ============================================================

CREATE TABLE IF NOT EXISTS `contentRevisions` (
  `id`         BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `contentId`  BIGINT UNSIGNED NOT NULL,
  `revision`   INT UNSIGNED    NOT NULL,
  `snapshot`   JSON            NOT NULL,
  `authorId`   BIGINT UNSIGNED DEFAULT NULL,
  `reason`     VARCHAR(255)    DEFAULT NULL,
  `createdAt`  TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_contentRevisions_contentRev` (`contentId`, `revision`),
  KEY `idx_contentRevisions_content` (`contentId`, `createdAt` DESC),
  CONSTRAINT `fk_contentRevisions_contentId`
    FOREIGN KEY (`contentId`) REFERENCES `content`(`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_contentRevisions_authorId`
    FOREIGN KEY (`authorId`)  REFERENCES `users`(`id`)   ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- ============================================================
-- Media
-- ============================================================

CREATE TABLE IF NOT EXISTS `media` (
  `id`           BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `filename`     VARCHAR(255)    NOT NULL,
  `mimeType`     VARCHAR(128)    NOT NULL,
  `sizeBytes`    BIGINT UNSIGNED NOT NULL,
  `storageKey`   VARCHAR(512)    NOT NULL,
  `width`        INT             DEFAULT NULL,
  `height`       INT             DEFAULT NULL,
  `altText`      JSON            NOT NULL,
  `focalPoint`   JSON            DEFAULT NULL,
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

-- ============================================================
-- Menus + items
-- ============================================================

CREATE TABLE IF NOT EXISTS `menus` (
  `id`         INT UNSIGNED  NOT NULL AUTO_INCREMENT,
  `slug`       VARCHAR(64)   NOT NULL,
  `label`      VARCHAR(128)  NOT NULL,
  `isBuiltin`  TINYINT(1)    NOT NULL DEFAULT 0,
  `createdAt`  TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updatedAt`  TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_menus_slug` (`slug`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS `menuItems` (
  `id`          INT UNSIGNED    NOT NULL AUTO_INCREMENT,
  `menuId`      INT UNSIGNED    NOT NULL,
  `parentId`    INT UNSIGNED    DEFAULT NULL,
  `label`       JSON            NOT NULL,
  `url`         VARCHAR(512)    DEFAULT NULL,
  `contentId`   BIGINT UNSIGNED DEFAULT NULL,
  `target`      ENUM('_self','_blank') NOT NULL DEFAULT '_self',
  `sortOrder`   INT             NOT NULL DEFAULT 0,
  `createdAt`   TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updatedAt`   TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_menuItems_tree` (`menuId`, `parentId`, `sortOrder`),
  KEY `idx_menuItems_content` (`contentId`),
  CONSTRAINT `fk_menuItems_menuId`
    FOREIGN KEY (`menuId`)    REFERENCES `menus`(`id`)     ON DELETE CASCADE,
  CONSTRAINT `fk_menuItems_parentId`
    FOREIGN KEY (`parentId`)  REFERENCES `menuItems`(`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_menuItems_contentId`
    FOREIGN KEY (`contentId`) REFERENCES `content`(`id`)   ON DELETE SET NULL
  -- NOTE: mutual exclusivity of (url, contentId) is enforced in app layer.
  -- MySQL 8 rejects CHECK constraints on columns participating in FK
  -- referential actions (error 3823).
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- ============================================================
-- Settings
-- ============================================================

CREATE TABLE IF NOT EXISTS `settings` (
  `keyName`     VARCHAR(128)    NOT NULL,
  `value`       JSON            NOT NULL,
  `updatedAt`   TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  `updatedBy`   BIGINT UNSIGNED DEFAULT NULL,
  PRIMARY KEY (`keyName`),
  CONSTRAINT `fk_settings_updatedBy`
    FOREIGN KEY (`updatedBy`) REFERENCES `users`(`id`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- ============================================================
-- Redirects
-- ============================================================

CREATE TABLE IF NOT EXISTS `redirects` (
  `id`            INT UNSIGNED    NOT NULL AUTO_INCREMENT,
  `source`        VARCHAR(512)    NOT NULL,
  `destination`   VARCHAR(512)    NOT NULL,
  `statusCode`    SMALLINT        NOT NULL DEFAULT 301,
  `hitCount`      BIGINT UNSIGNED NOT NULL DEFAULT 0,
  `lastHitAt`     TIMESTAMP       NULL DEFAULT NULL,
  `createdAt`     TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updatedAt`     TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_redirects_source` (`source`),
  CONSTRAINT `chk_redirects_statusCode` CHECK (`statusCode` IN (301, 302, 307, 308))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- ============================================================
-- Forms (definitions are content rows; submissions are separate)
-- ============================================================

CREATE TABLE IF NOT EXISTS `formSubmissions` (
  `id`           BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `formId`       BIGINT UNSIGNED NOT NULL,
  `data`         JSON            NOT NULL,
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

-- ============================================================
-- Email templates
-- ============================================================

CREATE TABLE IF NOT EXISTS `emailTemplates` (
  `id`         INT UNSIGNED  NOT NULL AUTO_INCREMENT,
  `slug`       VARCHAR(64)   NOT NULL,
  `locale`     VARCHAR(10)   NOT NULL DEFAULT 'en',
  `subject`    VARCHAR(255)  NOT NULL,
  `bodyHtml`   MEDIUMTEXT    NOT NULL,
  `bodyText`   MEDIUMTEXT    NOT NULL,
  `variables`  JSON          DEFAULT NULL,
  `isBuiltin`  TINYINT(1)    NOT NULL DEFAULT 0,
  `createdAt`  TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updatedAt`  TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_emailTemplates_slugLocale` (`slug`, `locale`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- ============================================================
-- Background jobs
-- ============================================================

CREATE TABLE IF NOT EXISTS `jobs` (
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

-- ============================================================
-- Webhooks + deliveries
-- ============================================================

CREATE TABLE IF NOT EXISTS `webhooks` (
  `id`           BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `url`          VARCHAR(512)    NOT NULL,
  `events`       JSON            NOT NULL,
  `secret`       CHAR(64)        NOT NULL,
  `active`       TINYINT(1)      NOT NULL DEFAULT 1,
  `description`  VARCHAR(255)    DEFAULT NULL,
  `createdAt`    TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updatedAt`    TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_webhooks_active` (`active`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS `webhookDeliveries` (
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

-- ============================================================
-- Analytics events (partitioned monthly)
-- ============================================================

CREATE TABLE IF NOT EXISTS `analyticsEvents` (
  `id`              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `path`            VARCHAR(512)    NOT NULL,
  `locale`          VARCHAR(10)     DEFAULT NULL,
  `referrer`        VARCHAR(512)    DEFAULT NULL,
  `ipHash`          CHAR(64)        DEFAULT NULL,
  `userAgentHash`   CHAR(64)        DEFAULT NULL,
  `country`         CHAR(2)         DEFAULT NULL,
  `createdAt`       TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`, `createdAt`),
  KEY `idx_analyticsEvents_pathTime` (`path`, `createdAt`),
  KEY `idx_analyticsEvents_time` (`createdAt`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
-- Partitioning deferred. MySQL 8/9 disallow TO_DAYS-with-literal partitioning
-- and RANGE COLUMNS requires DATETIME (not TIMESTAMP). We will alter the
-- column + introduce monthly partitions in a later migration once data
-- volume warrants it.

-- ============================================================
-- Audit log
-- ============================================================

CREATE TABLE IF NOT EXISTS `auditLog` (
  `id`          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `userId`      BIGINT UNSIGNED DEFAULT NULL,
  `action`      VARCHAR(64)     NOT NULL,
  `entityType`  VARCHAR(64)     DEFAULT NULL,
  `entityId`    BIGINT UNSIGNED DEFAULT NULL,
  `changes`     JSON            DEFAULT NULL,
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
