// Persistent CLI session (cookie token + server URL). Lives at
// ~/.skelpo/session.json so the user logs in once per machine.
//
// Override per-invocation via env:
//   SKELPO_SERVER=https://cms.example.com
//   SKELPO_TOKEN=<api-token-or-session-token>

import { readFile, writeFile, mkdir, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';

const SESSION_FILE = join(homedir(), '.skelpo', 'session.json');

export interface SkelpoSession {
  server: string;
  token: string;
  email?: string;
  /** 'session' = browser-style cookie token (skelpoSession); 'apiToken' = bearer. */
  kind: 'session' | 'apiToken';
}

export async function loadSession(): Promise<SkelpoSession | null> {
  const envServer = process.env.SKELPO_SERVER;
  const envToken = process.env.SKELPO_TOKEN;
  if (envServer && envToken) {
    return { server: envServer, token: envToken, kind: 'apiToken' };
  }
  try {
    const body = await readFile(SESSION_FILE, 'utf8');
    return JSON.parse(body) as SkelpoSession;
  } catch { return null; }
}

export async function saveSession(s: SkelpoSession): Promise<void> {
  await mkdir(dirname(SESSION_FILE), { recursive: true, mode: 0o700 });
  await writeFile(SESSION_FILE, JSON.stringify(s, null, 2), { mode: 0o600 });
}

export async function clearSession(): Promise<void> {
  try { await unlink(SESSION_FILE); } catch { /* already gone */ }
}
