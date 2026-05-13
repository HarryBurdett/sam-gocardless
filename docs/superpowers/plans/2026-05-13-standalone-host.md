# Standalone host implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `standalone/` Express server that boots the existing SAM-plugin core as a self-hostable web app while leaving `src/`, `frontend/`, `db/migrations/`, and `manifest.json` untouched so SAM can still consume the repo as a plugin.

**Architecture:** A new `standalone/` directory imports the compiled plugin factory from `dist/index.js`, builds an `AppContext` (file-backed SQLite for `db.app`, no-op Opera adapter, console logger), wraps it with cookie-session auth, and serves the existing UMD frontend through an HTML shell. The `standalone/` directory has a one-way dependency on `src/`; removing it leaves a working SAM plugin.

**Tech stack:** TypeScript (ESM), Express 4, Knex (SQLite via `sqlite3`), Vitest, `cookie` for cookie parsing/serialization, Node's built-in `crypto` for HMAC signing. Runtime: `tsx` (already a devDep).

**Spec:** [docs/superpowers/specs/2026-05-13-standalone-host-design.md](../specs/2026-05-13-standalone-host-design.md)

---

### Task 1: Bootstrap — deps, scripts, gitignore, dir skeleton

**Files:**
- Modify: `package.json` (add `start` script + `cookie` dep)
- Create: `.gitignore`
- Create: `standalone/__tests__/.gitkeep`
- Create: `standalone/public/.gitkeep`

- [ ] **Step 1: Install the `cookie` package**

```bash
npm install cookie@^1.0.0 --save --no-audit --no-fund
npm install @types/cookie@^0.6.0 --save-dev --no-audit --no-fund
```

Expected: `added N package(s)` (no errors).

- [ ] **Step 2: Add a `start` script to `package.json`**

In `package.json`, in the `scripts` block, between `dev` and `test`, add:

```json
    "start": "tsx standalone/server.ts",
```

Final `scripts` block looks like:

```json
  "scripts": {
    "build": "tsc -p tsconfig.json && cd frontend && npm install --no-audit --no-fund && npm run build",
    "dev": "tsx dev-host/server.ts",
    "start": "tsx standalone/server.ts",
    "test": "vitest run",
    "test:watch": "vitest",
    "lint": "tsc --noEmit",
    "clean": "rm -rf dist"
  },
```

- [ ] **Step 3: Create `.gitignore`**

Write `.gitignore` with these contents (no existing file in the repo root):

```gitignore
node_modules/
dist/
data/
*.log
.DS_Store
```

- [ ] **Step 4: Create dir skeleton**

```bash
mkdir -p standalone/__tests__ standalone/public
touch standalone/__tests__/.gitkeep standalone/public/.gitkeep
```

- [ ] **Step 5: Commit**

```bash
git add package.json package-lock.json .gitignore standalone/
git commit -m "scaffold standalone/ + add start script"
```

---

### Task 2: `standalone/opera-adapter.ts` — interface + no-op + test

**Files:**
- Create: `standalone/opera-adapter.ts`
- Create: `standalone/__tests__/opera-adapter.test.ts`

- [ ] **Step 1: Write the failing test**

Create `standalone/__tests__/opera-adapter.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { noOpAdapter, selectAdapter } from '../opera-adapter.js';

describe('opera-adapter', () => {
  describe('noOpAdapter', () => {
    it('returns null for any company code', () => {
      expect(noOpAdapter.getCompanyDb('ANY')).toBeNull();
      expect(noOpAdapter.getCompanyDb('')).toBeNull();
    });

    it('reports null operaType', () => {
      expect(noOpAdapter.operaType).toBeNull();
    });
  });

  describe('selectAdapter', () => {
    it('returns noOpAdapter for "noop"', () => {
      expect(selectAdapter('noop')).toBe(noOpAdapter);
    });

    it('throws for unknown names', () => {
      expect(() => selectAdapter('mssql')).toThrow(/Unknown OPERA_ADAPTER/);
    });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
npx vitest run standalone/__tests__/opera-adapter.test.ts
```

Expected: FAIL with `Cannot find module '../opera-adapter.js'`.

- [ ] **Step 3: Implement `standalone/opera-adapter.ts`**

