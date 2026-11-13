// Account screens: accepting an invite, forgotten-password reset, the
// signed-in user's profile (details, password, API tokens) and user
// management for administrators.

import { Hono } from 'hono';
import type { Context } from 'hono';
import { setCookie } from 'hono/cookie';
import type { FC } from 'hono/jsx';
import { AdminPage } from './layout.js';
import type { AuthContext } from '../auth/middleware.js';
import { query, queryOne, execute } from '../db/client.js';
import { hashPassword, verifyPassword } from '../auth/password.js';
import { createSession, deleteAllSessionsForUser } from '../auth/sessions.js';
import { createToken, listTokensForUser, revokeToken } from '../auth/tokens.js';
import { listRoles, findRoleById, findRoleBySlug, type RoleRow } from '../auth/users.js';
import { grantsWithinActor } from '../permissions/check.js';
import { enqueue } from '../jobs/queue.js';
import { getSetting } from '../settings/store.js';
import { config } from '../config.js';
import { clientIp, userAgent, isHttps } from '../routes/api/_helpers.js';
import { getT, makeT, type Translator } from './i18n/index.js';
import { ADMIN_LANG_COOKIE } from './i18n/middleware.js';
import { adminLocales, adminLocaleNames, coerceLocale } from './i18n/locales.js';
import { generateTotpSecret, matchTotp, otpauthUrl, formatSecret } from '../auth/totp.js';
import { qrSvg } from './qr.js';
import { gate, notAuth, allowed, pageUser, readFlash, Flash, withFlash, DateTime, adminBaseUrl, randomHex, sha256Hex } from './helpers.js';

export const adminAccount = new Hono();

const SESSION_COOKIE = 'skelpoSession';
const MIN_PASSWORD = 8;

async function siteName(): Promise<string> {
  const v = await getSetting<unknown>('site.name', '');
  return typeof v === 'string' && v.trim() ? v.trim() : 'Skelpo CMS';
}

async function startSession(c: Context, userId: number): Promise<void> {
  const { token, expiresAt } = await createSession(userId, { ip: clientIp(c), userAgent: userAgent(c) });
  setCookie(c, SESSION_COOKIE, token, { httpOnly: true, secure: isHttps(c), sameSite: 'Lax', path: '/', expires: expiresAt });
}

/** Returns a translated problem, or null when the new password is acceptable. */
function passwordProblem(t: Translator, password: string, confirm: string): string | null {
  if (password.length < MIN_PASSWORD) return t('account.passwordTooShort', { n: MIN_PASSWORD });
  if (password !== confirm) return t('account.passwordMismatch');
  return null;
}

/** Whether outgoing email actually leaves the server. */
const emailWorks = (): boolean => config.email.backend !== 'log';

const AuthCard: FC<{ title: string; t: Translator; flash?: { ok?: string; err?: string }; children?: unknown }> = async ({ title, t, flash, children }) => (
  <AdminPage title={title} t={t}>
    <div class="card">
      <div class="brand" style="padding-left:0">{await siteName()}</div>
      <h2 style="font-size:16px;margin:0 0 6px">{title}</h2>
      <Flash flash={flash} />
      {children}
    </div>
    <p style="text-align:center;font-size:12px;margin-top:14px"><a href="/admin/login">{t('account.backToSignIn')}</a></p>
  </AdminPage>
);

const NewPasswordFields: FC<{ t: Translator }> = ({ t }) => (
  <>
    <label for="password">{t('account.newPassword')}</label>
    <input type="password" name="password" id="password" required minlength={MIN_PASSWORD} autocomplete="new-password" />
    <div class="help">{t('account.passwordHint', { n: MIN_PASSWORD })}</div>
    <label for="confirm">{t('account.confirmPassword')}</label>
    <input type="password" name="confirm" id="confirm" required minlength={MIN_PASSWORD} autocomplete="new-password" />
  </>
);

// ── Accept an invitation ───────────────────────────────────────────────

interface InvitedUser { id: number; email: string; displayName: string }

async function findInvite(token: string): Promise<InvitedUser | null> {
  if (!/^[0-9a-f]{32,64}$/.test(token)) return null;
  return queryOne<InvitedUser>(
    "SELECT `id`, `email`, `displayName` FROM `users` WHERE `inviteToken` = ? AND `status` = 'invited' AND (`inviteExpiresAt` IS NULL OR `inviteExpiresAt` > NOW())",
    [token],
  );
}

adminAccount.get('/accept-invite', async (c) => {
  const t = getT(c);
  const token = c.req.query('token') ?? '';
  const invite = await findInvite(token);
  if (!invite) {
    return c.html(<AuthCard title={t('account.inviteTitle')} t={t}><p class="muted">{t('account.inviteInvalid')}</p></AuthCard>, 404);
  }
  return c.html(
    <AuthCard title={t('account.inviteTitle')} t={t} flash={readFlash(c)}>
      <p class="muted" style="margin-top:0">{t('account.inviteIntro', { name: invite.displayName, email: invite.email })}</p>
      <form method="post" action="/admin/accept-invite">
        <input type="hidden" name="token" value={token} />
        <NewPasswordFields t={t} />
        <div style="margin-top:18px"><button class="btn" type="submit" style="width:100%">{t('account.inviteSubmit')}</button></div>
      </form>
    </AuthCard>,
  );
});

