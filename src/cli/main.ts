// `skelpo-cms <subcommand>` — admin + ops CLI.
//
// Two flavors of subcommand:
//   - DB-direct (migrate, seed, backup, restore, export, import,
//     types-codegen, user create/list, role list): talks to the local
//     MySQL directly. Doesn't need the CMS server running.
//   - HTTP API (content, types, settings, menus, media, users, roles,
//     redirects, webhooks, jobs, forms, tokens, api): talks to the CMS
//     via /api/v1/* using a saved session. Works against remote servers
//     too (set SKELPO_SERVER + SKELPO_TOKEN, or `skelpo-cms login`).
//
// Everything the admin UI can do is exposed through one or the other.

// HTTP-only commands (the bulk of the CLI) shouldn't require the CMS env
// vars (SESSION_SECRET, DB_*) — they just call the running API. So those
// commands live in a separate module with no DB-layer imports.
import {
  cmdLogin, cmdLogout, cmdWhoami,
  cmdTokens, cmdContent, cmdTypes, cmdSettings,
  cmdMenus, cmdMedia, cmdUsers as cmdUsersHttp, cmdRoles as cmdRolesHttp,
  cmdRedirects, cmdWebhooks, cmdJobs, cmdForms, cmdApi,
} from './commands.js';
import { writeFile, readFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';

// DB-direct ops are lazy-loaded so HTTP-only invocations don't require
// SESSION_SECRET / DB_* env vars.
async function loadDbOps() {
  const [{ runMigrations }, { runSeed }, db, { hashPassword }, users, { createBackup, restoreBackup, exportSchema, importSchema, generateTypes }] = await Promise.all([
    import('../db/migrate.js'),
    import('../db/seed.js'),
    import('../db/client.js'),
    import('../auth/password.js'),
    import('../auth/users.js'),
    import('./backup.js'),
  ]);
  return { runMigrations, runSeed, ...db, hashPassword, ...users, createBackup, restoreBackup, exportSchema, importSchema, generateTypes };
}
type DbOps = Awaited<ReturnType<typeof loadDbOps>>;
let _db: DbOps | null = null;
async function db(): Promise<DbOps> { return _db ??= await loadDbOps(); }

const VERSION = '0.1.0-pre';

function usage(): void {
  console.log(`skelpo-cms ${VERSION}

Usage: skelpo-cms <command> [args]

OPS (direct DB — no server needed)
  migrate                              Apply pending migrations
  seed                                 Re-run idempotent built-in seed
  backup [file]                        Dump DB + media to a .skelpo-backup
  restore <file>                       Restore from a .skelpo-backup
  export [file]                        Export content-type/role schema JSON
  import <file>                        Apply an exported schema JSON
  types-codegen [file]                 Emit TS interfaces from schemas

AUTH (via HTTP API)
  login [--server=URL --email=... --password=...]
                                       Sign in, save session to ~/.skelpo/session.json
  logout                               Clear local session
  whoami                               Show current user + server

  tokens list                          List API tokens
  tokens create <name> [--scopes=*] [--ttl-days=365]
                                       Create a long-lived API token
  tokens revoke <id>                   Revoke a token

CONTENT
  content list [--type=post --locale=en --status=published --limit=50 --slug=...]
  content get <type> <slug> [--locale=en]
  content create [--type --slug --locale --title] [--file=row.json] [--from-md=body.md]
                 [--publish]
  content update <id>  [--title --slug --file=patch.json --from-md=body.md]
  content publish <id>
  content unpublish <id>
  content delete <id>

TYPES
  types list
  types get <slug>
  types create --file=type.json
  types evolve <slug> --file=schema.json [--dry-run]
  types delete <slug> [--force]

SETTINGS
  settings list [--prefix=site]
  settings get <key>
  settings set <key> <value-or-@file.json>

MENUS
  menus list
  menus tree <slug> [--locale=en]
  menus create <slug> [--label="..."]
  menus add-item <slug> --label="..." --url="..." [--target=_blank] [--parent-id=N]
  menus remove-item <slug> <itemId>
  menus delete <slug>

MEDIA
  media list [--type=image/]
  media get <id>
  media upload <file> [--alt="..."] [--mime=...]
  media delete <id>

USERS / ROLES
  users list
  users create <email> <name> [--role=editor] [--password=...]
  users update <id> [--name=...] [--role=...]
  users suspend <id>
  users unsuspend <id>
  roles list
  roles create <slug> --caps=cap1,cap2,... [--label=...]
  roles update <slug> [--label=... --caps=...]
  roles delete <slug>

REDIRECTS / WEBHOOKS / JOBS / FORMS
  redirects list
  redirects add <from> <to> [--status=301]
  redirects delete <id>
  webhooks list
  webhooks add <url> [--events=content.published,...] [--secret=...]
  webhooks deliveries <id>
  webhooks delete <id>
  jobs stats | list [--status] | get <id> | retry <id>
  forms submissions <slug> | delete-submission <id> | mark-spam <id>

ESCAPE HATCH
  api <METHOD> <path> [--data='{"k":"v"}'|@payload.json]
                                       Raw API call. e.g.:
                                         skelpo-cms api GET /api/v1/content?type=post
                                         skelpo-cms api POST /api/v1/menus --data='{"slug":"a","label":"A"}'

ENV
  SKELPO_SERVER, SKELPO_TOKEN          Use an API token instead of a saved session

MISC
  version, --version, -v
  help, --help, -h
`);
}

function readSecret(prompt: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    // Echo-off via raw mode while reading.
    process.stdout.write(prompt);
    let input = '';
    const onData = (chunk: Buffer): void => {
      const s = chunk.toString('utf8');
      for (const ch of s) {
        if (ch === '\n' || ch === '\r') {
          process.stdin.removeListener('data', onData);
          process.stdin.setRawMode?.(false);
          process.stdout.write('\n');
          rl.close();
          resolve(input);
          return;
        } else if (ch === '\x03') {
          // Ctrl+C
          process.exit(130);
        } else if (ch === '\x7f' || ch === '\b') {
          input = input.slice(0, -1);
        } else {
          input += ch;
        }
      }
    };
    process.stdin.setRawMode?.(true);
    process.stdin.resume();
    process.stdin.on('data', onData);
  });
}

