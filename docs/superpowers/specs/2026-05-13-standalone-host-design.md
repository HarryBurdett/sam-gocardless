# Standalone host for sam-gocardless

**Date:** 2026-05-13
**Status:** Draft — awaiting user approval

## Problem

`sam-gocardless` is a SAM plugin: `src/index.ts` exports a factory
`(ctx: AppContext) => Router` that SAM mounts under
`/api/apps/gocardless`, and the frontend is a UMD bundle that
registers on `window.__SAM_APPS__` and reads React from
`window.__SAM_SHARED__`. The repo cannot be run on its own without a
SAM host.

We want a self-hostable mode — a small team can `npm run start` and
get a working web app — while preserving SAM compatibility so the
same repo can be re-plugged into SAM later with zero adapter code.

## Goal

Add a `standalone/` directory that boots an Express server, builds an
`AppContext`, and mounts the existing plugin router and frontend
bundle. Do not modify `src/`, `frontend/`, `db/migrations/`,
`manifest.json`, or `dist/`. SAM continues to load this repo as a
plugin without any changes.

## Non-goals

- TLS / HTTPS (reverse-proxy responsibility).
- Multi-user accounts. One shared password is enough.
- A real Opera DB adapter implementation. The interface is defined,
  but only a no-op default ships.
- Dockerfile / packaging artifacts.
- Renaming or removing any SAM-shaped types in `src/`.

## Architecture

### Directory layout

```
sam-gocardless/
├── src/                          ← SAM plugin core (unchanged)
│   ├── index.ts                  ← factory(ctx) → Router
│   ├── router.ts
│   ├── app-context.ts
│   └── services/
├── frontend/                     ← UMD bundle (unchanged)
├── db/migrations/                ← Knex migrations (unchanged)
├── manifest.json                 ← SAM manifest (unchanged)
├── dist/                         ← tsc output, loaded by both hosts
│
├── standalone/                   ← NEW
│   ├── server.ts                 ← entry point
│   ├── config.ts                 ← env-var loading + validation
│   ├── migrate.ts                ← runs db/migrations on startup
│   ├── auth.ts                   ← login + cookie-session middleware
│   ├── opera-adapter.ts          ← OperaAdapter interface + NoOpAdapter
│   ├── __tests__/                ← vitest unit tests for standalone/
│   └── public/
│       ├── index.html            ← app shell
│       └── login.html            ← login form
└── data/                         ← runtime SQLite + session secret (gitignored)
```

### Dependency direction

```
standalone/  ──imports──▶  dist/index.js          (compiled from src/)
standalone/  ──imports──▶  db/migrations/*
SAM         ──imports──▶  dist/index.js          ← same entry point
```

`src/` never imports from `standalone/`. Removing the `standalone/`
directory and the data/docs directories leaves a working SAM plugin.

### Run modes

- **Standalone** (`npm run start`): single Node process, Express on
  `$PORT` (default 3000) serving the plugin API and the static
  frontend.
- **SAM-plugged**: SAM mounts `dist/index.js`'s router at
  `/api/apps/gocardless` and serves the frontend via its AppLoader.
  `standalone/` is never imported.

## Components

### `standalone/config.ts`

Reads and validates env vars at startup. Exits with code 1 on
validation failure.

| Env var | Default | Purpose |
|---|---|---|
| `PORT` | `3000` | HTTP port. |
| `DATABASE_PATH` | `./data/gocardless.sqlite` | SQLite file location. Parent dir created if missing. |
| `LOGIN_PASSWORD` | _required_ | Shared password. Server refuses to start if unset or empty. |
| `SESSION_SECRET` | _(auto-generated to `./data/.session-secret` on first run)_ | Cookie signing key. Auto-generated value is 32 random bytes, hex-encoded. |
| `OPERA_ADAPTER` | `noop` | Adapter selector. Only `noop` is supported in this design. |

### `standalone/migrate.ts`

