# gocardless (SAM plugin)

GoCardless Direct Debit payout import for Pegasus Opera.
TypeScript port of `apps/gocardless/` — scans the customer's
mailbox for payout notification emails, matches each payment to
an Opera customer, and posts the batch as sales receipts.

See [marketing/manuals/manual-gocardless.md](../../marketing/manuals/manual-gocardless.md)
for the user-facing walkthrough.

## What SAM provides

| ctx field | Required? | Purpose |
| --- | --- | --- |
| `db.app` | yes | Per-app DB for settings, mandates, payment requests, import history |
| `db.getCompanyDb(code)` | yes | Knex pool for the Opera company (sname, stran, ntran writes) |
| `operaType` | yes | `'opera-se'` or `'opera-3'` |
| `logger` | yes | Standard logger interface |
| `llm` | optional | Used by `/api/gocardless/parse` and `/api/gocardless/ocr` for receipt OCR |
| `emailIngest` | yes (in prod) | Required for the `/scan-emails` flow; falls back to default mailbox adapter when wired |
| `email` | optional | Statement email send-out |

The GoCardless API key, environment (`live` vs `sandbox`), and
default cashbook type live in the per-app `settings` table — UI
configures them via `/api/gocardless/settings`.

## Built-in defaults

| Default | Override key on ctx | Activates when |
| --- | --- | --- |
| [defaultEmailIngestAdapter](src/services/default-email-ingest.ts) — wraps `ctx.emailIngest` for `EmailMailboxAdapter` (search-filtered list with body-text extraction) | `gocardlessMailboxAdapter` | `ctx.emailIngest` available, `config.mailboxes` non-empty |
| [in-memory import lock](src/services/import-lock.ts) | `gocardlessImportLock` | always |
| [batch posting executor](src/services/batch-posting-executor.ts) | `gocardlessBatchExecutor` | always |

## Required `ctx.config` keys

| Key | Type | Purpose |
| --- | --- | --- |
| `mailboxes` | string[] | Mailbox addresses to claim. Required if you want the built-in email-ingest default. |

## Environment

⚠️ **GoCardless is a financial system. Do NOT make live API
requests during development.** Use `environment: 'sandbox'` in
settings or mock the API at the adapter layer.

## Routes

~75 endpoints — every Python `/api/gocardless/*` URL has a 1:1 SAM
equivalent at the same path; the `/api/opera3/...` mirror is served
by the same path-rewrite middleware as bank-reconcile.

## Database

`db/migrations/` holds 7 Knex migrations. `tests/migrations.test.ts`
runs each one against in-memory SQLite to catch dialect-agnostic
bugs.

## Tests

```sh
npm test               # vitest run — 503 tests
npm run lint           # tsc --noEmit
```

## Frontend

`frontend/src/GoCardlessImport.tsx` (2,500 LOC) is the legacy
import wizard ported faithfully. `frontend/src/GoCardless.tsx`
mounts it inside a `QueryClientProvider`.

```sh
cd frontend
npm install
npm run build
```

Tailwind utilities are scoped to `.gocardless-app` to keep them
out of the host CSS.

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
| `TRUST_PROXY` | `loopback, linklocal, uniquelocal` | Passed verbatim to Express's `app.set('trust proxy', …)` |

### Without an Opera connection

The shipped `noop` Opera adapter makes every `ctx.db.getCompanyDb()` call return `null`. The settings page, mandate registry, payment requests, partner signup flows, and import history all work normally — they only touch the standalone SQLite. **Customer matching, eligible-customer lookups, batch posting to Opera, and any wizard step that needs Opera customer data will surface "No Opera company in context" or similar errors.** That's expected with `OPERA_ADAPTER=noop`; a real adapter is the next building block.

### Behind a reverse proxy

If the standalone server sits behind a TLS-terminating reverse proxy on a public IP (Caddy, Nginx, Cloudflare with a public backend), the default `TRUST_PROXY` value (`loopback, linklocal, uniquelocal`) will not match the proxy's source address, so `req.protocol` stays `http` and session cookies will not carry the `Secure` flag. Set `TRUST_PROXY` to a value that Express recognises (e.g. `1` to trust the first hop, or a CIDR like `10.0.0.0/8`) when deploying behind a non-private proxy. See [the Express docs on `trust proxy`](https://expressjs.com/en/guide/behind-proxies.html).

The standalone host is a sibling of, not a replacement for, the SAM plugin contract. `src/`, `frontend/`, `db/migrations/`, and `manifest.json` are unchanged — SAM continues to consume this repo as a plugin without any adapter shim.

⚠️ The standalone host has no TLS, no rate limiting, and no IP allowlist. Put a reverse proxy in front of it for anything beyond a private network.
