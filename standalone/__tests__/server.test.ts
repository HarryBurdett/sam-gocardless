import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import { buildApp } from '../server.js';

const originalEnv = { ...process.env };
let tmpDir: string;
let server: Server;
let url: string;
let companies: Awaited<ReturnType<typeof buildApp>>['companies'];
let operaAdapter: Awaited<ReturnType<typeof buildApp>>['operaAdapter'];

beforeAll(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), 'sgc-server-'));
  // Create two company directories so discovery picks them up.
  mkdirSync(join(tmpDir, 'data', 'intsys'), { recursive: true });
  mkdirSync(join(tmpDir, 'data', 'cloudsis'), { recursive: true });
  process.env.LOGIN_PASSWORD = 'shibboleth';
  process.env.DATA_ROOT = join(tmpDir, 'data');
  process.env.SESSION_SECRET = 'test-secret-please-change-32chars';
  delete process.env.LEGACY_DATA_ROOT;
  const built = await buildApp({ dataDir: tmpDir });
  companies = built.companies;
  operaAdapter = built.operaAdapter;
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
  for (const c of companies.values()) {
    await c.samDb.destroy();
    await c.appDb.destroy();
  }
  if (operaAdapter.destroy) await operaAdapter.destroy();
  process.env = originalEnv;
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('server (multi-company)', () => {
  it('GET /healthz (no auth) returns ok + company list', async () => {
    const res = await fetch(`${url}/healthz`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.companies.sort()).toEqual(['cloudsis', 'intsys']);
    expect(body.adapter).toBe('noop');
  });

  it('serves /login.html without auth', async () => {
    const res = await fetch(`${url}/login.html`);
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toMatch(/<form/i);
  });

  it('GET /auth/companies (no auth) lists discovered companies', async () => {
    const res = await fetch(`${url}/auth/companies`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.companies.sort()).toEqual(['cloudsis', 'intsys']);
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

  it('rejects login with an unknown company', async () => {
    const res = await fetch(`${url}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: 'shibboleth', company: 'nope' }),
    });
    expect(res.status).toBe(400);
  });

  it('serves the plugin API after login and exposes the company via /auth/me', async () => {
    const login = await fetch(`${url}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: 'shibboleth', company: 'intsys' }),
    });
    expect(login.status).toBe(200);
    const cookie = login.headers.get('set-cookie');
    expect(cookie).toBeTruthy();
    const sessionCookie = (cookie ?? '').split(';')[0];

    const meRes = await fetch(`${url}/auth/me`, {
      headers: { Cookie: sessionCookie },
    });
    expect(meRes.status).toBe(200);
    const me = await meRes.json();
    expect(me.company).toBe('intsys');

    const res = await fetch(
      `${url}/api/apps/gocardless/api/gocardless/settings`,
      { headers: { Cookie: sessionCookie } },
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.settings).toBeTypeOf('object');
  });

  it('keeps each company\'s settings isolated', async () => {
    // Write a non-default subscription_tag for intsys.
    const intsysLogin = await fetch(`${url}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: 'shibboleth', company: 'intsys' }),
    });
    const intsysCookie = (intsysLogin.headers.get('set-cookie') ?? '').split(';')[0];
    const post = await fetch(
      `${url}/api/apps/gocardless/api/gocardless/settings`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: intsysCookie },
        body: JSON.stringify({ subscription_tag: 'INTSYS_TAG' }),
      },
    );
    expect(post.status).toBe(200);

    // Cloudsis session should NOT see INTSYS_TAG.
    const cloudsisLogin = await fetch(`${url}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: 'shibboleth', company: 'cloudsis' }),
    });
    const cloudsisCookie = (cloudsisLogin.headers.get('set-cookie') ?? '').split(';')[0];
    const cloudsisGet = await fetch(
      `${url}/api/apps/gocardless/api/gocardless/settings`,
      { headers: { Cookie: cloudsisCookie } },
    );
    const cloudsisBody = await cloudsisGet.json();
    expect(cloudsisBody.settings.subscription_tag).not.toBe('INTSYS_TAG');

    // Re-read intsys — should still show INTSYS_TAG.
    const intsysGet = await fetch(
      `${url}/api/apps/gocardless/api/gocardless/settings`,
      { headers: { Cookie: intsysCookie } },
    );
    const intsysBody = await intsysGet.json();
    expect(intsysBody.settings.subscription_tag).toBe('INTSYS_TAG');
  });
});
