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
