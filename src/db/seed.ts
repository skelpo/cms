// Boot-time seeder. Inserts built-in rows for roles, content types, email
// templates, default settings, menus, and forms — but ONLY for slugs that
// don't exist yet. Never overwrites user edits.
//
// Run after migrations on every boot. Safe to re-run.

import { execute, query, queryOne } from './client.js';

// ────────────────────────────────────────────────────────────────────────
// Built-in roles
// ────────────────────────────────────────────────────────────────────────

const BUILTIN_ROLES = [
  {
    slug: 'admin',
    label: 'Administrator',
    capabilities: {
      global: ['*'],
      types: { '*': ['read', 'create', 'update', 'delete', 'publish', 'readDrafts', 'readOthersDrafts'] },
    },
  },
  {
    slug: 'editor',
    label: 'Editor',
    capabilities: {
      // Editors moderate form submissions (mark spam, delete) but don't
      // create form definitions — those require template integration.
      global: ['viewSubmissions'],
      types: {
        '*':  ['read', 'create', 'update', 'delete', 'publish', 'readDrafts'],
        // Form definitions need a developer to wire them into a template;
        // editors can read + tweak labels but shouldn't spawn new ones.
        form: ['read', 'update', 'publish', 'readDrafts'],
      },
    },
  },
  {
    slug: 'author',
    label: 'Author',
    capabilities: {
      global: [],
      types: {
        page: ['read'],
        post: ['read', 'create', 'updateOwn', 'deleteOwn', 'publish', 'readDrafts'],
      },
    },
  },
  {
    slug: 'contributor',
    label: 'Contributor',
    capabilities: {
      global: [],
      types: {
        '*': ['read'],
        post: ['read', 'create', 'updateOwn'],
      },
    },
  },
  {
    slug: 'viewer',
    label: 'Viewer',
    capabilities: { global: [], types: { '*': ['read'] } },
  },
];

// ────────────────────────────────────────────────────────────────────────
// Built-in content types
// ────────────────────────────────────────────────────────────────────────

const BUILTIN_TYPES = [
  {
    slug: 'page',
    labelSingular: 'Page',
    labelPlural: 'Pages',
    isRoutable: true,
    urlPattern: '/:slug',
    icon: 'file',
    sortOrder: 10,
    fieldsSchema: {
      version: 1,
      fields: [
        { name: 'body', type: 'richtext', label: 'Body', translatable: true, required: true },
        { name: 'heroImage', type: 'image', label: 'Hero image', required: false },
      ],
    },
  },
  {
    slug: 'post',
    labelSingular: 'Post',
    labelPlural: 'Posts',
    isRoutable: true,
    urlPattern: '/blog/:slug',
    icon: 'pen-line',
    sortOrder: 20,
    fieldsSchema: {
      version: 1,
      fields: [
        { name: 'excerpt', type: 'textarea', label: 'Excerpt', translatable: true, required: true,
          validation: { maxLength: 280 } },
        { name: 'body', type: 'richtext', label: 'Body', translatable: true, required: true,
          richtext: { allowCodeBlocks: true, allowEmbeds: true, allowImages: true } },
        { name: 'heroImage', type: 'image', label: 'Hero image', required: false },
        { name: 'tags', type: 'multiselect', label: 'Tags',
          validation: { options: [] }, admin: { help: 'Free-form tags' } },
        { name: 'relatedPosts', type: 'relation', label: 'Related',
          relation: { toType: 'post', many: true, max: 3 } },
      ],
    },
  },
  {
    slug: 'doc',
    labelSingular: 'Doc',
    labelPlural: 'Docs',
    isRoutable: true,
    urlPattern: '/docs/:slug',
    icon: 'book',
    sortOrder: 30,
    fieldsSchema: {
      version: 1,
      fields: [
        { name: 'body', type: 'richtext', label: 'Body', translatable: true, required: true,
          richtext: { allowCodeBlocks: true, allowEmbeds: false, allowImages: true } },
        { name: 'order', type: 'number', label: 'Sort order', required: false },
        { name: 'parent', type: 'relation', label: 'Parent doc',
          relation: { toType: 'doc', many: false } },
      ],
    },
  },
  {
    slug: 'form',
    labelSingular: 'Form',
    labelPlural: 'Forms',
    isRoutable: false,
    urlPattern: null,
    icon: 'form-input',
    sortOrder: 40,
    fieldsSchema: {
      version: 1,
      fields: [
        { name: 'successMessage', type: 'text', label: 'Success message', translatable: true,
          required: true },
        { name: 'redirectUrl', type: 'url', label: 'Redirect URL', required: false },
        { name: 'notificationEmail', type: 'email', label: 'Notify on submission' },
        { name: 'fields', type: 'repeater', label: 'Fields', required: true,
          repeater: {
            min: 1, max: 30,
            fields: [
              { name: 'name', type: 'text', label: 'Name', required: true },
              { name: 'label', type: 'text', label: 'Label', translatable: true, required: true },
              { name: 'type', type: 'select', label: 'Type', required: true,
                validation: { options: ['text','email','phone','textarea','checkbox','radio','select','multiselect','file','hidden','consent'] } },
              { name: 'required', type: 'boolean', label: 'Required' },
              { name: 'options', type: 'textarea', label: 'Options (one per line)',
                admin: { help: 'For radio/select/multiselect.' } },
            ],
          } },
      ],
    },
  },
  {
    slug: 'errorPage',
    labelSingular: 'Error Page',
    labelPlural: 'Error Pages',
    isRoutable: false,
    urlPattern: null,
    icon: 'alert-triangle',
    sortOrder: 50,
    fieldsSchema: {
      version: 1,
      fields: [
        { name: 'statusCode', type: 'number', label: 'Status code', required: true },
        { name: 'body', type: 'richtext', label: 'Body', translatable: true, required: true },
      ],
    },
  },
];

