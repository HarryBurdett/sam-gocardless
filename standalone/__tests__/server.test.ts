import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import type { Knex } from 'knex';
import { buildApp } from '../server.js';

const originalEnv = { ...process.env };
let tmpDir: string;
let server: Server;
let url: string;
let appDb: Knex;
let samDb: Knex;

beforeAll(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), 'sgc-server-'));
  process.env.LOGIN_PASSWORD = 'shibboleth';
  process.env.DATABASE_PATH = join(tmpDir, 'gocardless.sqlite');
  process.env.SESSION_SECRET = 'test-secret-please-change-32chars';
  const built = await buildApp({ dataDir: tmpDir });
  appDb = built.appDb;
  samDb = built.samDb;
  await new Promise<void>((resolve) => {
    server = built.app.listen(0, () => {
      const addr = server.address();
      if (!addr || typeof addr === 'string') throw new Error('no addr');
      url = `http://127.0.0.1:${addr.port}`;
      resolve();
    });
  });
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await samDb.destroy();
  await appDb.destroy();
  process.env = originalEnv;
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('server', () => {
  it('serves /login.html without auth', async () => {
    const res = await fetch(`${url}/login.html`);
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toMatch(/<form/i);
  });

  it('redirects unauthenticated browser requests for / to /login.html', async () => {
    const res = await fetch(`${url}/`, {
      headers: { Accept: 'text/html' },
      redirect: 'manual',
    });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/login.html');
  });

  it('rejects unauthenticated API requests with 401', async () => {
    const res = await fetch(`${url}/api/apps/gocardless/api/gocardless/settings`);
    expect(res.status).toBe(401);
  });

  it('serves the plugin API after login', async () => {
    const login = await fetch(`${url}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: 'shibboleth' }),
    });
    expect(login.status).toBe(200);
    const cookie = login.headers.get('set-cookie');
    expect(cookie).toBeTruthy();
    const sessionCookie = (cookie ?? '').split(';')[0];

    const res = await fetch(
      `${url}/api/apps/gocardless/api/gocardless/settings`,
      { headers: { Cookie: sessionCookie } },
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.settings).toBeTypeOf('object');
  });
});
