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

The repo ships with a self-hosted Express server (`standalone/`) that runs the plugin without SAM. It supports **multiple companies** — each a top-level subdirectory under `DATA_ROOT` with its own SQLite, its own GoCardless settings, and (optionally) its own Opera database mapping. The company is picked at login.

### Quick start (no Opera, settings-only)

```sh
npm install
npm run build                              # builds dist/ + frontend/dist/
mkdir -p data/main                          # one or more company dirs
LOGIN_PASSWORD=<choose-a-strong-one> npm run start
```

Open `http://localhost:3000`, pick a company from the dropdown, log in. With `OPERA_ADAPTER=noop` (default), the wizard can manage GoCardless settings, mandates, payment requests, etc. — but anything that needs to talk to Opera (customer matching, batch posting, eligible-customer lookup) will surface a clear error.

### With an Opera connection (opera-se / MSSQL)

```sh
LOGIN_PASSWORD=<password> \
OPERA_ADAPTER=mssql \
OPERA_SQL_HOST=<sql-server-ip-or-hostname> \
OPERA_SQL_USER=<user> \
OPERA_SQL_PASSWORD=<password> \
OPERA_SQL_TRUST_CERT=true \
OPERA_SQL_ENCRYPT=false \
npm run start
```

Each company needs an `opera.json` at `<DATA_ROOT>/<code>/opera.json`:

```json
{ "database": "Opera3SECompany00I", "operaVersion": "SE" }
```

The plugin's `getCompanyDb(code)` then returns a Knex pool against that database. Customer matching, payouts, and batch posting all work against the real Opera SE schema.

### Migrating from the legacy Python `apps/gocardless/`

Set `LEGACY_DATA_ROOT` to the legacy `data/` directory. On first boot of each company, the standalone host:

1. Auto-discovers companies from `LEGACY_DATA_ROOT/<code>/gocardless/` and creates a stub `<DATA_ROOT>/<code>/` for each.
2. Seeds the new `settings` table from `<LEGACY_DATA_ROOT>/<code>/gocardless/gocardless_settings.json`.
3. Seeds `<DATA_ROOT>/<code>/opera.json` from `<LEGACY_DATA_ROOT>/../companies/<code>.json` (or `LEGACY_COMPANIES_DIR` if set).
4. Migrates rows from `<LEGACY_DATA_ROOT>/<code>/gocardless/gocardless_payments.db` (mandates, partner signups, payment requests, subscriptions, mandate setup requests). Duplicate-key rows in the legacy data are skipped with a per-table summary.

All of this is idempotent — re-runs are no-ops once the destination has data.

### All env vars

| Var | Default | Purpose |
| --- | --- | --- |
| `PORT` | `3000` | HTTP port |
| `DATA_ROOT` | `./data` | Parent dir for per-company SQLite files |
| `LEGACY_DATA_ROOT` | _unset_ | Legacy `data/<company>/gocardless/` directory; enables auto-discovery + migration |
| `LEGACY_COMPANIES_DIR` | `<LEGACY_DATA_ROOT>/../companies` | Source of legacy `<code>.json` files for seeding `opera.json` |
| `LOGIN_PASSWORD` | _required_ | Shared password for the login form |
| `SESSION_SECRET` | auto-generated to `<DATA_ROOT>/.session-secret` | Cookie signing key |
| `OPERA_ADAPTER` | `noop` | `noop`, `mssql`, `opera3`, or `composite` |
| `OPERA_SQL_HOST` | _required when `mssql`/`composite`_ | Opera SQL server host |
| `OPERA_SQL_PORT` | `1433` | Opera SQL server port |
| `OPERA_SQL_USER` | _required when `mssql`/`composite`_ | SQL Server username |
| `OPERA_SQL_PASSWORD` | _required when `mssql`/`composite`_ | SQL Server password |
| `OPERA_SQL_TRUST_CERT` | `true` | Trust the server's TLS cert (Opera SE typically uses a self-signed cert) |
| `OPERA_SQL_ENCRYPT` | `true` | TLS-encrypt the connection. Set `false` for IP-only Opera servers (tedious rejects IP as TLS ServerName) |
| `OPERA3_AGENT_URL` | _unset_ | Reserved — URL of the future opera-3 read/write agent (HTTP service that wraps VFP/FoxPro DBF access). The bundled opera-3 adapter is a scaffold; agent integration is pending. |
| `OPERA3_AGENT_KEY` | _unset_ | Reserved — shared secret for the opera-3 agent service. |
| `OPERA3_DATA_PATH` | _unset_ | Reserved — local mount of the Opera 3 SMB share, if the future agent reads files directly. |
| `TRUST_PROXY` | `loopback, linklocal, uniquelocal` | Passed verbatim to Express's `app.set('trust proxy', …)` |

### Adapter modes

| Mode | What it does | Use it when |
|---|---|---|
| `noop` | Returns null for every `getCompanyDb()` call. Plugin's Opera-backed endpoints surface "Opera not connected" errors; everything that's `db.app`-only (settings, mandates registry, payment requests) still works. | You're configuring settings or porting data, no live Opera connection needed. |
| `mssql` | Per-company Knex pool against Opera SQL Server. Companies whose `opera.json` has `operaVersion: "3"` are skipped. | Everything you have is on Opera SE. |
| `opera3` | Scaffold for Opera 3 (VFP/FoxPro) access via an external agent service. Not yet implemented — returns null with a warn log. | Reserved for future opera-3 integration. |
| `composite` | Routes per-company: SE → MSSQL pool, 3 → opera-3 agent. | Mixed deployment where some companies are Opera SE and others are Opera 3. |

Per-company `operaVersion` is set via the **Settings → System connection** panel ("Edit Opera mapping") or by directly editing `<DATA_ROOT>/<company>/opera.json`. The change takes effect immediately — no restart required.

### Behind a reverse proxy

If the standalone server sits behind a TLS-terminating reverse proxy on a public IP (Caddy, Nginx, Cloudflare with a public backend), the default `TRUST_PROXY` value will not match the proxy's source address, so `req.protocol` stays `http` and session cookies will not carry the `Secure` flag. Set `TRUST_PROXY` to a value that Express recognises (e.g. `1` to trust the first hop, or a CIDR like `10.0.0.0/8`). See [the Express docs on `trust proxy`](https://expressjs.com/en/guide/behind-proxies.html).

### Relationship to SAM

`src/`, `frontend/`, `db/migrations/`, and `manifest.json` are unchanged from upstream — SAM continues to consume this repo as a plugin without any adapter shim. The `standalone/` directory is sibling-only and never imported by `dist/index.js`. When merged into SAM, the standalone host becomes inert (SAM provides its own per-tenant `AppContext`); the Opera adapter you configure here continues to work because the adapter interface is the same shape SAM expects.

⚠️ The standalone host has no TLS, no rate limiting, and no IP allowlist. Put a reverse proxy in front of it for anything beyond a private network.
