// Environment → typed config. Read once at boot.

export interface Config {
  port: number;
  host: string;
  siteUrl: string;

  db: {
    host: string;
    port: number;
    user: string;
    password: string;
    database: string;
    ssl: boolean;
  };

  sessionSecret: string;

  email: {
    backend: 'log' | 'smtp' | 'resend' | 'postmark' | 'ses';
    from: string;
    fromName: string;
  };

  media: {
    backend: 'local' | 's3';
    localPath: string;
  };

  imgproxy: {
    url: string;
    signKey: string;
    salt: string;
  };

  logLevel: 'debug' | 'info' | 'warn' | 'error';
  metricsToken: string | null;
  corsOrigins: string[];
}

function required(name: string): string {
  const v = process.env[name];
  if (!v || v.length === 0) {
    throw new Error(`Missing required env var: ${name}`);
  }
  return v;
}

function optional(name: string, fallback: string): string {
  const v = process.env[name];
  return v && v.length > 0 ? v : fallback;
}

export function loadConfig(): Config {
  return {
    port: Number(optional('PORT', '3000')),
    host: optional('HOST', '0.0.0.0'),
    siteUrl: optional('SITE_URL', 'http://localhost:3000'),

    db: {
      host:     optional('DB_HOST', '127.0.0.1'),
      port:     Number(optional('DB_PORT', '3306')),
      user:     optional('DB_USER', 'skelpo'),
      password: optional('DB_PASSWORD', ''),
      database: optional('DB_NAME', 'skelpo'),
      ssl:      optional('DB_SSL', 'false') === 'true',
    },

    sessionSecret: required('SESSION_SECRET'),

    email: {
      backend:  optional('EMAIL_BACKEND', 'log') as Config['email']['backend'],
      from:     optional('EMAIL_FROM', 'hello@example.com'),
      fromName: optional('EMAIL_FROM_NAME', 'Skelpo CMS'),
    },

    media: {
      backend:   optional('MEDIA_BACKEND', 'local') as Config['media']['backend'],
      localPath: optional('MEDIA_LOCAL_PATH', './uploads'),
    },

    imgproxy: {
      url:     optional('IMGPROXY_URL', ''),
      signKey: optional('IMGPROXY_SIGN_KEY', ''),
      salt:    optional('IMGPROXY_SALT', ''),
    },

    logLevel:     optional('LOG_LEVEL', 'info') as Config['logLevel'],
    metricsToken: process.env.METRICS_TOKEN ?? null,
    corsOrigins:  (process.env.CORS_ORIGINS ?? '').split(',').map(s => s.trim()).filter(Boolean),
  };
}

export const config = loadConfig();
