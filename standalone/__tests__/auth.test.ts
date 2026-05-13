import { describe, it, expect } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import { loginRouter, requireAuth, signSession } from '../auth.js';

const CONFIG = {
  port: 0,
  dataRoot: '/tmp',
  legacyDataRoot: null,
  loginPassword: 'shibboleth',
  sessionSecret: 'test-secret-32-bytes-long-abcdef',
  operaAdapter: 'noop',
  dataDir: '/tmp',
  trustProxy: 'loopback',
};

const KNOWN_COMPANIES = ['intsys', 'cloudsis'];

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/auth', loginRouter(CONFIG, () => KNOWN_COMPANIES));
  app.use(requireAuth(CONFIG));
  app.get('/protected', (req, res) => {
    res.json({
      user: req.user,
      company: req.standaloneCompany,
      operaCompany: req.operaCompany,
    });
  });
  return app;
}

function listen(app: express.Express): Promise<{ server: Server; url: string }> {
  return new Promise((resolve) => {
    const server = app.listen(0, () => {
      const addr = server.address();
      if (!addr || typeof addr === 'string') throw new Error('no addr');
      resolve({ server, url: `http://127.0.0.1:${addr.port}` });
    });
  });
}

function close(server: Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

describe('auth', () => {
  it('GET /auth/companies returns the registered list (no auth)', async () => {
    const { server, url } = await listen(makeApp());
    const res = await fetch(`${url}/auth/companies`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.companies).toEqual(KNOWN_COMPANIES);
    await close(server);
  });

  it('rejects wrong password with 401 after ~1s delay', async () => {
    const { server, url } = await listen(makeApp());
    const start = Date.now();
    const res = await fetch(`${url}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: 'wrong', company: 'intsys' }),
    });
    const elapsed = Date.now() - start;
    expect(res.status).toBe(401);
    expect(elapsed).toBeGreaterThanOrEqual(900);
    await close(server);
  }, 5000);

  it('rejects unknown company with 400', async () => {
    const { server, url } = await listen(makeApp());
    const res = await fetch(`${url}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: 'shibboleth', company: 'nope' }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/unknown company/i);
    await close(server);
  }, 5000);

  it('accepts correct password + valid company and returns a Set-Cookie', async () => {
    const { server, url } = await listen(makeApp());
    const res = await fetch(`${url}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: 'shibboleth', company: 'intsys' }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.company).toBe('intsys');
    const setCookie = res.headers.get('set-cookie');
    expect(setCookie).toMatch(/^sgc_session=/);
    expect(setCookie).toMatch(/HttpOnly/);
    expect(setCookie).toMatch(/SameSite=Lax/);
    await close(server);
  });

  it('requireAuth rejects API requests without a cookie with 401 JSON', async () => {
    const { server, url } = await listen(makeApp());
    const res = await fetch(`${url}/protected`);
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toMatch(/authentication required/);
    await close(server);
  });

  it('requireAuth redirects HTML requests to /login.html', async () => {
    const { server, url } = await listen(makeApp());
    const res = await fetch(`${url}/protected`, {
      headers: { Accept: 'text/html' },
      redirect: 'manual',
    });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/login.html');
    await close(server);
  });

  it('requireAuth accepts a valid signed cookie and exposes the company', async () => {
    const { server, url } = await listen(makeApp());
    const cookie = signSession(
      {
        userId: 'local',
        email: 'local@standalone',
        companyCode: 'intsys',
        issuedAt: Date.now(),
      },
      CONFIG.sessionSecret,
    );
    const res = await fetch(`${url}/protected`, {
      headers: { Cookie: `sgc_session=${encodeURIComponent(cookie)}` },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.user.userId).toBe('local');
    expect(body.user.role).toBe('admin');
    expect(body.company).toBe('intsys');
    expect(body.operaCompany).toBe('intsys');
    await close(server);
  });

  it('requireAuth rejects a tampered cookie', async () => {
    const { server, url } = await listen(makeApp());
    const cookie = signSession(
      {
        userId: 'local',
        email: 'local@standalone',
        companyCode: 'intsys',
        issuedAt: Date.now(),
      },
      CONFIG.sessionSecret,
    );
    const tampered = cookie.replace(/^./, 'X');
    const res = await fetch(`${url}/protected`, {
      headers: { Cookie: `sgc_session=${encodeURIComponent(tampered)}` },
    });
    expect(res.status).toBe(401);
    await close(server);
  });

  it('requireAuth rejects a future-dated issuedAt', async () => {
    const { server, url } = await listen(makeApp());
    const cookie = signSession(
      {
        userId: 'local',
        email: 'local@standalone',
        companyCode: 'intsys',
        issuedAt: Date.now() + 24 * 60 * 60 * 1000,
      },
      CONFIG.sessionSecret,
    );
    const res = await fetch(`${url}/protected`, {
      headers: { Cookie: `sgc_session=${encodeURIComponent(cookie)}` },
    });
    expect(res.status).toBe(401);
    await close(server);
  });

  it('requireAuth rejects a cookie missing companyCode', async () => {
    const { server, url } = await listen(makeApp());
    // Hand-craft a payload without companyCode
    const cookie = signSession(
      // @ts-expect-error — deliberately omitting companyCode
      { userId: 'local', email: 'local@standalone', issuedAt: Date.now() },
      CONFIG.sessionSecret,
    );
    const res = await fetch(`${url}/protected`, {
      headers: { Cookie: `sgc_session=${encodeURIComponent(cookie)}` },
    });
    expect(res.status).toBe(401);
    await close(server);
  });
});
