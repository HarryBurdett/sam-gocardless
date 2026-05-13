/**
 * Standalone host auth: shared-password login + signed-cookie sessions.
 *
 * Exports:
 *   - loginRouter(config): POST /login, POST /logout.
 *   - requireAuth(config): middleware that gates everything after it.
 *   - signSession / verifySession: pure helpers (exported for tests).
 *
 * Cookie format: <base64url(JSON payload)>.<hex(HMAC-SHA256 over payload)>
 */
import { Router, type Request, type Response, type NextFunction } from 'express';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { parse as parseCookie, serialize as serializeCookie } from 'cookie';
import type { StandaloneConfig } from './config.js';

const COOKIE_NAME = 'sgc_session';
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const HALF_AGE_MS = MAX_AGE_MS / 2;

export interface SessionPayload {
  userId: string;
  email: string;
  issuedAt: number;
}

export function signSession(payload: SessionPayload, secret: string): string {
  const json = JSON.stringify(payload);
  const b64 = Buffer.from(json, 'utf8').toString('base64url');
  const sig = createHmac('sha256', secret).update(b64).digest('hex');
  return `${b64}.${sig}`;
}

export function verifySession(
  cookie: string,
  secret: string,
): SessionPayload | null {
  const dot = cookie.indexOf('.');
  if (dot < 0) return null;
  const b64 = cookie.slice(0, dot);
  const sig = cookie.slice(dot + 1);
  const expected = createHmac('sha256', secret).update(b64).digest('hex');
  const sigBuf = Buffer.from(sig, 'hex');
  const expectedBuf = Buffer.from(expected, 'hex');
  if (sigBuf.length !== expectedBuf.length) return null;
  if (!timingSafeEqual(sigBuf, expectedBuf)) return null;
  try {
    const payload = JSON.parse(
      Buffer.from(b64, 'base64url').toString('utf8'),
    ) as SessionPayload;
    if (typeof payload.issuedAt !== 'number') return null;
    const now = Date.now();
    // Reject future-dated sessions (clock skew tolerance: 60s).
    if (payload.issuedAt > now + 60_000) return null;
    if (now - payload.issuedAt > MAX_AGE_MS) return null;
    return payload;
  } catch {
    return null;
  }
}

function setSessionCookie(
  res: Response,
  payload: SessionPayload,
  secret: string,
  secure: boolean,
): void {
  const value = signSession(payload, secret);
  res.setHeader(
    'Set-Cookie',
    serializeCookie(COOKIE_NAME, value, {
      httpOnly: true,
      sameSite: 'lax',
      secure,
      path: '/',
      maxAge: Math.floor(MAX_AGE_MS / 1000),
    }),
  );
}

function clearSessionCookie(res: Response): void {
  res.setHeader(
    'Set-Cookie',
    serializeCookie(COOKIE_NAME, '', {
      httpOnly: true,
      sameSite: 'lax',
      path: '/',
      maxAge: 0,
    }),
  );
}

function wantsHtml(req: Request): boolean {
  const accept = req.header('Accept') ?? '';
  return accept.includes('text/html');
}

function timingSafeEqualStr(a: string, b: string): boolean {
  const aBuf = Buffer.from(a, 'utf8');
  const bBuf = Buffer.from(b, 'utf8');
  if (aBuf.length !== bBuf.length) {
    // Still do a comparison to keep timing roughly constant.
    timingSafeEqual(aBuf, Buffer.alloc(aBuf.length));
    return false;
  }
  return timingSafeEqual(aBuf, bBuf);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export function loginRouter(config: StandaloneConfig): Router {
  const router = Router();

  router.post('/login', async (req: Request, res: Response) => {
    const password = typeof req.body?.password === 'string' ? req.body.password : '';
    const ok = timingSafeEqualStr(password, config.loginPassword);
    if (!ok) {
      await sleep(1000);
      res.status(401).json({ error: 'invalid password' });
      return;
    }
    const payload: SessionPayload = {
      userId: 'local',
      email: 'local@standalone',
      issuedAt: Date.now(),
    };
    setSessionCookie(res, payload, config.sessionSecret, req.protocol === 'https');
    res.status(200).json({ ok: true });
  });

  router.post('/logout', (_req: Request, res: Response) => {
    clearSessionCookie(res);
    res.status(200).json({ ok: true });
  });

  return router;
}

export function requireAuth(config: StandaloneConfig) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const cookies = parseCookie(req.header('Cookie') ?? '');
    const raw = cookies[COOKIE_NAME];
    const payload = raw ? verifySession(raw, config.sessionSecret) : null;
    if (!payload) {
      if (raw) clearSessionCookie(res);
      if (wantsHtml(req)) {
        res.redirect(302, '/login.html');
      } else {
        res.status(401).json({ error: 'authentication required' });
      }
      return;
    }

    // Sliding renewal: re-issue the cookie if the session is older than half-life.
    if (Date.now() - payload.issuedAt > HALF_AGE_MS) {
      setSessionCookie(
        res,
        { ...payload, issuedAt: Date.now() },
        config.sessionSecret,
        req.protocol === 'https',
      );
    }

    req.user = {
      userId: payload.userId,
      email: payload.email,
      role: 'admin',
      userType: 'tenant-admin',
      tenantId: 'standalone',
      permissions: ['opera:read', 'opera:write', 'sam:config:read'],
    };
    const company = req.header('X-Opera-Company');
    if (company) req.operaCompany = company;
    next();
  };
}
