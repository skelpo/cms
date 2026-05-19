// Boots the CMS as a child process for integration tests, waits for
// readiness, and tears it down. One server per test file.

import { spawn, type ChildProcess } from 'node:child_process';
import { testEnv } from './db.js';

const BASE = `http://127.0.0.1:${process.env.TEST_PORT ?? '3199'}`;

let proc: ChildProcess | null = null;

export async function startServer(timeoutMs = 15000): Promise<string> {
  proc = spawn('node', ['--import', 'tsx', 'src/server.ts'], {
    env: testEnv(),
    stdio: 'ignore',
  });
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${BASE}/readyz`);
      if (r.ok) return BASE;
    } catch {
      /* not up yet */
    }
    await new Promise((res) => setTimeout(res, 250));
  }
  throw new Error('server did not become ready in time');
}

export async function stopServer(): Promise<void> {
  if (proc) {
    proc.kill('SIGTERM');
    proc = null;
    await new Promise((res) => setTimeout(res, 300));
  }
}

export interface ApiClient {
  base: string;
  cookie: string;
  get(path: string, auth?: boolean): Promise<Response>;
  post(path: string, body?: unknown, auth?: boolean): Promise<Response>;
  patch(path: string, body?: unknown, auth?: boolean): Promise<Response>;
  del(path: string, auth?: boolean): Promise<Response>;
}

export async function loginClient(
  email = 'admin@test.local',
  password = 'Test1234!',
): Promise<ApiClient> {
  const res = await fetch(`${BASE}/api/v1/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  const json = (await res.json()) as { data?: { token?: string } };
  const cookie = json.data?.token ? `skelpoSession=${json.data.token}` : '';
  const hdr = (auth: boolean): Record<string, string> =>
    auth && cookie ? { Cookie: cookie } : {};
  return {
    base: BASE,
    cookie,
    get: (p, auth = false) => fetch(`${BASE}${p}`, { headers: hdr(auth) }),
    post: (p, b, auth = true) =>
      fetch(`${BASE}${p}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...hdr(auth) },
        body: b === undefined ? undefined : JSON.stringify(b),
      }),
    patch: (p, b, auth = true) =>
      fetch(`${BASE}${p}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', ...hdr(auth) },
        body: JSON.stringify(b),
      }),
    del: (p, auth = true) => fetch(`${BASE}${p}`, { method: 'DELETE', headers: hdr(auth) }),
  };
}
