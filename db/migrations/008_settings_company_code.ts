/**
 * Migration 008 — make the `settings` table multi-company.
 *
 * BACKGROUND
 * ----------
 * Per Jonathan's SAM hand-off doc (gocardless-multi-company-handoff.md,
 * 2026-06-09), SAM provisions ONE database per (connection, app) pair.
 * Multiple Opera companies (identified by single-letter `company_code`
 * such as 'C', 'I', 'Z') live inside that single database and must be
 * discriminated by a `company_code` column on every per-company table.
 *
 * The original migration 001 created `settings` as a single-row
 * key/value store with `key` globally UNIQUE. That means every company
 * sharing a SAM-provisioned DB collides on the one
 * `key='gocardless_settings'` row — last write wins, every company
 * reads whichever company saved last. This is the cross-company
 * settings leak observed in production on 2026-06-09.
 *
 * THIS MIGRATION
 * --------------
 * 1. Adds a nullable `company_code` column (string, 32).
 * 2. Drops the existing UNIQUE constraint on `key` alone.
 * 3. Adds a composite UNIQUE on (key, company_code) — so every company
 *    can own a `gocardless_settings` row without colliding.
 *
 * Pre-existing rows are preserved with NULL `company_code` for
 * audit/recovery. The refactored `loadSettings(db, companyCode)` in
 * src/services/settings.ts filters by both key AND a non-empty
 * company_code, so the NULL-stamped legacy row will never be returned
 * to a normal request — but it's still on disk for a follow-up
 * migration (015 in Jonathan's plan) that prompts per-row reassignment.
 *
 * This pattern mirrors bank-reconcile migration 014 (the
 * `bank_import_patterns` table) and matches how every other multi-
 * company SAM app discriminates rows.
 */
import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  // 1. Add the company_code column (only if missing — re-running this
  //    migration on a manually-patched DB is safe).
  const hasColumn = await knex.schema.hasColumn('settings', 'company_code');
  if (!hasColumn) {
    await knex.schema.alterTable('settings', (t) => {
      t.string('company_code', 32);
    });
  }

  // 2. Drop the existing UNIQUE constraint on `key`. Knex auto-names
  //    this `settings_key_unique` on SQLite when the original migration
  //    used `t.string('key').unique()`. Best-effort with a try/catch
  //    so a partially-applied state can still upgrade.
  try {
    await knex.schema.alterTable('settings', (t) => {
      t.dropUnique(['key']);
    });
  } catch {
    // Index may have already been dropped on a partial re-apply, or the
    // table may have been rebuilt out-of-band. Either way we proceed —
    // the composite below is what actually enforces correctness.
  }

  // 3. Add the composite UNIQUE on (key, company_code).
  //    SQLite treats NULLs as distinct, so multiple NULL company_code
  //    rows are technically allowed by the index — but the runtime
  //    code refuses to query for NULL, so this is fine as a transition
  //    state. The follow-up 015_backfill_company_code migration will
  //    clear or stamp the NULL rows.
  await knex.schema.alterTable('settings', (t) => {
    t.unique(['key', 'company_code'], {
      indexName: 'ux_settings_key_company',
    });
  });
}

export async function down(knex: Knex): Promise<void> {
  // Best-effort reverse. The composite is droppable by name; restoring
  // the original single-column UNIQUE may fail if duplicate `key`
  // values now exist (which is the whole point of this migration).
  // We attempt it for development convenience but don't fail the
  // overall downgrade if it errors.
  try {
    await knex.schema.alterTable('settings', (t) => {
      t.dropUnique(['key', 'company_code'], 'ux_settings_key_company');
    });
  } catch {
    /* composite index may not exist on a partially-downgraded DB */
  }

  try {
    await knex.schema.alterTable('settings', (t) => {
      t.unique(['key']);
    });
  } catch {
    /* duplicate `key` rows make the old UNIQUE impossible — accept
       that downgrade leaves the table without the original constraint */
  }

  // Leave the company_code column in place to avoid losing data if a
  // re-upgrade follows. A column drop on SQLite requires a table
  // rebuild and isn't worth the risk in a `down` path.
}