// ────────────────────────────────────────────────────────────────────────
// Built-in email templates
// ────────────────────────────────────────────────────────────────────────

const BUILTIN_TEMPLATES = [
  {
    slug: 'passwordReset',
    subject: 'Reset your password',
    bodyHtml: '<p>Hello {{displayName}},</p><p>Click <a href="{{resetUrl}}">here</a> to reset your password. This link expires in 1 hour.</p>',
    bodyText: 'Hello {{displayName}},\n\nReset your password: {{resetUrl}}\n\nThis link expires in 1 hour.',
    variables: ['displayName', 'resetUrl'],
  },
  {
    slug: 'userInvite',
    subject: 'You have been invited to {{siteName}}',
    bodyHtml: '<p>You have been invited to join {{siteName}}.</p><p><a href="{{inviteUrl}}">Accept invitation</a></p>',
    bodyText: 'You have been invited to join {{siteName}}.\n\nAccept invitation: {{inviteUrl}}',
    variables: ['siteName', 'inviteUrl'],
  },
  {
    slug: 'formNotification',
    subject: 'New form submission: {{formName}}',
    bodyHtml: '<p>A new submission was received on form <strong>{{formName}}</strong>:</p>{{submissionHtml}}',
    bodyText: 'A new submission was received on form {{formName}}:\n\n{{submissionText}}',
    variables: ['formName', 'submissionHtml', 'submissionText'],
  },
  {
    slug: 'formAutoresponder',
    subject: 'Thanks for getting in touch',
    bodyHtml: '<p>Hi,</p><p>Thanks for contacting {{siteName}}. We received your message and will be in touch shortly.</p>',
    bodyText: 'Hi,\n\nThanks for contacting {{siteName}}. We received your message and will be in touch shortly.',
    variables: ['siteName'],
  },
  {
    slug: 'webhookFailureAlert',
    subject: 'Webhook delivery failing: {{webhookUrl}}',
    bodyHtml: '<p>Webhook delivery to <code>{{webhookUrl}}</code> has failed {{attempts}} times. Last error: {{lastError}}</p>',
    bodyText: 'Webhook to {{webhookUrl}} failed {{attempts}} times. Last error: {{lastError}}',
    variables: ['webhookUrl', 'attempts', 'lastError'],
  },
];

// ────────────────────────────────────────────────────────────────────────
// Default settings
// ────────────────────────────────────────────────────────────────────────

const DEFAULT_SETTINGS: Array<[string, unknown]> = [
  ['site.name', 'My Site'],
  ['site.url', 'http://localhost:3000'],
  ['site.defaultLocale', 'en'],
  ['site.locales', ['en']],
  ['site.tagline', ''],
  ['seo.robots', 'index,follow'],
  ['seo.organizationSchema', { '@type': 'Organization', name: 'My Site' }],
  ['ai.llmsTxtIntro', ''],
  ['email.fromAddress', 'noreply@example.com'],
  ['email.fromName', 'My Site'],
];

// ────────────────────────────────────────────────────────────────────────
// Built-in menus
// ────────────────────────────────────────────────────────────────────────

const BUILTIN_MENUS = [
  { slug: 'main',   label: 'Main Menu' },
  { slug: 'footer', label: 'Footer Menu' },
];

// ────────────────────────────────────────────────────────────────────────
// Seeder entry point
// ────────────────────────────────────────────────────────────────────────