```ts
/**
 * Opera DB adapter for the standalone host.
 *
 * Real adapters (MSSQL, FoxPro) drop in here. The no-op shipped today
 * lets the standalone server boot without an Opera connection — every
 * call returns null, and the plugin's existing handlers surface their
 * normal "Opera not connected" error.
 */
import type { Knex } from 'knex';

export type OperaType = 'opera-se' | 'opera-3' | null;

export interface OperaAdapter {
  getCompanyDb(code: string): Knex | null;
  operaType: OperaType;
}

export const noOpAdapter: OperaAdapter = {
  getCompanyDb: () => null,
  operaType: null,
};

export function selectAdapter(name: string): OperaAdapter {
  if (name === 'noop') return noOpAdapter;
  throw new Error(`Unknown OPERA_ADAPTER: ${name}`);
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
npx vitest run standalone/__tests__/opera-adapter.test.ts
```

Expected: 4 tests pass.

- [ ] **Step 5: Commit**

```bash
git add standalone/opera-adapter.ts standalone/__tests__/opera-adapter.test.ts
git commit -m "add OperaAdapter interface + no-op default"
```

---

### Task 3: `standalone/config.ts` — env-var loader + test

**Files:**
- Create: `standalone/config.ts`
- Create: `standalone/__tests__/config.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `standalone/__tests__/config.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../config.js';

const originalEnv = { ...process.env };
let tmpHome: string;

beforeEach(() => {
  process.env = { ...originalEnv };
  // Wipe vars under test
  delete process.env.PORT;
  delete process.env.DATABASE_PATH;
  delete process.env.LOGIN_PASSWORD;
  delete process.env.SESSION_SECRET;
  delete process.env.OPERA_ADAPTER;
  tmpHome = mkdtempSync(join(tmpdir(), 'sgc-config-'));
});

afterAll(() => {
  process.env = originalEnv;
});