Opens a Knex SQLite pool, then for each `.ts` file in `db/migrations/`
in lexical order:
1. Look up the file's basename in a `_standalone_migrations` table
   (created if absent — schema: `name TEXT PRIMARY KEY, applied_at
   TIMESTAMP`).
2. If already applied, skip.
3. Otherwise `import()` the file and call `up(knex)`, then record it.

Knex's built-in migration tracker is bypassed because TS migrations
under ESM trip its loader. The custom tracker is idempotent and runs
every startup.

### `standalone/opera-adapter.ts`

```ts
import type { Knex } from 'knex';

export interface OperaAdapter {
  getCompanyDb(code: string): Knex | null;
  operaType: 'opera-se' | 'opera-3' | null;
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

Future real adapters land in this file and `selectAdapter` switches
on the env-var value. No changes propagate into `src/`.

### `standalone/auth.ts`

Two exports:

- `loginRouter(config)` — Express router with `POST /auth/login`.
  Accepts `{ password: string }`. Compares to `config.loginPassword`
  via `crypto.timingSafeEqual`. On mismatch, `await sleep(1000)` then
  `401 { error: 'invalid password' }`. On match, sets a signed
  `sgc_session` cookie carrying
  `{ userId: 'local', email: 'local@standalone', issuedAt: <ms> }`,
  returns `200 { ok: true }`.
- `requireAuth(config)` — middleware. Reads `sgc_session`, verifies
  HMAC, populates `req.user` matching SAM's shape:
  ```ts
  {
    userId: 'local',
    email: 'local@standalone',
    role: 'admin',
    userType: 'tenant-admin',
    tenantId: 'standalone',
    permissions: ['opera:read', 'opera:write', 'sam:config:read'],
  }
  ```
  Also reads `X-Opera-Company` and populates `req.operaCompany`.
  Sliding session: re-issues the cookie if `issuedAt` is older than
  half the 30-day expiry. On missing/invalid cookie:
  - browser requests (Accept: `text/html`): `302 /login.html`
  - API requests: `401 { error: 'authentication required' }`

Cookie attributes: `HttpOnly`, `SameSite=Lax`, `Secure` only if
`req.protocol === 'https'`. Signature uses HMAC-SHA256 over the JSON
payload with `SESSION_SECRET` as the key.

### `standalone/server.ts`

Entry point. Sequence:

1. `loadConfig()` — exit on failure.
2. Open the SQLite Knex pool at `DATABASE_PATH`.
3. `runMigrations(knex)` — idempotent.
4. Build `AppContext`:
   ```ts
   {
     appId: 'gocardless',
     tenantId: 'standalone',
     config: { mailboxes: [] },
     operaType: adapter.operaType,
     db: {
       sam: emptyInMemoryKnex,
       app: knex,
       operaSystem: null,
       getCompanyDb: adapter.getCompanyDb,
     },
     logger: consoleLogger,
   }
   ```
5. `import('../dist/index.js')` → call `default(ctx)` → `pluginRouter`.
6. Wire the Express app in this exact order:
   1. `express.json({ limit: '10mb' })`
   2. `GET /login.html` — explicit handler, before auth.
   3. `loginRouter(config)` mounted at `/auth` (no auth).
   4. `requireAuth(config)` — everything below this line is
      authenticated.
   5. `express.static('frontend/dist')` mounted at
      `/api/apps/gocardless/static`.
   6. `pluginRouter` mounted at `/api/apps/gocardless`.
   7. `express.static('standalone/public')` — serves `/index.html`
      and any other public assets to authenticated users.
   8. Error middleware: log, return `{ error: <message> }` 500. No
      stack to client.
7. `app.listen(PORT)`.

### `standalone/public/index.html`

Same shell pattern as the existing dev-host:
- Loads React 18 and ReactDOM 18 from unpkg.
- Sets `window.__SAM_SHARED__ = { react, reactDom }`.
- Loads `/api/apps/gocardless/static/style.css` and `/index.js`.
- Builds a `SamPluginContext` where `api.fetch(path, options)`
  prepends `/api/apps/gocardless`, sends the cookie automatically
  (same-origin), parses JSON, throws on non-2xx.
- Calls `ReactDOM.createRoot(...).render(component({ context }))`.

No dev banner. The amber warning that's in the current dev-host
shell is removed.

### `standalone/public/login.html`

Single-form page. JS handler:
```js
const res = await fetch('/auth/login', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ password: form.password.value }),
});
if (res.ok) location.href = '/';
else show error from JSON
```

## Data flow

### Browser load

```
GET /
  → requireAuth → no/invalid cookie → 302 /login.html
  → requireAuth → valid cookie → static index.html
    → loads React from CDN, sets __SAM_SHARED__
    → loads /api/apps/gocardless/static/index.js (UMD)
    → window.__SAM_APPS__.gocardless.component({ context })
    → component calls api.fetch('/api/gocardless/settings')
      → GET /api/apps/gocardless/api/gocardless/settings
        → requireAuth → plugin router → ctx.db.app.settings → JSON
