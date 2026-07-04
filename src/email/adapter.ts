// Email adapter. One backend selected via EMAIL_BACKEND. v0.1 ships
// `log` (dev) and `resend` (HTTPS API, no native deps). smtp/postmark/ses
// are stubs that throw a clear "not yet implemented" until wired.

import { config } from '../config.js';

export interface OutgoingEmail {
  to: string;
  subject: string;
  html: string;
  text: string;
  replyTo?: string;
}

export interface EmailBackend {
  send(msg: OutgoingEmail): Promise<void>;
}

class LogBackend implements EmailBackend {
  async send(msg: OutgoingEmail): Promise<void> {
    console.log(
      `[email:log] to=${msg.to} subject=${JSON.stringify(msg.subject)}\n` +
        `  text: ${msg.text.slice(0, 200).replace(/\n/g, ' ')}`,
    );
  }
}

class ResendBackend implements EmailBackend {
  private readonly apiKey: string;
  constructor() {
    this.apiKey = process.env.RESEND_API_KEY ?? '';
  }
  async send(msg: OutgoingEmail): Promise<void> {
    if (!this.apiKey) throw new Error('RESEND_API_KEY not set');
    const resp = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: `${config.email.fromName} <${config.email.from}>`,
        to: [msg.to],
        subject: msg.subject,
        html: msg.html,
        text: msg.text,
        ...(msg.replyTo ? { reply_to: msg.replyTo } : {}),
      }),
    });
    if (!resp.ok) {
      throw new Error(`Resend API ${resp.status}: ${(await resp.text()).slice(0, 300)}`);
    }
  }
}

class NotImplementedBackend implements EmailBackend {
  constructor(private readonly name: string) {}
  async send(): Promise<void> {
    throw new Error(`Email backend '${this.name}' not yet implemented in v0.1 — use 'log' or 'resend'`);
  }
}

let backend: EmailBackend | null = null;

export function getEmailBackend(): EmailBackend {
  if (backend) return backend;
  switch (config.email.backend) {
    case 'log':      backend = new LogBackend(); break;
    case 'resend':   backend = new ResendBackend(); break;
    case 'smtp':     backend = new NotImplementedBackend('smtp'); break;
    case 'postmark': backend = new NotImplementedBackend('postmark'); break;
    case 'ses':      backend = new NotImplementedBackend('ses'); break;
    default:         backend = new LogBackend();
  }
  return backend;
}

// ────────── Template rendering ──────────

interface TemplateRow {
  subject: string;
  bodyHtml: string;
  bodyText: string;
}

function interpolate(tpl: string, vars: Record<string, string>): string {
  return tpl.replace(/\{\{\s*(\w+)\s*\}\}/g, (_, k: string) => vars[k] ?? '');
}

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Render a built-in/admin-edited template by slug and send it. */
export async function sendTemplatedEmail(
  templateSlug: string,
  to: string,
  vars: Record<string, string>,
  locale = 'en',
): Promise<void> {
  const { queryOne } = await import('../db/client.js');
  let tpl = await queryOne<TemplateRow>(
    'SELECT `subject`, `bodyHtml`, `bodyText` FROM `emailTemplates` WHERE `slug` = ? AND `locale` = ?',
    [templateSlug, locale],
  );
  if (!tpl && locale !== 'en') {
    tpl = await queryOne<TemplateRow>(
      'SELECT `subject`, `bodyHtml`, `bodyText` FROM `emailTemplates` WHERE `slug` = ? AND `locale` = ?',
      [templateSlug, 'en'],
    );
  }
  if (!tpl) throw new Error(`Email template not found: ${templateSlug}`);
  // Escape user-controlled values before they land in the HTML body. Variables
  // whose name ends in "Html" are pre-formatted, trusted HTML built by us
  // (e.g. submissionHtml) and pass through as-is; everything else (displayName,
  // form values, …) is escaped to prevent HTML/email injection.
  const htmlVars: Record<string, string> = {};
  for (const [k, v] of Object.entries(vars)) {
    htmlVars[k] = /html$/i.test(k) ? v : escapeHtml(v);
  }
  await getEmailBackend().send({
    to,
    subject: interpolate(tpl.subject, vars),
    html: interpolate(tpl.bodyHtml, htmlVars),
    text: interpolate(tpl.bodyText, vars),
  });
}