describe('loadConfig', () => {
  it('throws when LOGIN_PASSWORD is unset', () => {
    expect(() => loadConfig({ dataDir: tmpHome })).toThrow(/LOGIN_PASSWORD/);
  });

  it('throws when LOGIN_PASSWORD is empty', () => {
    process.env.LOGIN_PASSWORD = '';
    expect(() => loadConfig({ dataDir: tmpHome })).toThrow(/LOGIN_PASSWORD/);
  });

  it('returns defaults when only LOGIN_PASSWORD is set', () => {
    process.env.LOGIN_PASSWORD = 'secret';
    const cfg = loadConfig({ dataDir: tmpHome });
    expect(cfg.port).toBe(3000);
    expect(cfg.databasePath).toBe(join(tmpHome, 'gocardless.sqlite'));
    expect(cfg.loginPassword).toBe('secret');
    expect(cfg.operaAdapter).toBe('noop');
    expect(cfg.sessionSecret).toMatch(/^[0-9a-f]{64}$/);
  });

  it('respects PORT and OPERA_ADAPTER overrides', () => {
    process.env.LOGIN_PASSWORD = 'secret';
    process.env.PORT = '4000';
    process.env.OPERA_ADAPTER = 'noop';
    const cfg = loadConfig({ dataDir: tmpHome });
    expect(cfg.port).toBe(4000);
    expect(cfg.operaAdapter).toBe('noop');
  });

  it('persists a generated SESSION_SECRET to disk', () => {
    process.env.LOGIN_PASSWORD = 'secret';
    const cfg1 = loadConfig({ dataDir: tmpHome });
    const secretFile = join(tmpHome, '.session-secret');
    expect(existsSync(secretFile)).toBe(true);
    expect(readFileSync(secretFile, 'utf8').trim()).toBe(cfg1.sessionSecret);

    // Loading again returns the same secret
    const cfg2 = loadConfig({ dataDir: tmpHome });
    expect(cfg2.sessionSecret).toBe(cfg1.sessionSecret);
  });

  it('uses SESSION_SECRET env var if provided', () => {
    process.env.LOGIN_PASSWORD = 'secret';
    process.env.SESSION_SECRET = 'explicit-secret';
    const cfg = loadConfig({ dataDir: tmpHome });
    expect(cfg.sessionSecret).toBe('explicit-secret');
  });

  it('cleans up tmp dirs', () => {
    rmSync(tmpHome, { recursive: true, force: true });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
npx vitest run standalone/__tests__/config.test.ts
```

Expected: FAIL with `Cannot find module '../config.js'`.

- [ ] **Step 3: Implement `standalone/config.ts`**

```ts
/**
 * Standalone host configuration loaded from env vars.
 *
 * loadConfig() is pure-ish: it reads env vars + optionally generates a
 * SESSION_SECRET to disk. The `opts.dataDir` parameter exists so tests
 * can point at a tmp dir without touching the repo's ./data.
 */
import { randomBytes } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';

export interface StandaloneConfig {
  port: number;
  databasePath: string;
  loginPassword: string;
  sessionSecret: string;
  operaAdapter: string;
  dataDir: string;
}

export interface LoadConfigOptions {
  /** Defaults to ./data relative to cwd. Tests override this. */
  dataDir?: string;
}

export function loadConfig(opts: LoadConfigOptions = {}): StandaloneConfig {
  const dataDir = opts.dataDir ?? resolve(process.cwd(), 'data');
  mkdirSync(dataDir, { recursive: true });

  const loginPassword = process.env.LOGIN_PASSWORD;
  if (!loginPassword || loginPassword.length === 0) {
    throw new Error(
      'LOGIN_PASSWORD env var is required. Set it to a strong shared password.',
    );
  }

  const port = process.env.PORT ? Number.parseInt(process.env.PORT, 10) : 3000;
  if (!Number.isFinite(port) || port <= 0 || port > 65535) {
    throw new Error(`Invalid PORT: ${process.env.PORT}`);
  }

  const databasePath = process.env.DATABASE_PATH
    ? resolve(process.env.DATABASE_PATH)
    : join(dataDir, 'gocardless.sqlite');
  mkdirSync(dirname(databasePath), { recursive: true });

  const sessionSecret = resolveSessionSecret(dataDir);
  const operaAdapter = process.env.OPERA_ADAPTER ?? 'noop';

  return {
    port,
    databasePath,
    loginPassword,
    sessionSecret,
    operaAdapter,
    dataDir,
  };
}

function resolveSessionSecret(dataDir: string): string {
  if (process.env.SESSION_SECRET && process.env.SESSION_SECRET.length > 0) {
    return process.env.SESSION_SECRET;
  }
  const secretFile = join(dataDir, '.session-secret');
  if (existsSync(secretFile)) {
    const value = readFileSync(secretFile, 'utf8').trim();
    if (value.length > 0) return value;
  }
  const generated = randomBytes(32).toString('hex');
  writeFileSync(secretFile, generated, { mode: 0o600 });
  return generated;
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
npx vitest run standalone/__tests__/config.test.ts
```

Expected: 7 tests pass.

- [ ] **Step 5: Commit**

```bash
git add standalone/config.ts standalone/__tests__/config.test.ts
git commit -m "add config loader with env-var validation + session secret"
```

---

### Task 4: `standalone/migrate.ts` — idempotent migration runner

**Files:**
- Create: `standalone/migrate.ts`
- Create: `standalone/__tests__/migrate.test.ts`

- [ ] **Step 1: Write the failing test**

Create `standalone/__tests__/migrate.test.ts`:

```ts
import { describe, it, expect, afterEach } from 'vitest';
import knex, { type Knex } from 'knex';
import { runMigrations } from '../migrate.js';

const created: Knex[] = [];

function newDb(): Knex {
  const db = knex({
    client: 'sqlite3',
    connection: { filename: ':memory:' },
    useNullAsDefault: true,
    pool: { min: 1, max: 1 },
  });
  created.push(db);
  return db;
}

afterEach(async () => {
  while (created.length) {
    const db = created.pop();
    if (db) await db.destroy();
  }
});

describe('runMigrations', () => {
  it('creates the settings table on first run', async () => {
    const db = newDb();
    await runMigrations(db);
    const exists = await db.schema.hasTable('settings');
    expect(exists).toBe(true);
  });

  it('creates the gocardless_mandates table on first run', async () => {
    const db = newDb();
    await runMigrations(db);
    const exists = await db.schema.hasTable('gocardless_mandates');
    expect(exists).toBe(true);
  });

  it('is idempotent — running twice does not error', async () => {
    const db = newDb();
    await runMigrations(db);
    await expect(runMigrations(db)).resolves.not.toThrow();
  });

  it('records applied migrations in _standalone_migrations', async () => {
    const db = newDb();
    await runMigrations(db);
    const rows = await db('_standalone_migrations').select('name');
    const names = rows.map((r: { name: string }) => r.name).sort();
    expect(names).toContain('001_initial_schema.ts');
    expect(names).toContain('007_align_subscriptions_schema.ts');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
npx vitest run standalone/__tests__/migrate.test.ts
```

Expected: FAIL with `Cannot find module '../migrate.js'`.

- [ ] **Step 3: Implement `standalone/migrate.ts`**

```ts
/**
 * Idempotent migration runner for the standalone host.
 *
 * Imports each .ts file in db/migrations/ in lexical order, calls
 * up(knex) if it hasn't been applied yet, and records the filename in
 * a _standalone_migrations table. Bypasses Knex's built-in tracker so
 * .ts migrations under ESM load cleanly via the tsx runtime.
 */
import type { Knex } from 'knex';
import { readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = resolve(__dirname, '..', 'db', 'migrations');
const TABLE = '_standalone_migrations';

export async function runMigrations(db: Knex): Promise<void> {
  await ensureTable(db);
  const files = (await readdir(MIGRATIONS_DIR))
    .filter((f) => f.endsWith('.ts'))
    .sort();
  for (const file of files) {
    const already = await db(TABLE).where({ name: file }).first();
    if (already) continue;
    const mod = (await import(resolve(MIGRATIONS_DIR, file))) as {
      up: (k: Knex) => Promise<void>;
    };
    await mod.up(db);
    await db(TABLE).insert({ name: file, applied_at: new Date().toISOString() });
  }
}

async function ensureTable(db: Knex): Promise<void> {
  const exists = await db.schema.hasTable(TABLE);
  if (exists) return;
  await db.schema.createTable(TABLE, (table) => {
    table.string('name', 200).primary();
    table.string('applied_at', 64).notNullable();
  });
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
npx vitest run standalone/__tests__/migrate.test.ts
```

Expected: 4 tests pass.

- [ ] **Step 5: Commit**

```bash
git add standalone/migrate.ts standalone/__tests__/migrate.test.ts
git commit -m "add idempotent migration runner"
```

---

### Task 5: `standalone/auth.ts` — login router + requireAuth middleware

**Files:**
- Create: `standalone/auth.ts`
- Create: `standalone/__tests__/auth.test.ts`

- [ ] **Step 1: Write the failing test**

Create `standalone/__tests__/auth.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import { loginRouter, requireAuth, signSession } from '../auth.js';

const CONFIG = {
  port: 0,
  databasePath: ':memory:',
  loginPassword: 'shibboleth',
  sessionSecret: 'test-secret-32-bytes-long-abcdef',
  operaAdapter: 'noop',
  dataDir: '/tmp',
};

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/auth', loginRouter(CONFIG));
  app.use(requireAuth(CONFIG));
  app.get('/protected', (req, res) => {
    res.json({ user: req.user });
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
  it('rejects wrong password with 401 after ~1s delay', async () => {
    const { server, url } = await listen(makeApp());
    const start = Date.now();
    const res = await fetch(`${url}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: 'wrong' }),
    });
    const elapsed = Date.now() - start;
    expect(res.status).toBe(401);
    expect(elapsed).toBeGreaterThanOrEqual(900);
    await close(server);
  }, 5000);

  it('accepts correct password and returns a Set-Cookie', async () => {
    const { server, url } = await listen(makeApp());
    const res = await fetch(`${url}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: 'shibboleth' }),
    });
    expect(res.status).toBe(200);
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

  it('requireAuth accepts a valid signed cookie', async () => {
    const { server, url } = await listen(makeApp());
    const cookie = signSession(
      { userId: 'local', email: 'local@standalone', issuedAt: Date.now() },
      CONFIG.sessionSecret,
    );
    const res = await fetch(`${url}/protected`, {
      headers: { Cookie: `sgc_session=${encodeURIComponent(cookie)}` },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.user.userId).toBe('local');
    expect(body.user.role).toBe('admin');
    await close(server);
  });

  it('requireAuth rejects a tampered cookie', async () => {
    const { server, url } = await listen(makeApp());
    const cookie = signSession(
      { userId: 'local', email: 'local@standalone', issuedAt: Date.now() },
      CONFIG.sessionSecret,
    );
    // Flip a character in the payload portion (before the .)
    const tampered = cookie.replace(/^./, 'X');
    const res = await fetch(`${url}/protected`, {
      headers: { Cookie: `sgc_session=${encodeURIComponent(tampered)}` },
    });
    expect(res.status).toBe(401);
    await close(server);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
npx vitest run standalone/__tests__/auth.test.ts
```

Expected: FAIL with `Cannot find module '../auth.js'`.

- [ ] **Step 3: Implement `standalone/auth.ts`**

```ts
/**
 * Standalone host auth: shared-password login + signed-cookie sessions.
 *
 * Exports:
 *   - loginRouter(config): POST /login, GET /logout.
 *   - requireAuth(config): middleware that gates everything after it.
 *   - signSession / verifySession: pure helpers (exported for tests).
 *
 * Cookie format: <base64(JSON payload)>.<hex(HMAC-SHA256 over payload)>
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
    if (Date.now() - payload.issuedAt > MAX_AGE_MS) return null;
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
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
npx vitest run standalone/__tests__/auth.test.ts
```

Expected: 6 tests pass.

- [ ] **Step 5: Commit**

```bash
git add standalone/auth.ts standalone/__tests__/auth.test.ts
git commit -m "add shared-password login + signed-cookie session middleware"
```

---

### Task 6: `standalone/server.ts` — wire everything together

**Files:**
- Create: `standalone/server.ts`
- Create: `standalone/__tests__/server.test.ts`

- [ ] **Step 1: Write the failing test**

Create `standalone/__tests__/server.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import { buildApp } from '../server.js';

const originalEnv = { ...process.env };
let tmpDir: string;
let server: Server;
let url: string;

beforeAll(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), 'sgc-server-'));
  process.env.LOGIN_PASSWORD = 'shibboleth';
  process.env.DATABASE_PATH = join(tmpDir, 'gocardless.sqlite');
  process.env.SESSION_SECRET = 'test-secret-please-change-32chars';
  const { app } = await buildApp({ dataDir: tmpDir });
  await new Promise<void>((resolve) => {
    server = app.listen(0, () => {
      const addr = server.address();
      if (!addr || typeof addr === 'string') throw new Error('no addr');
      url = `http://127.0.0.1:${addr.port}`;
      resolve();
    });
  });
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
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
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
npx vitest run standalone/__tests__/server.test.ts
```

Expected: FAIL with `Cannot find module '../server.js'`.

- [ ] **Step 3: Implement `standalone/server.ts`**

This step assumes `npm run build` has been run at least once so `dist/index.js` exists. Add a startup guard for that.

```ts
/**
 * Standalone host entry point.
 *
 * Boots the SAM plugin core (from dist/index.js) inside a self-hosted
 * Express server, with file-backed SQLite, no-op Opera adapter, and
 * cookie-session auth.
 */
import express, { type Express } from 'express';
import knex, { type Knex } from 'knex';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { loadConfig, type StandaloneConfig } from './config.js';
import { runMigrations } from './migrate.js';
import { loginRouter, requireAuth } from './auth.js';
import { selectAdapter } from './opera-adapter.js';
import type {
  AppContext,
  AppBackendFactory,
  AppLogger,
} from '../src/app-context.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..');
const DIST_ENTRY = resolve(repoRoot, 'dist', 'index.js');
const FRONTEND_DIST = resolve(repoRoot, 'frontend', 'dist');
const PUBLIC_DIR = resolve(__dirname, 'public');

const consoleLogger: AppLogger = {
  info: (msg, ...args) => console.log(`[info] ${msg}`, ...args),
  warn: (msg, ...args) => console.warn(`[warn] ${msg}`, ...args),
  error: (msg, ...args) => console.error(`[error] ${msg}`, ...args),
  debug: (msg, ...args) => console.log(`[debug] ${msg}`, ...args),
};

export interface BuildAppOptions {
  dataDir?: string;
}

export async function buildApp(
  opts: BuildAppOptions = {},
): Promise<{ app: Express; config: StandaloneConfig; appDb: Knex }> {
  if (!existsSync(DIST_ENTRY)) {
    throw new Error(
      `${DIST_ENTRY} not found — run \`npm run build\` first.`,
    );
  }

  const config = loadConfig({ dataDir: opts.dataDir });
  const adapter = selectAdapter(config.operaAdapter);

  const appDb = knex({
    client: 'sqlite3',
    connection: { filename: config.databasePath },
    useNullAsDefault: true,
    pool: { min: 1, max: 1 },
  });
  await runMigrations(appDb);

  // db.sam is required by AppContext but unused by this plugin. A small
  // in-memory pool keeps the type honest without writing anywhere.
  const samDb = knex({
    client: 'sqlite3',
    connection: { filename: ':memory:' },
    useNullAsDefault: true,
    pool: { min: 1, max: 1 },
  });

  const ctx: AppContext = {
    appId: 'gocardless',
    tenantId: 'standalone',
    config: { mailboxes: [] },
    operaType: adapter.operaType,
    db: {
      sam: samDb,
      app: appDb,
      operaSystem: null,
      getCompanyDb: (code) => adapter.getCompanyDb(code),
    },
    logger: consoleLogger,
  };

  const pluginMod = (await import(DIST_ENTRY)) as { default: AppBackendFactory };
  const pluginRouter = await pluginMod.default(ctx);

  const app = express();
  app.use(express.json({ limit: '10mb' }));

  // /login.html — explicit, before auth, so unauthenticated users can reach it.
  app.get('/login.html', (_req, res) => {
    res.sendFile(resolve(PUBLIC_DIR, 'login.html'));
  });

  // /auth/* — login + logout, no auth required.
  app.use('/auth', loginRouter(config));

  // Everything below requires auth.
  app.use(requireAuth(config));

  // Frontend static bundle.
  app.use(
    '/api/apps/gocardless/static',
    express.static(FRONTEND_DIST),
  );

  // Plugin API.
  app.use('/api/apps/gocardless', pluginRouter);

  // App shell + any other authenticated static assets.
  app.use(express.static(PUBLIC_DIR));

  // Catch-all error handler.
  app.use(
    (
      err: Error,
      _req: express.Request,
      res: express.Response,
      _next: express.NextFunction,
    ) => {
      consoleLogger.error('unhandled:', err);
      res.status(500).json({ error: err.message });
    },
  );

  return { app, config, appDb };
}

async function main(): Promise<void> {
  const { app, config } = await buildApp();
  app.listen(config.port, () => {
    console.log(`\n[standalone] listening on http://localhost:${config.port}`);
    console.log(`[standalone] database:    ${config.databasePath}`);
    console.log(`[standalone] adapter:     ${config.operaAdapter}`);
  });
}

// Run only when invoked as the entry point, not when imported by tests.
const invokedDirectly =
  process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  main().catch((err) => {
    console.error('[standalone] failed to start:', err);
    process.exit(1);
  });
}
```

- [ ] **Step 4: Run the test to verify it passes**

First ensure `dist/` is built:

```bash
npm run build
```

Then:

```bash
npx vitest run standalone/__tests__/server.test.ts
```

Expected: 4 tests pass. The 4th test (`serves the plugin API after login`) proves the full happy path: login → cookie → authenticated API call → real plugin response.

- [ ] **Step 5: Commit**

```bash
git add standalone/server.ts standalone/__tests__/server.test.ts
git commit -m "add standalone Express server wiring"
```

---

### Task 7: `standalone/public/login.html` + `standalone/public/index.html`

**Files:**
- Create: `standalone/public/login.html`
- Create: `standalone/public/index.html`
- Remove: `standalone/public/.gitkeep` (no longer needed)

- [ ] **Step 1: Write `standalone/public/login.html`**

```html
<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Login — GoCardless Import</title>
    <style>
      body {
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        background: #f3f4f6;
        display: grid;
        place-items: center;
        height: 100vh;
        margin: 0;
      }
      form {
        background: white;
        padding: 32px;
        border-radius: 8px;
        box-shadow: 0 4px 12px rgba(0, 0, 0, 0.08);
        width: 320px;
      }
      h1 { font-size: 18px; margin: 0 0 16px; }
      label { display: block; font-size: 13px; margin-bottom: 6px; }
      input[type=password] {
        width: 100%;
        padding: 8px 10px;
        border: 1px solid #d1d5db;
        border-radius: 4px;
        font-size: 14px;
        box-sizing: border-box;
      }
      button {
        width: 100%;
        margin-top: 16px;
        padding: 8px;
        background: #2563eb;
        color: white;
        border: none;
        border-radius: 4px;
        font-size: 14px;
        cursor: pointer;
      }
      button:disabled { background: #9ca3af; cursor: not-allowed; }
      .error { color: #b91c1c; font-size: 13px; margin-top: 12px; min-height: 1em; }
    </style>
  </head>
  <body>
    <form id="f">
      <h1>GoCardless Import — login</h1>
      <label for="p">Password</label>
      <input id="p" name="password" type="password" autocomplete="current-password" required autofocus />
      <button id="b" type="submit">Sign in</button>
      <div class="error" id="e"></div>
    </form>
    <script>
      const f = document.getElementById('f');
      const b = document.getElementById('b');
      const e = document.getElementById('e');
      f.addEventListener('submit', async (ev) => {
        ev.preventDefault();
        e.textContent = '';
        b.disabled = true;
        try {
          const res = await fetch('/auth/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ password: f.password.value }),
          });
          if (res.ok) {
            location.href = '/';
            return;
          }
          const body = await res.json().catch(() => ({}));
          e.textContent = body.error || `Login failed (${res.status})`;
        } catch (err) {
          e.textContent = err.message || 'Network error';
        } finally {
          b.disabled = false;
        }
      });
    </script>
  </body>
</html>
```

- [ ] **Step 2: Write `standalone/public/index.html`**

```html
<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>GoCardless Import</title>
    <link rel="stylesheet" href="/api/apps/gocardless/static/style.css" />
    <style>
      html, body, #app { height: 100%; margin: 0; }
      body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    </style>
  </head>
  <body>
    <div id="app"></div>

    <script crossorigin src="https://unpkg.com/react@18.3.1/umd/react.production.min.js"></script>
    <script crossorigin src="https://unpkg.com/react-dom@18.3.1/umd/react-dom.production.min.js"></script>
    <script>
      window.__SAM_SHARED__ = { react: window.React, reactDom: window.ReactDOM };
    </script>

    <script src="/api/apps/gocardless/static/index.js"></script>

    <script>
      (function () {
        const entry = window.__SAM_APPS__ && window.__SAM_APPS__['gocardless'];
        if (!entry) {
          document.getElementById('app').innerText =
            'Failed to load plugin bundle.';
          return;
        }
        const BASE = '/api/apps/gocardless';
        async function samFetch(path, options) {
          const url = path.startsWith('/') ? BASE + path : BASE + '/' + path;
          const res = await fetch(url, options || {});
          const text = await res.text();
          let parsed = null;
          if (text) {
            try { parsed = JSON.parse(text); } catch { parsed = text; }
          }
          if (res.status === 401) {
            location.href = '/login.html';
            throw new Error('not authenticated');
          }
          if (!res.ok) {
            const msg =
              (parsed && typeof parsed === 'object' && parsed.error) ||
              (typeof parsed === 'string' && parsed) ||
              ('HTTP ' + res.status);
            throw new Error(msg);
          }
          return parsed;
        }
        const context = {
          appId: 'gocardless',
          user: { userId: 'local', email: 'local@standalone', role: 'admin' },
          token: null,
          currentCompany: null,
          api: { baseUrl: BASE, fetch: samFetch },
          events: new EventTarget(),
        };
        const root = ReactDOM.createRoot(document.getElementById('app'));
        root.render(React.createElement(entry.component, { context: context }));
      })();
    </script>
  </body>
</html>
```

- [ ] **Step 3: Remove the placeholder**

```bash
rm standalone/public/.gitkeep
```

- [ ] **Step 4: Smoke-test manually**

```bash
LOGIN_PASSWORD=test123 npm run start
```

Expected console output:

```
[standalone] listening on http://localhost:3000
[standalone] database:    /Users/maccb/sam-gocardless/data/gocardless.sqlite
[standalone] adapter:     noop
```

Then in a browser:
1. Open `http://localhost:3000/` → redirected to `/login.html`
2. Enter wrong password → "invalid password" appears after ~1s
3. Enter `test123` → redirected to `/` → GoCardless wizard renders
4. Open the settings panel → loads existing settings JSON

Stop the server (Ctrl-C).

- [ ] **Step 5: Commit**

```bash
git add standalone/public/
git commit -m "add login + app shell HTML for standalone host"
```

---

### Task 8: README update + `data/.gitkeep`

**Files:**
- Modify: `README.md`
- Create: `data/.gitkeep`

- [ ] **Step 1: Add a "Standalone mode" section to `README.md`**

Append the following section to `README.md` after the existing "Frontend" section:

```markdown
## Standalone mode

To run the plugin without a SAM host:

```sh
npm install
npm run build                              # builds dist/ + frontend/dist/
LOGIN_PASSWORD=<choose-a-strong-one> npm run start
```

Then open `http://localhost:3000`, log in with the password you set, and use the GoCardless wizard. Data persists in `./data/gocardless.sqlite`.

Configurable env vars:

| Var | Default | Purpose |
| --- | --- | --- |
| `PORT` | `3000` | HTTP port |
| `DATABASE_PATH` | `./data/gocardless.sqlite` | SQLite file location |
| `LOGIN_PASSWORD` | _required_ | Shared password for the login form |
| `SESSION_SECRET` | auto-generated to `./data/.session-secret` | Cookie signing key |
| `OPERA_ADAPTER` | `noop` | Opera connection adapter (only `noop` is shipped) |

The standalone host is a sibling of, not a replacement for, the SAM plugin contract. `src/`, `frontend/`, `db/migrations/`, and `manifest.json` are unchanged — SAM continues to consume this repo as a plugin without any adapter shim.

⚠️ The standalone host has no TLS, no rate limiting, and no IP allowlist. Put a reverse proxy in front of it for anything beyond a private network.
```

- [ ] **Step 2: Create `data/.gitkeep`** (so the data dir exists on fresh clones)

```bash
mkdir -p data
touch data/.gitkeep
```

The `.gitignore` from Task 1 ignores everything in `data/` except tracked files, but `.gitkeep` is empty and will be tracked.

Verify:

```bash
git status data/
```

Expected: `data/.gitkeep` shown as a new file (the SQLite + session secret are ignored).

- [ ] **Step 3: Commit**

```bash
git add README.md data/.gitkeep
git commit -m "document standalone mode in README"
```

---

### Task 9: Full verification

- [ ] **Step 1: Run the entire test suite**

```bash
npm test
```

Expected: all existing tests pass + 21 new tests from `standalone/__tests__/`. Verify the new tests show up (`standalone/__tests__/opera-adapter.test.ts`, `config.test.ts`, `migrate.test.ts`, `auth.test.ts`, `server.test.ts`).

If any existing test fails, that means `src/` was inadvertently modified — investigate before proceeding.

- [ ] **Step 2: Run the lint check**

```bash
npm run lint
```

Expected: no errors. (`tsc --noEmit` checks `src/` only; `standalone/` types are checked separately via Vitest's TS support — any type error in `standalone/` would have already failed a test.)

- [ ] **Step 3: Verify the SAM-plugged contract is intact**

```bash
ls -la dist/index.js frontend/dist/index.js manifest.json
git status src/ frontend/src/ db/migrations/ manifest.json
```

Expected:
- All three artifact files exist.
- `git status` shows no changes in `src/`, `frontend/src/`, `db/migrations/`, or `manifest.json`.

- [ ] **Step 4: Final commit**

If anything is uncommitted at this point (only docs/plan files from earlier brainstorming should be):

```bash
git status
git add docs/superpowers/
git commit -m "add standalone-host spec + implementation plan"
```

---

## Notes for the implementer

- **Frequent commits.** Every task ends with a commit. Don't batch.
- **TDD discipline.** Run the failing test before writing implementation. Read the FAIL output before writing the code — it tells you what the test expects.
- **Don't touch `src/`.** If you find yourself wanting to edit anything in `src/`, `frontend/src/`, `db/migrations/`, or `manifest.json`, stop and reconsider. The whole point of this design is that SAM can re-plug the repo without an adapter. Touching those files breaks that.
- **Existing `dev-host/` stays.** It's the no-auth, in-memory iteration path. The new `standalone/` is the password-protected, persistent path. They coexist.
- **Run `npm run build` before Task 6's tests** — the server test imports `dist/index.js`, which doesn't exist until you've built.