```

### Login

```
GET /login.html → static file (no auth)
POST /auth/login { password }
  → constant-time compare
  → match: Set-Cookie sgc_session=<signed JSON>; HttpOnly; SameSite=Lax → 200 { ok: true }
  → mismatch: sleep(1s) → 401 { error: 'invalid password' }
```

### Opera-dependent endpoint

```
Handler in src/router.ts: const db = ctx.db.getCompanyDb(company);
  → returns null (NoOpAdapter)
  → existing handler returns its current error shape
  → UI surfaces error
```

No code changes in `src/`. We rely on the plugin's existing
null-handling, which was designed for SAM tenants without an
active Opera connection.

## Error handling

| Scenario | Behavior |
|---|---|
| `LOGIN_PASSWORD` unset | exit 1: "LOGIN_PASSWORD env var is required" |
| `DATABASE_PATH` parent not writable | exit 1: "Cannot write to <path> — check permissions" |
| `dist/index.js` missing | exit 1: "dist/index.js not found — run `npm run build` first" |
| Migration throws | log migration filename + SQL error, exit 1 |
| Plugin handler throws | error middleware: log full error, respond `500 { error: <message> }` |
| `getCompanyDb` returns null | existing plugin error path (unchanged) |
| Cookie tampered / bad signature | clear cookie, treat as unauthenticated (302 or 401) |
| Failed login | 1-second sleep then 401. No lockout. |
| Internet-exposed deployment | README warns: use a reverse proxy for TLS + rate limiting |

## Testing

| Concern | Test | Location |
|---|---|---|
| SAM contract intact | All existing vitest tests pass | `tests/` — `npm test` |
| Config validation | Missing `LOGIN_PASSWORD` throws with clear message | `standalone/__tests__/config.test.ts` |
| Migration runner | Running twice produces same schema, no duplicate-table error | `standalone/__tests__/migrate.test.ts` |
| Auth: correct password | 200 + valid signed cookie | `standalone/__tests__/auth.test.ts` |
| Auth: wrong password | 401 + ~1s elapsed | `standalone/__tests__/auth.test.ts` |
| Auth: cookie tamper | Modified signature rejected, redirects | `standalone/__tests__/auth.test.ts` |
| OperaAdapter | `noOpAdapter.getCompanyDb('ANY')` returns null | `standalone/__tests__/opera-adapter.test.ts` |
| End-to-end smoke | Manual: start server, login, hit `/api/apps/gocardless/api/gocardless/settings`, see settings JSON | README documents the command |

Vitest config already exists at the repo root; the standalone tests
will be picked up automatically by `npm test`.

## Migration / rollback

This change is additive. Removing `standalone/`, `data/`, and the
`start` + `dev` scripts from `package.json` restores the
SAM-only state. No data migration is needed; the SQLite file is
not used by SAM.

## Open questions

None at this point — the design has been confirmed section by
section. Remaining decisions are implementation-level (file naming,
exact env var defaults if a user objects) and can be handled in the
plan.
