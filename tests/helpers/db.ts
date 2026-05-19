// Test DB lifecycle helpers. Integration tests require a reachable MySQL
// (env: DB_* / SKELPO_TEST_DB). They self-skip when no DB is configured
// so the unit suite stays runnable anywhere.

import { execSync } from 'node:child_process';

export const TEST_DB = process.env.SKELPO_TEST_DB ?? 'skelpo_test';

export function mysqlAvailable(): boolean {
  try {
    execSync(`mysql -uroot -e "SELECT 1" 2>/dev/null`, { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/** Drop + recreate the test schema, then migrate + seed via the CLI. */
export function resetDb(): void {
  execSync(
    `mysql -uroot -e "DROP DATABASE IF EXISTS \\\`${TEST_DB}\\\`; ` +
      `CREATE DATABASE \\\`${TEST_DB}\\\` CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci"`,
    { stdio: 'ignore' },
  );
  const env = testEnv();
  execSync(`node --import tsx src/cli/main.ts migrate`, { stdio: 'ignore', env });
  execSync(`node --import tsx src/cli/main.ts seed`, { stdio: 'ignore', env });
}

export function testEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    PORT: process.env.TEST_PORT ?? '3199',
    HOST: '127.0.0.1',
    SITE_URL: 'http://127.0.0.1:3199',
    DB_HOST: '127.0.0.1',
    DB_PORT: '3306',
    DB_USER: 'root',
    DB_PASSWORD: '',
    DB_NAME: TEST_DB,
    SESSION_SECRET: 'test_secret_test_secret_test_secret_test_secret_test_secret_x',
    EMAIL_BACKEND: 'log',
    EMAIL_FROM: 'test@example.com',
    MEDIA_BACKEND: 'local',
    MEDIA_LOCAL_PATH: './.testuploads',
    IMGPROXY_URL: 'http://127.0.0.1:8080',
    IMGPROXY_SIGN_KEY: '',
    IMGPROXY_SALT: '',
    LOG_LEVEL: 'error',
  };
}

/** Create an active admin user directly (bypasses invite flow). */
export async function seedAdminUser(): Promise<void> {
  const bcrypt = (await import('bcryptjs')).default;
  const hash = await bcrypt.hash('Test1234!', 12);
  execSync(
    `mysql -uroot ${TEST_DB} -e "INSERT INTO users (email,passwordHash,displayName,roleId,status) ` +
      `SELECT 'admin@test.local','${hash}','Admin',id,'active' FROM roles WHERE slug='admin'"`,
    { stdio: 'ignore' },
  );
}