adminAccount.post('/accept-invite', async (c) => {
  const t = getT(c);
  const body = await c.req.parseBody();
  const token = String(body.token ?? '');
  const invite = await findInvite(token);
  if (!invite) return c.redirect('/admin/accept-invite', 302);
  const problem = passwordProblem(t, String(body.password ?? ''), String(body.confirm ?? ''));
  if (problem) return c.redirect(withFlash(`/admin/accept-invite?token=${token}`, 'err', problem), 302);
  await execute(
    "UPDATE `users` SET `passwordHash` = ?, `status` = 'active', `inviteToken` = NULL, `inviteExpiresAt` = NULL WHERE `id` = ?",
    [await hashPassword(String(body.password)), invite.id],
  );
  await startSession(c, invite.id);
  return c.redirect('/admin', 302);
});

// ── Forgotten password ─────────────────────────────────────────────────

adminAccount.get('/forgot-password', async (c) => {
  const t = getT(c);
  return c.html(
    <AuthCard title={t('account.forgotTitle')} t={t} flash={readFlash(c)}>
      <p class="muted" style="margin-top:0">{t('account.forgotIntro')}</p>
      <form method="post" action="/admin/forgot-password">
        <label for="email">{t('auth.email')}</label>
        <input type="email" name="email" id="email" required autofocus />
        <div style="margin-top:18px"><button class="btn" type="submit" style="width:100%">{t('account.forgotSubmit')}</button></div>
      </form>
      {!emailWorks() ? <p class="help">{t('account.emailNotConfigured')}</p> : null}
    </AuthCard>,
  );
});

adminAccount.post('/forgot-password', async (c) => {
  const t = getT(c);
  const body = await c.req.parseBody();
  const email = String(body.email ?? '').trim().toLowerCase();
  const user = email
    ? await queryOne<{ id: number; displayName: string; locale: string }>(
        "SELECT `id`, `displayName`, `locale` FROM `users` WHERE `email` = ? AND `status` = 'active'", [email])
    : null;
  if (user) {
    // One mail per two minutes per account, so the form can't be used to spam.
    const recent = await queryOne<{ n: number }>(
      'SELECT COUNT(*) n FROM `passwordResets` WHERE `userId` = ? AND `createdAt` > (NOW() - INTERVAL 2 MINUTE)', [user.id]);
    if (Number(recent?.n ?? 0) === 0) {
      const token = randomHex(32);
      await execute(
        'INSERT INTO `passwordResets` (`token`, `userId`, `expiresAt`) VALUES (?, ?, (NOW() + INTERVAL 1 HOUR))',
        [await sha256Hex(token), user.id],
      );
      await enqueue('sendEmail', {
        templateSlug: 'passwordReset',
        to: email,
        locale: user.locale,
        variables: { displayName: user.displayName, resetUrl: `${adminBaseUrl(c)}/admin/reset-password?token=${token}` },
      });
    }
  }
  // Same answer whether or not the address exists (no account enumeration).
  return c.redirect(withFlash('/admin/forgot-password', 'ok', t('account.forgotSent')), 302);
});

async function findReset(token: string): Promise<{ userId: number; tokenHash: string } | null> {
  if (!/^[0-9a-f]{64}$/.test(token)) return null;
  const tokenHash = await sha256Hex(token);
  const row = await queryOne<{ userId: number }>(
    'SELECT `userId` FROM `passwordResets` WHERE `token` = ? AND `usedAt` IS NULL AND `expiresAt` > NOW()', [tokenHash]);
  return row ? { userId: row.userId, tokenHash } : null;
}

adminAccount.get('/reset-password', async (c) => {
  const t = getT(c);
  const token = c.req.query('token') ?? '';
  if (!(await findReset(token))) {
    return c.html(
      <AuthCard title={t('account.resetTitle')} t={t}>
        <p class="muted">{t('account.resetInvalid')}</p>
        <a class="btn sec" href="/admin/forgot-password">{t('account.resetRequestNew')}</a>
      </AuthCard>, 404);
  }
  return c.html(
    <AuthCard title={t('account.resetTitle')} t={t} flash={readFlash(c)}>
      <form method="post" action="/admin/reset-password">
        <input type="hidden" name="token" value={token} />
        <NewPasswordFields t={t} />
        <div style="margin-top:18px"><button class="btn" type="submit" style="width:100%">{t('account.resetSubmit')}</button></div>
      </form>
    </AuthCard>,
  );
});

adminAccount.post('/reset-password', async (c) => {
  const t = getT(c);
  const body = await c.req.parseBody();
  const token = String(body.token ?? '');
  const reset = await findReset(token);
  if (!reset) return c.redirect('/admin/reset-password', 302);
  const problem = passwordProblem(t, String(body.password ?? ''), String(body.confirm ?? ''));
  if (problem) return c.redirect(withFlash(`/admin/reset-password?token=${token}`, 'err', problem), 302);
  await execute('UPDATE `users` SET `passwordHash` = ? WHERE `id` = ?', [await hashPassword(String(body.password)), reset.userId]);
  await execute('UPDATE `passwordResets` SET `usedAt` = NOW() WHERE `token` = ?', [reset.tokenHash]);
  await deleteAllSessionsForUser(reset.userId);
  return c.redirect(withFlash('/admin/login', 'ok', t('account.resetDone')), 302);
});