// ────────────────────────────────────────────────────────────────────────

async function cmdMigrate(): Promise<number> {
  try {
    const d = await db();
    const { applied, skipped } = await d.runMigrations();
    console.log(`Applied: ${applied.length}`);
    for (const v of applied) console.log(`  + ${v}`);
    console.log(`Skipped: ${skipped.length}`);
    return 0;
  } catch (err) {
    console.error('Migration failed:', err);
    return 1;
  }
}

async function cmdSeed(): Promise<number> {
  try {
    const d = await db();
    const { inserted } = await d.runSeed();
    console.log('Seed complete:', inserted);
    return 0;
  } catch (err) {
    console.error('Seed failed:', err);
    return 1;
  }
}

async function cmdUserCreate(args: string[]): Promise<number> {
  const email = args[0];
  const name  = args[1];
  if (!email || !name) {
    console.error('Usage: skelpo-cms user create <email> <displayName> [--role <slug>]');
    return 2;
  }
  const roleIdx = args.indexOf('--role');
  const roleSlug = roleIdx >= 0 ? args[roleIdx + 1] : 'admin';
  if (!roleSlug) {
    console.error('--role requires a slug');
    return 2;
  }
  const d = await db();
  const role = await d.findRoleBySlug(roleSlug);
  if (!role) {
    console.error(`Role not found: ${roleSlug}. Run 'skelpo-cms role list' to see options.`);
    return 1;
  }
  const existing = await d.queryOne<{ id: number }>(
    'SELECT `id` FROM `users` WHERE `email` = ?',
    [email.toLowerCase()],
  );
  if (existing) {
    console.error(`User already exists: ${email}`);
    return 1;
  }

  const password = await readSecret('Password: ');
  if (password.length < 8) {
    console.error('Password must be at least 8 characters.');
    return 1;
  }
  const confirm = await readSecret('Confirm:  ');
  if (password !== confirm) {
    console.error('Passwords do not match.');
    return 1;
  }

  const hash = await d.hashPassword(password);
  const r = await d.execute(
    `INSERT INTO \`users\` (\`email\`, \`passwordHash\`, \`displayName\`, \`roleId\`, \`status\`)
     VALUES (?, ?, ?, ?, 'active')`,
    [email.toLowerCase(), hash, name, role.id],
  );
  console.log(`Created user #${r.insertId} (${email}) as ${role.slug}.`);
  return 0;
}

async function cmdUserList(): Promise<number> {
  const d = await db();
  const rows = await d.queryOne<{ n: number }>('SELECT COUNT(*) AS n FROM `users`');
  const users = await d.query<{ id: number; email: string; displayName: string; roleId: number; status: string; createdAt: string }>(
    `SELECT u.\`id\`, u.\`email\`, u.\`displayName\`, u.\`roleId\`, u.\`status\`, u.\`createdAt\`,
            r.\`slug\` AS \`roleSlug\`
       FROM \`users\` u
       LEFT JOIN \`roles\` r ON r.\`id\` = u.\`roleId\`
       ORDER BY u.\`id\``,
  );
  console.log(`${rows?.n ?? 0} user(s):`);
  for (const u of users) {
    console.log(`  #${u.id}  ${u.email}  (${u.displayName})  [${(u as { roleSlug?: string }).roleSlug ?? '?'}]  ${u.status}`);
  }
  return 0;
}