export async function runSeed(): Promise<{ inserted: Record<string, number> }> {
  // Concrete keyed type (not Record<string, number>) so member access is `number`
  // rather than `number | undefined` under noUncheckedIndexedAccess. That lets us
  // write `inserted.roles++` without a `!` non-null assertion — Perry's AOT
  // compiler rejects an update expression on an asserted member (`x!++`, error
  // U006), and `Record` access would otherwise force that assertion.
  const inserted = {
    roles: 0,
    contentTypes: 0,
    emailTemplates: 0,
    settings: 0,
    menus: 0,
  };

  // Roles
  for (const r of BUILTIN_ROLES) {
    const existing = await queryOne<{ id: number }>('SELECT `id` FROM `roles` WHERE `slug` = ?', [r.slug]);
    if (existing) continue;
    await execute(
      'INSERT INTO `roles` (`slug`, `label`, `capabilities`, `isBuiltin`) VALUES (?, ?, ?, 1)',
      [r.slug, r.label, JSON.stringify(r.capabilities)],
    );
    inserted.roles++;
  }

  // Content types (+ initial revision row)
  for (const t of BUILTIN_TYPES) {
    const existing = await queryOne<{ id: number }>(
      'SELECT `id` FROM `contentTypes` WHERE `slug` = ?',
      [t.slug],
    );
    if (existing) continue;
    const r = await execute(
      `INSERT INTO \`contentTypes\`
       (\`slug\`, \`labelSingular\`, \`labelPlural\`, \`isBuiltin\`, \`isRoutable\`, \`urlPattern\`, \`fieldsSchema\`, \`icon\`, \`sortOrder\`)
       VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?)`,
      [
        t.slug,
        t.labelSingular,
        t.labelPlural,
        t.isRoutable ? 1 : 0,
        t.urlPattern,
        JSON.stringify(t.fieldsSchema),
        t.icon,
        t.sortOrder,
      ],
    );
    const typeId = Number(r.insertId);
    await execute(
      `INSERT INTO \`contentTypeRevisions\`
       (\`typeId\`, \`revision\`, \`fieldsSchema\`, \`changes\`, \`note\`)
       VALUES (?, 1, ?, ?, 'initial')`,
      [typeId, JSON.stringify(t.fieldsSchema), JSON.stringify({ added: [], removed: [], renamed: [], retyped: [] })],
    );
    inserted.contentTypes++;
  }

  // Email templates
  for (const e of BUILTIN_TEMPLATES) {
    const existing = await queryOne<{ id: number }>(
      'SELECT `id` FROM `emailTemplates` WHERE `slug` = ? AND `locale` = ?',
      [e.slug, 'en'],
    );
    if (existing) continue;
    await execute(
      `INSERT INTO \`emailTemplates\`
       (\`slug\`, \`locale\`, \`subject\`, \`bodyHtml\`, \`bodyText\`, \`variables\`, \`isBuiltin\`)
       VALUES (?, 'en', ?, ?, ?, ?, 1)`,
      [e.slug, e.subject, e.bodyHtml, e.bodyText, JSON.stringify(e.variables)],
    );
    inserted.emailTemplates++;
  }

  // Settings
  for (const [key, value] of DEFAULT_SETTINGS) {
    const existing = await queryOne<{ keyName: string }>(
      'SELECT `keyName` FROM `settings` WHERE `keyName` = ?',
      [key],
    );
    if (existing) continue;
    await execute('INSERT INTO `settings` (`keyName`, `value`) VALUES (?, ?)', [
      key,
      JSON.stringify(value),
    ]);
    inserted.settings++;
  }

  // Menus
  for (const m of BUILTIN_MENUS) {
    const existing = await queryOne<{ id: number }>('SELECT `id` FROM `menus` WHERE `slug` = ?', [m.slug]);
    if (existing) continue;
    await execute('INSERT INTO `menus` (`slug`, `label`, `isBuiltin`) VALUES (?, ?, 1)', [
      m.slug,
      m.label,
    ]);
    inserted.menus++;
  }

  return { inserted };
}

/** Whether the install needs the first-run wizard (no users yet). */
export async function isFirstRun(): Promise<boolean> {
  const row = await queryOne<{ n: number }>('SELECT COUNT(*) AS n FROM `users`');
  return (row?.n ?? 0) === 0;
}

/** Count of built-in resources, used by /healthz extended check. */
export async function countSeeded(): Promise<{ roles: number; types: number; templates: number; settings: number; menus: number }> {
  const [roles, types, templates, settings, menus] = await Promise.all([
    query<{ n: number }>('SELECT COUNT(*) AS n FROM `roles`'),
    query<{ n: number }>('SELECT COUNT(*) AS n FROM `contentTypes`'),
    query<{ n: number }>('SELECT COUNT(*) AS n FROM `emailTemplates`'),
    query<{ n: number }>('SELECT COUNT(*) AS n FROM `settings`'),
    query<{ n: number }>('SELECT COUNT(*) AS n FROM `menus`'),
  ]);
  return {
    roles:     roles[0]?.n ?? 0,
    types:     types[0]?.n ?? 0,
    templates: templates[0]?.n ?? 0,
    settings:  settings[0]?.n ?? 0,
    menus:     menus[0]?.n ?? 0,
  };
}