// ── Profile ────────────────────────────────────────────────────────────

async function renderProfile(c: Context, auth: AuthContext, t: Translator, extra: { newToken?: string; setupSecret?: string; flash?: { ok?: string; err?: string } } = {}) {
  const twoFactorOn = auth.user.totpVerified === 1;
  const setupUrl = extra.setupSecret ? otpauthUrl(extra.setupSecret, auth.user.email, await siteName()) : '';
  const tokens = (await listTokensForUser(auth.user.id)).filter((tok) => !tok.revokedAt);
  const current = coerceLocale(auth.user.locale) ?? t.locale;
  return c.html(
    <AdminPage title={t('profile.title')} active="profile" t={t} {...pageUser(auth)}>
      <div class="top"><h1>{t('profile.heading')}</h1></div>
      <Flash flash={extra.flash ?? readFlash(c)} />
      <div class="grid g2" style="align-items:start">
        <div class="card">
          <h3>{t('profile.detailsTitle')}</h3>
          <form method="post" action="/admin/profile">
            <label for="displayName">{t('users.displayName')}</label>
            <input type="text" name="displayName" id="displayName" value={auth.user.displayName} required maxlength={128} />
            <label for="email">{t('profile.email')}</label>
            <input type="email" name="email" id="email" value={auth.user.email} required />
            <label>{t('profile.role')}</label>
            <input type="text" value={auth.role.label} disabled />
            <label for="locale">{t('profile.displayLanguage')}</label>
            <select name="locale" id="locale">
              {adminLocales.map((l) => <option value={l} selected={l === current}>{adminLocaleNames[l]}</option>)}
            </select>
            <div class="help">{t('profile.languageHint')}</div>
            <div style="margin-top:18px"><button class="btn" type="submit">{t('profile.save')}</button></div>
          </form>
        </div>
        <div class="card">
          <h3>{t('profile.passwordTitle')}</h3>
          <form method="post" action="/admin/profile/password">
            <label for="current">{t('profile.currentPassword')}</label>
            <input type="password" name="current" id="current" required autocomplete="current-password" />
            <NewPasswordFields t={t} />
            <div class="help">{t('profile.passwordSignsOut')}</div>
            <div style="margin-top:18px"><button class="btn" type="submit">{t('profile.changePassword')}</button></div>
          </form>
        </div>
      </div>
      <div class="card" style="margin-top:14px" id="two-factor">
        <h3>
          {t('profile.twoFactorTitle')}{' '}
          <span class={twoFactorOn ? 'badge b-pub' : 'badge b-draft'}>{twoFactorOn ? t('profile.twoFactorOn') : t('profile.twoFactorOff')}</span>
        </h3>
        <p class="help" style="margin-top:0">{t('profile.twoFactorIntro')}</p>
        {twoFactorOn ? (
          <form method="post" action="/admin/profile/2fa/disable" class="toolbar">
            <input type="password" name="current" required autocomplete="current-password" placeholder={t('profile.currentPassword')} style="min-width:220px" />
            <button class="btn sec" type="submit" data-confirm={t('profile.twoFactorConfirmDisable')}>{t('profile.twoFactorDisable')}</button>
          </form>
        ) : extra.setupSecret ? (
          <div style="display:flex;gap:20px;flex-wrap:wrap;align-items:flex-start">
            <div style="background:#fff;border-radius:8px;padding:6px;line-height:0" dangerouslySetInnerHTML={{ __html: qrSvg(setupUrl, 190) }} />
            <div style="flex:1;min-width:260px">
              <ol style="margin:0 0 10px;padding-left:18px;font-size:13px;line-height:1.6">
                <li>{t('profile.twoFactorStep1')}</li>
                <li>{t('profile.twoFactorStep2')}</li>
                <li>{t('profile.twoFactorStep3')}</li>
              </ol>
              <div class="help" style="margin-top:0">{t('profile.twoFactorManual')}</div>
              <code class="secret">{formatSecret(extra.setupSecret)}</code>
              <form method="post" action="/admin/profile/2fa/confirm" class="toolbar" style="margin-top:12px">
                <input type="text" name="code" required autofocus inputmode="numeric" pattern="[0-9 ]*" maxlength={7} autocomplete="one-time-code"
                  placeholder="123456" style="width:130px;font-size:16px;letter-spacing:2px;text-align:center" />
                <button class="btn" type="submit">{t('profile.twoFactorEnable')}</button>
                <a class="btn sec" href="/admin/profile">{t('common.cancel')}</a>
              </form>
            </div>
          </div>
        ) : (
          <form method="post" action="/admin/profile/2fa/start" style="margin:0">
            <button class="btn sec" type="submit">{t('profile.twoFactorSetUp')}</button>
          </form>
        )}
      </div>
      <div class="card" style="margin-top:14px">
        <h3>{t('profile.tokensTitle')}</h3>
        <p class="help" style="margin-top:0">{t('profile.tokensIntro')}</p>
        {extra.newToken ? (
          <div class="ok">
            <strong>{t('profile.tokenCreated')}</strong>
            <code class="secret">{extra.newToken}</code>
            <button type="button" class="btn sm sec" data-copy={extra.newToken} data-copied={t('common.copied')}>{t('common.copy')}</button>
          </div>
        ) : null}
        {tokens.length > 0 ? (
          <table style="margin-bottom:14px">
            <thead><tr><th>{t('profile.tokenName')}</th><th>{t('profile.tokenStarts')}</th><th>{t('profile.tokenLastUsed')}</th><th></th></tr></thead>
            <tbody>
              {tokens.map((tok) => (
                <tr>
                  <td>{tok.name}</td>
                  <td class="muted"><code>{tok.prefix}…</code></td>
                  <td class="muted">{tok.lastUsedAt ? <DateTime value={tok.lastUsedAt} /> : t('profile.tokenNeverUsed')}</td>
                  <td style="text-align:right">
                    <form method="post" action={`/admin/profile/tokens/${tok.id}/revoke`} style="margin:0">
                      <button class="btn sm danger" type="submit" data-confirm={t('profile.tokenConfirmRevoke')}>{t('profile.tokenRevoke')}</button>
                    </form>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : null}
        <form method="post" action="/admin/profile/tokens" class="toolbar">
          <input type="text" name="name" required maxlength={128} placeholder={t('profile.tokenNamePlaceholder')} style="min-width:260px" />
          <button class="btn sec" type="submit">{t('profile.tokenCreate')}</button>
        </form>
      </div>
    </AdminPage>,
  );
}

adminAccount.get('/profile', async (c) => {
  const auth = gate(c);
  if (notAuth(auth)) return auth;
  return renderProfile(c, auth, getT(c));
});

adminAccount.post('/profile', async (c) => {
  const auth = gate(c);
  if (notAuth(auth)) return auth;
  const body = await c.req.parseBody();
  const locale = coerceLocale(String(body.locale ?? ''));
  const t = locale ? makeT(locale) : getT(c);
  const displayName = String(body.displayName ?? '').trim().slice(0, 128);
  const email = String(body.email ?? '').trim().toLowerCase();
  if (!displayName || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    return c.redirect(withFlash('/admin/profile', 'err', t('users.flashInvalidInput')), 302);
  }
  if (email !== auth.user.email) {
    const dup = await queryOne<{ id: number }>('SELECT `id` FROM `users` WHERE `email` = ? AND `id` <> ?', [email, auth.user.id]);
    if (dup) return c.redirect(withFlash('/admin/profile', 'err', t('users.flashEmailUsed')), 302);
  }
  await execute('UPDATE `users` SET `displayName` = ?, `email` = ?' + (locale ? ', `locale` = ?' : '') + ' WHERE `id` = ?',
    locale ? [displayName, email, locale, auth.user.id] : [displayName, email, auth.user.id]);
  if (locale) {
    setCookie(c, ADMIN_LANG_COOKIE, locale, { httpOnly: true, secure: isHttps(c), sameSite: 'Lax', path: '/', maxAge: 60 * 60 * 24 * 365 });
  }
  return c.redirect(withFlash('/admin/profile', 'ok', t('profile.flashSaved')), 302);
});

adminAccount.post('/profile/password', async (c) => {
  const auth = gate(c);
  if (notAuth(auth)) return auth;
  const t = getT(c);
  const body = await c.req.parseBody();
  if (!(await verifyPassword(String(body.current ?? ''), auth.user.passwordHash))) {
    return c.redirect(withFlash('/admin/profile', 'err', t('profile.wrongCurrentPassword')), 302);
  }
  const problem = passwordProblem(t, String(body.password ?? ''), String(body.confirm ?? ''));
  if (problem) return c.redirect(withFlash('/admin/profile', 'err', problem), 302);
  await execute('UPDATE `users` SET `passwordHash` = ? WHERE `id` = ?', [await hashPassword(String(body.password)), auth.user.id]);
  // Sign out every other device, then keep this one signed in.
  await deleteAllSessionsForUser(auth.user.id);
  await startSession(c, auth.user.id);
  return c.redirect(withFlash('/admin/profile', 'ok', t('profile.flashPasswordChanged')), 302);
});

// Two-step sign-in: start shows a fresh secret, confirm proves the app works
// before sign-in starts depending on it, disable needs the password.
adminAccount.post('/profile/2fa/start', async (c) => {
  const auth = gate(c);
  if (notAuth(auth)) return auth;
  const t = getT(c);
  if (auth.user.totpVerified === 1) return c.redirect('/admin/profile#two-factor', 302);
  const secret = generateTotpSecret();
  await execute('UPDATE `users` SET `totpSecret` = ?, `totpVerified` = 0 WHERE `id` = ?', [secret, auth.user.id]);
  c.header('Cache-Control', 'no-store');
  return renderProfile(c, auth, t, { setupSecret: secret, flash: {} });
});

adminAccount.post('/profile/2fa/confirm', async (c) => {
  const auth = gate(c);
  if (notAuth(auth)) return auth;
  const t = getT(c);
  const secret = auth.user.totpSecret;
  if (auth.user.totpVerified === 1 || !secret) return c.redirect('/admin/profile#two-factor', 302);
  const code = String((await c.req.parseBody()).code ?? '');
  if ((await matchTotp(secret, code)) === null) {
    c.header('Cache-Control', 'no-store');
    return renderProfile(c, auth, t, { setupSecret: secret, flash: { err: t('profile.twoFactorWrongCode') } });
  }
  await execute('UPDATE `users` SET `totpVerified` = 1 WHERE `id` = ?', [auth.user.id]);
  return c.redirect(withFlash('/admin/profile', 'ok', t('profile.flashTwoFactorOn')), 302);
});

adminAccount.post('/profile/2fa/disable', async (c) => {
  const auth = gate(c);
  if (notAuth(auth)) return auth;
  const t = getT(c);
  if (!(await verifyPassword(String((await c.req.parseBody()).current ?? ''), auth.user.passwordHash))) {
    return c.redirect(withFlash('/admin/profile', 'err', t('profile.wrongCurrentPassword')), 302);
  }
  await execute('UPDATE `users` SET `totpSecret` = NULL, `totpVerified` = 0 WHERE `id` = ?', [auth.user.id]);
  return c.redirect(withFlash('/admin/profile', 'ok', t('profile.flashTwoFactorOff')), 302);
});

adminAccount.post('/profile/tokens', async (c) => {
  const auth = gate(c);
  if (notAuth(auth)) return auth;
  const t = getT(c);
  const body = await c.req.parseBody();
  const name = String(body.name ?? '').trim().slice(0, 128);
  if (!name) return c.redirect(withFlash('/admin/profile', 'err', t('users.flashInvalidInput')), 302);
  const { token } = await createToken({ userId: auth.user.id, name, scopes: [] });
  // Rendered directly (no redirect) so the secret never lands in a URL or log.
  c.header('Cache-Control', 'no-store');
  return renderProfile(c, auth, t, { newToken: token, flash: {} });
});

adminAccount.post('/profile/tokens/:id{[0-9]+}/revoke', async (c) => {
  const auth = gate(c);
  if (notAuth(auth)) return auth;
  const t = getT(c);
  await revokeToken(Number(c.req.param('id')), auth.user.id);
  return c.redirect(withFlash('/admin/profile', 'ok', t('profile.flashTokenRevoked')), 302);
});

// ── Users ──────────────────────────────────────────────────────────────

interface UserListRow {
  id: number; email: string; displayName: string; status: string; roleId: number;
  roleSlug: string | null; roleLabel: string | null; lastLoginAt: unknown; inviteToken: string | null;
  totpVerified?: number;
}

async function sendInvite(c: Context, email: string, token: string, locale: string): Promise<void> {
  await enqueue('sendEmail', {
    templateSlug: 'userInvite',
    to: email,
    locale,
    variables: { siteName: await siteName(), inviteUrl: `${adminBaseUrl(c)}/admin/accept-invite?token=${token}` },
  });
}

/** Roles this manager may hand out: never more powerful than their own. */
async function assignableRoles(auth: AuthContext): Promise<RoleRow[]> {
  return (await listRoles()).filter((r) => grantsWithinActor(auth.role.capabilities, r.capabilities));
}

/** A manager may only touch accounts whose role is within their own powers. */
async function manageable(auth: AuthContext, roleId: number): Promise<boolean> {
  const role = await findRoleById(roleId);
  return !role || grantsWithinActor(auth.role.capabilities, role.capabilities);
}

const usersForbidden = (c: Context, t: Translator) => c.redirect(withFlash('/admin', 'err', t('users.flashForbidden')), 302);

adminAccount.get('/users', async (c) => {
  const auth = gate(c);
  if (notAuth(auth)) return auth;
  const t = getT(c);
  if (!allowed(auth, 'manageUsers')) return usersForbidden(c, t);
  const users = await query<UserListRow>(
    `SELECT u.\`id\`, u.\`email\`, u.\`displayName\`, u.\`status\`, u.\`roleId\`, u.\`lastLoginAt\`, u.\`inviteToken\`, u.\`totpVerified\`,
            r.\`slug\` AS roleSlug, r.\`label\` AS roleLabel
       FROM \`users\` u LEFT JOIN \`roles\` r ON r.\`id\` = u.\`roleId\` ORDER BY u.\`displayName\`, u.\`id\``,
  );
  const roles = await assignableRoles(auth);
  // Accounts above the manager's own role are listed but can't be touched —
  // and their invitation links stay hidden (they would allow a takeover).
  const withinReach = new Set((await listRoles()).filter((r) => grantsWithinActor(auth.role.capabilities, r.capabilities)).map((r) => r.id));
  const base = adminBaseUrl(c);
  return c.html(
    <AdminPage title={t('users.title')} active="users" t={t} {...pageUser(auth)}>
      <div class="top"><h1>{t('users.title')}</h1></div>
      <Flash flash={readFlash(c)} />
      <div class="card">
        <table>
          <thead>
            <tr>
              <th>{t('users.colName')}</th>
              <th>{t('users.colEmail')}</th>
              <th>{t('users.colRole')}</th>
              <th>{t('users.colStatus')}</th>
              <th>{t('users.colLastLogin')}</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {users.map((u) => (
              <tr>
                <td>
                  {withinReach.has(u.roleId)
                    ? <a href={`/admin/users/${u.id}`} style="font-weight:600">{u.displayName}</a>
                    : <strong>{u.displayName}</strong>}
                  {u.id === auth.user.id ? <span class="muted"> ({t('common.you')})</span> : null}
                </td>
                <td class="muted">{u.email}</td>
                <td class="muted">{u.roleLabel ?? u.roleSlug ?? '—'}</td>
                <td>
                  <span class={`badge ${u.status === 'active' ? 'b-pub' : u.status === 'invited' ? 'b-rev' : 'b-arch'}`}>{t(`users.status.${u.status}`)}</span>
                </td>
                <td class="muted">{u.lastLoginAt ? <DateTime value={u.lastLoginAt} /> : t('users.neverLoggedIn')}</td>
                <td style="text-align:right;white-space:nowrap">
                  {u.status === 'invited' && u.inviteToken && withinReach.has(u.roleId) ? (
                    <button type="button" class="btn sm sec" style="margin-right:6px"
                      data-copy={`${base}/admin/accept-invite?token=${u.inviteToken}`} data-copied={t('common.copied')}>
                      {t('users.copyInviteLink')}
                    </button>
                  ) : null}
                  {withinReach.has(u.roleId) ? <a class="btn sm sec" href={`/admin/users/${u.id}`}>{t('common.edit')}</a> : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div class="card" style="margin-top:16px">
        <h3>{t('users.addTitle')}</h3>
        <form method="post" action="/admin/users">
          <div class="grid g3">
            <div>
              <label for="new-name">{t('users.displayName')}</label>
              <input type="text" name="displayName" id="new-name" required maxlength={128} />
            </div>
            <div>
              <label for="new-email">{t('users.email')}</label>
              <input type="email" name="email" id="new-email" required />
            </div>
            <div>
              <label for="new-role">{t('users.role')}</label>
              <select name="roleSlug" id="new-role">
                {roles.map((r) => <option value={r.slug} selected={r.slug === 'editor'}>{r.label}</option>)}
              </select>
            </div>
          </div>
          <label for="new-password">{t('users.passwordOptional')}</label>
          <input type="password" name="password" id="new-password" minlength={MIN_PASSWORD} autocomplete="new-password" style="max-width:320px" />
          <div class="help">
            {emailWorks() ? t('users.passwordOptionalHelp') : t('users.passwordOptionalHelpNoEmail')}
          </div>
          <div style="margin-top:14px"><button class="btn" type="submit">{t('users.addUser')}</button></div>
        </form>
      </div>
      <div class="help" style="margin-top:12px">{t('users.rolesHelp')}</div>
    </AdminPage>,
  );
});

adminAccount.post('/users', async (c) => {
  const auth = gate(c);
  if (notAuth(auth)) return auth;
  const t = getT(c);
  if (!allowed(auth, 'manageUsers')) return usersForbidden(c, t);
  const b = await c.req.parseBody();
  const email = String(b.email ?? '').toLowerCase().trim();
  const displayName = String(b.displayName ?? '').trim().slice(0, 128);
  const password = String(b.password ?? '');
  const role = await findRoleBySlug(String(b.roleSlug ?? 'viewer'));
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) || !displayName || !role) {
    return c.redirect(withFlash('/admin/users', 'err', t('users.flashInvalidInput')), 302);
  }
  if (!grantsWithinActor(auth.role.capabilities, role.capabilities)) return c.redirect(withFlash('/admin/users', 'err', t('users.flashRoleTooHigh')), 302);
  if (password && password.length < MIN_PASSWORD) {
    return c.redirect(withFlash('/admin/users', 'err', t('account.passwordTooShort', { n: MIN_PASSWORD })), 302);
  }
  const dup = await queryOne<{ id: number }>('SELECT `id` FROM `users` WHERE `email` = ?', [email]);
  if (dup) return c.redirect(withFlash('/admin/users', 'err', t('users.flashEmailUsed')), 302);

  if (password) {
    await execute(
      "INSERT INTO `users` (`email`, `passwordHash`, `displayName`, `roleId`, `locale`, `status`) VALUES (?, ?, ?, ?, ?, 'active')",
      [email, await hashPassword(password), displayName, role.id, t.locale],
    );
    return c.redirect(withFlash('/admin/users', 'ok', t('users.flashCreated', { name: displayName })), 302);
  }
  const token = randomHex(32);
  await execute(
    `INSERT INTO \`users\` (\`email\`, \`passwordHash\`, \`displayName\`, \`roleId\`, \`locale\`, \`status\`, \`inviteToken\`, \`inviteExpiresAt\`)
     VALUES (?, ?, ?, ?, ?, 'invited', ?, (NOW() + INTERVAL 7 DAY))`,
    [email, await hashPassword(randomHex(24)), displayName, role.id, t.locale, token],
  );
  await sendInvite(c, email, token, t.locale);
  return c.redirect(withFlash('/admin/users', 'ok', emailWorks() ? t('users.flashInviteSent') : t('users.flashInviteCreatedNoEmail')), 302);
});

async function loadManagedUser(c: Context, auth: AuthContext): Promise<UserListRow | null> {
  const u = await queryOne<UserListRow>(
    `SELECT u.\`id\`, u.\`email\`, u.\`displayName\`, u.\`status\`, u.\`roleId\`, u.\`lastLoginAt\`, u.\`inviteToken\`, u.\`totpVerified\`,
            r.\`slug\` AS roleSlug, r.\`label\` AS roleLabel
       FROM \`users\` u LEFT JOIN \`roles\` r ON r.\`id\` = u.\`roleId\` WHERE u.\`id\` = ?`,
    [Number(c.req.param('id'))],
  );
  if (!u) return null;
  return (await manageable(auth, u.roleId)) ? u : null;
}

adminAccount.get('/users/:id{[0-9]+}', async (c) => {
  const auth = gate(c);
  if (notAuth(auth)) return auth;
  const t = getT(c);
  if (!allowed(auth, 'manageUsers')) return usersForbidden(c, t);
  const u = await loadManagedUser(c, auth);
  if (!u) return c.redirect(withFlash('/admin/users', 'err', t('users.flashNotFound')), 302);
  const roles = await assignableRoles(auth);
  const isSelf = u.id === auth.user.id;
  const inviteLink = u.status === 'invited' && u.inviteToken ? `${adminBaseUrl(c)}/admin/accept-invite?token=${u.inviteToken}` : null;
  return c.html(
    <AdminPage title={u.displayName} active="users" t={t} {...pageUser(auth)}>
      <div class="top">
        <h1>{t('users.editTitle', { name: u.displayName })}</h1>
        <a class="btn sec" href="/admin/users">{t('users.backToUsers')}</a>
      </div>
      <Flash flash={readFlash(c)} />
      <div class="grid g2" style="align-items:start">
        <div class="card">
          <form method="post" action={`/admin/users/${u.id}`}>
            <label for="displayName" style="margin-top:0">{t('users.displayName')}</label>
            <input type="text" name="displayName" id="displayName" value={u.displayName} required maxlength={128} />
            <label for="email">{t('users.email')}</label>
            <input type="email" name="email" id="email" value={u.email} required />
            <label for="roleSlug">{t('users.role')}</label>
            <select name="roleSlug" id="roleSlug" disabled={isSelf}>
              {roles.map((r) => <option value={r.slug} selected={r.id === u.roleId}>{r.label}</option>)}
            </select>
            {isSelf ? <div class="help">{t('users.cannotChangeOwnRole')}</div> : null}
            <label for="password">{t('users.setNewPassword')}</label>
            <input type="password" name="password" id="password" minlength={MIN_PASSWORD} autocomplete="new-password" />
            <div class="help">{t('users.setNewPasswordHelp', { n: MIN_PASSWORD })}</div>
            <div style="margin-top:18px"><button class="btn" type="submit">{t('common.save')}</button></div>
          </form>
        </div>
        <div class="stack">
          <div class="card">
            <h3>{t('users.accountTitle')}</h3>
            <dl class="kv" style="margin:10px 0 0">
              <dt>{t('users.colStatus')}</dt><dd>{t(`users.status.${u.status}`)}</dd>
              <dt>{t('users.colLastLogin')}</dt><dd>{u.lastLoginAt ? <DateTime value={u.lastLoginAt} /> : t('users.neverLoggedIn')}</dd>
              <dt>{t('profile.twoFactorTitle')}</dt><dd>{Number(u.totpVerified) === 1 ? t('profile.twoFactorOn') : t('profile.twoFactorOff')}</dd>
            </dl>
            {Number(u.totpVerified) === 1 && !isSelf ? (
              <form method="post" action={`/admin/users/${u.id}/reset-2fa`} style="margin:10px 0 0">
                <button class="btn sm sec" type="submit" data-confirm={t('users.confirmResetTwoFactor', { name: u.displayName })}>{t('users.resetTwoFactor')}</button>
                <div class="help">{t('users.resetTwoFactorHelp')}</div>
              </form>
            ) : null}
            {inviteLink ? (
              <>
                <p class="help">{t('users.invitePending')}</p>
                <code class="secret">{inviteLink}</code>
                <div class="toolbar">
                  <button type="button" class="btn sm sec" data-copy={inviteLink} data-copied={t('common.copied')}>{t('users.copyInviteLink')}</button>
                  <form method="post" action={`/admin/users/${u.id}/resend`} style="margin:0">
                    <button class="btn sm sec" type="submit">{t('users.resendInvite')}</button>
                  </form>
                </div>
              </>
            ) : null}
          </div>
          {!isSelf ? (
            <div class="card">
              <h3>{t('users.dangerTitle')}</h3>
              <div class="toolbar" style="margin-top:10px">
                {u.status !== 'invited' ? (
                  <form method="post" action={`/admin/users/${u.id}/toggle`} style="margin:0">
                    <button class="btn sec" type="submit">{u.status === 'suspended' ? t('users.unsuspend') : t('users.suspend')}</button>
                  </form>
                ) : null}
                <form method="post" action={`/admin/users/${u.id}/delete`} style="margin:0">
                  <button class="btn danger" type="submit" data-confirm={t('users.confirmDelete', { name: u.displayName })}>{t('users.deleteUser')}</button>
                </form>
              </div>
              <div class="help">{t('users.suspendHelp')}</div>
            </div>
          ) : null}
        </div>
      </div>
    </AdminPage>,
  );
});

adminAccount.post('/users/:id{[0-9]+}', async (c) => {
  const auth = gate(c);
  if (notAuth(auth)) return auth;
  const t = getT(c);
  if (!allowed(auth, 'manageUsers')) return usersForbidden(c, t);
  const u = await loadManagedUser(c, auth);
  if (!u) return c.redirect(withFlash('/admin/users', 'err', t('users.flashNotFound')), 302);
  const back = `/admin/users/${u.id}`;
  const b = await c.req.parseBody();
  const displayName = String(b.displayName ?? '').trim().slice(0, 128);
  const email = String(b.email ?? '').toLowerCase().trim();
  const password = String(b.password ?? '');
  if (!displayName || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return c.redirect(withFlash(back, 'err', t('users.flashInvalidInput')), 302);
  if (password && password.length < MIN_PASSWORD) return c.redirect(withFlash(back, 'err', t('account.passwordTooShort', { n: MIN_PASSWORD })), 302);
  const dup = await queryOne<{ id: number }>('SELECT `id` FROM `users` WHERE `email` = ? AND `id` <> ?', [email, u.id]);
  if (dup) return c.redirect(withFlash(back, 'err', t('users.flashEmailUsed')), 302);

  const sets = ['`displayName` = ?', '`email` = ?'];
  const params: unknown[] = [displayName, email];
  if (u.id !== auth.user.id && b.roleSlug) {
    const role = await findRoleBySlug(String(b.roleSlug));
    if (!role) return c.redirect(withFlash(back, 'err', t('users.flashInvalidInput')), 302);
    if (!grantsWithinActor(auth.role.capabilities, role.capabilities)) return c.redirect(withFlash(back, 'err', t('users.flashRoleTooHigh')), 302);
    sets.push('`roleId` = ?'); params.push(role.id);
  }
  if (password) {
    sets.push('`passwordHash` = ?'); params.push(await hashPassword(password));
    // Setting a password for a pending invite activates the account.
    if (u.status === 'invited') sets.push("`status` = 'active'", '`inviteToken` = NULL', '`inviteExpiresAt` = NULL');
  }
  params.push(u.id);
  await execute(`UPDATE \`users\` SET ${sets.join(', ')} WHERE \`id\` = ?`, params);
  if (password) {
    await deleteAllSessionsForUser(u.id);
    if (u.id === auth.user.id) await startSession(c, u.id);
  }
  return c.redirect(withFlash(back, 'ok', t('users.flashUpdated')), 302);
});

adminAccount.post('/users/:id{[0-9]+}/reset-2fa', async (c) => {
  const auth = gate(c);
  if (notAuth(auth)) return auth;
  const t = getT(c);
  if (!allowed(auth, 'manageUsers')) return usersForbidden(c, t);
  const u = await loadManagedUser(c, auth);
  if (!u) return c.redirect(withFlash('/admin/users', 'err', t('users.flashNotFound')), 302);
  await execute('UPDATE `users` SET `totpSecret` = NULL, `totpVerified` = 0 WHERE `id` = ?', [u.id]);
  return c.redirect(withFlash(`/admin/users/${u.id}`, 'ok', t('users.flashTwoFactorReset')), 302);
});

adminAccount.post('/users/:id{[0-9]+}/resend', async (c) => {
  const auth = gate(c);
  if (notAuth(auth)) return auth;
  const t = getT(c);
  if (!allowed(auth, 'manageUsers')) return usersForbidden(c, t);
  const u = await loadManagedUser(c, auth);
  if (!u || u.status !== 'invited') return c.redirect(withFlash('/admin/users', 'err', t('users.flashNotFound')), 302);
  const token = randomHex(32);
  await execute('UPDATE `users` SET `inviteToken` = ?, `inviteExpiresAt` = (NOW() + INTERVAL 7 DAY) WHERE `id` = ?', [token, u.id]);
  await sendInvite(c, u.email, token, t.locale);
  return c.redirect(withFlash(`/admin/users/${u.id}`, 'ok', emailWorks() ? t('users.flashInviteSent') : t('users.flashInviteCreatedNoEmail')), 302);
});

adminAccount.post('/users/:id{[0-9]+}/toggle', async (c) => {
  const auth = gate(c);
  if (notAuth(auth)) return auth;
  const t = getT(c);
  if (!allowed(auth, 'manageUsers')) return usersForbidden(c, t);
  const u = await loadManagedUser(c, auth);
  if (!u) return c.redirect(withFlash('/admin/users', 'err', t('users.flashNotFound')), 302);
  if (u.id === auth.user.id) return c.redirect(withFlash('/admin/users', 'err', t('users.flashCannotChangeSelf')), 302);
  const next = u.status === 'suspended' ? 'active' : 'suspended';
  await execute('UPDATE `users` SET `status` = ? WHERE `id` = ?', [next, u.id]);
  if (next === 'suspended') await deleteAllSessionsForUser(u.id);
  return c.redirect(withFlash(`/admin/users/${u.id}`, 'ok', t('users.flashUpdated')), 302);
});

adminAccount.post('/users/:id{[0-9]+}/delete', async (c) => {
  const auth = gate(c);
  if (notAuth(auth)) return auth;
  const t = getT(c);
  if (!allowed(auth, 'manageUsers')) return usersForbidden(c, t);
  const u = await loadManagedUser(c, auth);
  if (!u) return c.redirect(withFlash('/admin/users', 'err', t('users.flashNotFound')), 302);
  if (u.id === auth.user.id) return c.redirect(withFlash('/admin/users', 'err', t('users.flashCannotChangeSelf')), 302);
  // Content, media and settings keep existing; their author link is cleared
  // by the database (ON DELETE SET NULL). Sessions and tokens go with the user.
  await execute('DELETE FROM `users` WHERE `id` = ?', [u.id]);
  return c.redirect(withFlash('/admin/users', 'ok', t('users.flashDeleted', { name: u.displayName })), 302);
});