async function cmdRoleList(): Promise<number> {
  const d = await db();
  const roles = await d.listRoles();
  for (const r of roles) {
    const globals = r.capabilities.global.join(',') || '—';
    console.log(`  ${r.slug.padEnd(14)} ${r.label.padEnd(20)} global=[${globals}]`);
  }
  return 0;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const cmd = argv[0] ?? 'help';
  const rest = argv.slice(1);
  let code = 0;
  // HTTP commands skip DB connect/close entirely (they hit the API).
  const HTTP_CMDS = new Set([
    'login', 'logout', 'whoami', 'tokens',
    'content', 'types', 'settings', 'menus', 'media',
    'users', 'roles', 'redirects', 'webhooks', 'jobs', 'forms', 'api',
  ]);
  const isHttp = HTTP_CMDS.has(cmd);

  try {
    switch (cmd) {
      // ── DB-direct ops ────────────────────────────────────────────
      case 'migrate':       code = await cmdMigrate(); break;
      case 'seed':          code = await cmdSeed(); break;
      case 'user':
        if (rest[0] === 'create') code = await cmdUserCreate(rest.slice(1));
        else if (rest[0] === 'list') code = await cmdUserList();
        else { console.error('Unknown user subcommand. Did you mean `users` (HTTP)?'); usage(); code = 2; }
        break;
      case 'role':
        if (rest[0] === 'list') code = await cmdRoleList();
        else { console.error('Unknown role subcommand. Did you mean `roles` (HTTP)?'); usage(); code = 2; }
        break;
      case 'backup': {
        const d = await db();
        const out = rest[0] ?? `skelpo-${new Date().toISOString().slice(0, 10)}.skelpo-backup`;
        const r = await d.createBackup(out);
        console.log(`Backup written: ${out} (${r.tables} tables, ${r.mediaFiles} media files, ${(r.bytes / 1024).toFixed(0)} KB)`);
        break;
      }
      case 'restore': {
        const inp = rest[0];
        if (!inp) { console.error('Usage: skelpo-cms restore <file.skelpo-backup>'); code = 2; break; }
        const d = await db();
        const r = await d.restoreBackup(inp);
        console.log(`Restored ${r.rows} rows across ${r.tables} tables, ${r.mediaFiles} media files.`);
        break;
      }
      case 'export': {
        const d = await db();
        const out = rest[0];
        const json = await d.exportSchema();
        if (out) { await writeFile(out, json); console.log(`Schema exported → ${out}`); }
        else console.log(json);
        break;
      }
      case 'import': {
        const inp = rest[0];
        if (!inp) { console.error('Usage: skelpo-cms import <schema.json>'); code = 2; break; }
        const d = await db();
        const r = await d.importSchema(await readFile(inp, 'utf8'));
        console.log(`Imported ${r.types} content types, ${r.roles} roles.`);
        break;
      }
      case 'types-codegen': {
        const d = await db();
        const out = rest[0];
        const ts = await d.generateTypes();
        if (out) { await writeFile(out, ts); console.log(`Types written → ${out}`); }
        else console.log(ts);
        break;
      }
      // ── HTTP-API ops ─────────────────────────────────────────────
      case 'login':         code = await cmdLogin(rest); break;
      case 'logout':        code = await cmdLogout(); break;
      case 'whoami':        code = await cmdWhoami(); break;
      case 'tokens':        code = await cmdTokens(rest); break;
      case 'content':       code = await cmdContent(rest); break;
      case 'types':         code = await cmdTypes(rest); break;
      case 'settings':      code = await cmdSettings(rest); break;
      case 'menus':         code = await cmdMenus(rest); break;
      case 'media':         code = await cmdMedia(rest); break;
      case 'users':         code = await cmdUsersHttp(rest); break;
      case 'roles':         code = await cmdRolesHttp(rest); break;
      case 'redirects':     code = await cmdRedirects(rest); break;
      case 'webhooks':      code = await cmdWebhooks(rest); break;
      case 'jobs':          code = await cmdJobs(rest); break;
      case 'forms':         code = await cmdForms(rest); break;
      case 'api':           code = await cmdApi(rest); break;
      // ── meta ─────────────────────────────────────────────────────
      case 'version':
      case '--version':
      case '-v':            console.log(VERSION); break;
      case 'help':
      case '--help':
      case '-h':            usage(); break;
      default:
        console.error(`Unknown command: ${cmd}`);
        usage();
        code = 2;
    }
  } catch (e) {
    console.error(`error: ${e instanceof Error ? e.message : String(e)}`);
    code = 1;
  } finally {
    if (!isHttp && _db) await _db.closeDb().catch(() => { /* db may not be connected */ });
  }
  process.exit(code);
}

void main();
