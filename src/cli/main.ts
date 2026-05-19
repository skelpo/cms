// `skelpo-cms <subcommand>` — operator CLI.
//
// Subcommands (v0.1):
//   migrate                            Apply pending migrations
//   seed                               Re-run idempotent built-in seed
//   user create <email> <displayName> [--role admin]
//                                      Create a user. Prompts for password.
//   user list                          List all users
//   version                            Print version
//   help                               Show usage

import { runMigrations } from '../db/migrate.js';
import { runSeed } from '../db/seed.js';
import { closeDb, execute, queryOne } from '../db/client.js';
import { hashPassword } from '../auth/password.js';
import { findRoleBySlug, listRoles } from '../auth/users.js';
import {
  createBackup,
  restoreBackup,
  exportSchema,
  importSchema,
  generateTypes,
} from './backup.js';
import { writeFile, readFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';

const VERSION = '0.1.0-pre';

function usage(): void {
  console.log(`skelpo-cms ${VERSION}

Usage: skelpo-cms <command> [args]

Commands:
  migrate                              Apply pending migrations
  seed                                 Re-run idempotent built-in seed
  user create <email> <name>           Create a user (prompts for password)
    [--role <slug>]                    Default: admin
  user list                            List all users
  role list                            List roles
  backup [file]                        Dump DB + media to a .skelpo-backup
  restore <file>                       Restore from a .skelpo-backup
  export [file]                        Export content-type/role schema JSON
  import <file>                        Apply an exported schema JSON
  types-codegen [file]                 Emit TS interfaces from schemas
  version                              Print version
  help                                 Show this help
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
    const { applied, skipped } = await runMigrations();
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
    const { inserted } = await runSeed();
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
  const role = await findRoleBySlug(roleSlug);
  if (!role) {
    console.error(`Role not found: ${roleSlug}. Run 'skelpo-cms role list' to see options.`);
    return 1;
  }
  const existing = await queryOne<{ id: number }>(
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

  const hash = await hashPassword(password);
  const r = await execute(
    `INSERT INTO \`users\` (\`email\`, \`passwordHash\`, \`displayName\`, \`roleId\`, \`status\`)
     VALUES (?, ?, ?, ?, 'active')`,
    [email.toLowerCase(), hash, name, role.id],
  );
  console.log(`Created user #${r.insertId} (${email}) as ${role.slug}.`);
  return 0;
}

async function cmdUserList(): Promise<number> {
  const rows = await queryOne<{ n: number }>('SELECT COUNT(*) AS n FROM `users`');
  const { query } = await import('../db/client.js');
  const users = await query<{ id: number; email: string; displayName: string; roleId: number; status: string; createdAt: string }>(
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
  const roles = await listRoles();
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
  try {
    switch (cmd) {
      case 'migrate':
        code = await cmdMigrate();
        break;
      case 'seed':
        code = await cmdSeed();
        break;
      case 'user':
        if (rest[0] === 'create') code = await cmdUserCreate(rest.slice(1));
        else if (rest[0] === 'list') code = await cmdUserList();
        else { console.error('Unknown user subcommand'); usage(); code = 2; }
        break;
      case 'role':
        if (rest[0] === 'list') code = await cmdRoleList();
        else { console.error('Unknown role subcommand'); usage(); code = 2; }
        break;
      case 'backup': {
        const out = rest[0] ?? `skelpo-${new Date().toISOString().slice(0, 10)}.skelpo-backup`;
        const r = await createBackup(out);
        console.log(`Backup written: ${out} (${r.tables} tables, ${r.mediaFiles} media files, ${(r.bytes / 1024).toFixed(0)} KB)`);
        break;
      }
      case 'restore': {
        const inp = rest[0];
        if (!inp) { console.error('Usage: skelpo-cms restore <file.skelpo-backup>'); code = 2; break; }
        const r = await restoreBackup(inp);
        console.log(`Restored ${r.rows} rows across ${r.tables} tables, ${r.mediaFiles} media files.`);
        break;
      }
      case 'export': {
        const out = rest[0];
        const json = await exportSchema();
        if (out) { await writeFile(out, json); console.log(`Schema exported → ${out}`); }
        else console.log(json);
        break;
      }
      case 'import': {
        const inp = rest[0];
        if (!inp) { console.error('Usage: skelpo-cms import <schema.json>'); code = 2; break; }
        const r = await importSchema(await readFile(inp, 'utf8'));
        console.log(`Imported ${r.types} content types, ${r.roles} roles.`);
        break;
      }
      case 'types-codegen': {
        const out = rest[0];
        const ts = await generateTypes();
        if (out) { await writeFile(out, ts); console.log(`Types written → ${out}`); }
        else console.log(ts);
        break;
      }
      case 'version':
      case '--version':
      case '-v':
        console.log(VERSION);
        break;
      case 'help':
      case '--help':
      case '-h':
        usage();
        break;
      default:
        console.error(`Unknown command: ${cmd}`);
        usage();
        code = 2;
    }
  } finally {
    await closeDb();
  }
  process.exit(code);
}

void main();
