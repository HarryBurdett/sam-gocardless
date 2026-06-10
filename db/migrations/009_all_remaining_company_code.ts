/**
 * Migration 009 — Phase B2+B3: add company_code to every remaining
 * per-company table in gocardless.
 *
 * Builds on migration 008 (settings). After this migration, every
 * per-company table in the gocardless plugin has a `company_code`
 * column. Service code can rely on companyScope() everywhere without
 * exception.
 *
 * Tables this migration touches:
 *   B2b — core registries (highest-severity, drives matching + writes):
 *     - gocardless_mandates
 *     - gocardless_imports
 *     - mandate_setup_requests
 *
 *   B3 — remaining operator-facing tables:
 *     - gocardless_payment_requests
 *     - gocardless_subscriptions
 *     - gocardless_subscription_documents
 *     - gocardless_partner_signups
 *
 * Existing rows are preserved with NULL company_code. The companyScope()
 * helper refuses to query NULL, so no normal request reads them. A
 * follow-up reassignment migration may stamp or clear them later.
 *
 * SAFETY NOTE for UNIQUE/PRIMARY KEY changes
 * ------------------------------------------
 *  - `gocardless_mandates.mandate_id` is GLOBALLY unique (assigned
 *    by GoCardless) — left as-is. Same for `payment_id`,
 *    `subscription_id`, `request_id`, `signup_id` — all externally
 *    generated, globally unique by GoCardless's design. We add
 *    company_code purely as a query-filter column, NOT for
 *    uniqueness.
 *  - `gocardless_subscription_documents` primary key
 *    (subscription_id, source_doc) likewise left alone — subscription_id
 *    is globally unique, so the existing PK is correct.
 *  - All changes are additive: new column + new indexes for filter
 *    performance. No existing constraints dropped.
 */
import type { Knex } from 'knex';

async function addCompanyCodeColumn(
  knex: Knex,
  table: string,
): Promise<void> {
  const has = await knex.schema.hasColumn(table, 'company_code');
  if (!has) {
    await knex.schema.alterTable(table, (t) => {
      t.string('company_code', 32);
    });
  }
}

export async function up(knex: Knex): Promise<void> {
  // ----------------------------------------------------------------
  // B2b — core registries
  // ----------------------------------------------------------------

  // gocardless_mandates — global UNIQUE on mandate_id stays.
  // Add column + composite index for the hot list-by-company path.
  // NOTE: column is `mandate_status` (renamed from `status` by
  // migration 003), not `status`.
  await addCompanyCodeColumn(knex, 'gocardless_mandates');
  await knex.schema.alterTable('gocardless_mandates', (t) => {
    t.index(['company_code', 'opera_account'], 'ix_mandates_company_account');
    t.index(['company_code', 'mandate_status'], 'ix_mandates_company_status');
  });

  // gocardless_imports — no UNIQUE; indexes already on payment_date,
  // bank_code, (target_system, payment_date). Add column + index.
  await addCompanyCodeColumn(knex, 'gocardless_imports');
  await knex.schema.alterTable('gocardless_imports', (t) => {
    t.index(['company_code', 'payment_date'], 'ix_imports_company_date');
  });

  // mandate_setup_requests — global UNIQUE on request_id stays.
  // Add column + index.
  await addCompanyCodeColumn(knex, 'mandate_setup_requests');
  await knex.schema.alterTable('mandate_setup_requests', (t) => {
    t.index(['company_code', 'status'], 'ix_msr_company_status');
  });

  // ----------------------------------------------------------------
  // B3 — remaining operator-facing tables
  // ----------------------------------------------------------------

  // gocardless_payment_requests — global UNIQUE on payment_id stays.
  await addCompanyCodeColumn(knex, 'gocardless_payment_requests');
  await knex.schema.alterTable('gocardless_payment_requests', (t) => {
    t.index(['company_code', 'status'], 'ix_pr_company_status');
    t.index(['company_code', 'opera_account'], 'ix_pr_company_account');
  });

  // gocardless_subscriptions — global UNIQUE on subscription_id stays.
  await addCompanyCodeColumn(knex, 'gocardless_subscriptions');
  await knex.schema.alterTable('gocardless_subscriptions', (t) => {
    t.index(['company_code', 'status'], 'ix_sub_company_status');
    t.index(['company_code', 'opera_account'], 'ix_sub_company_account');
  });

  // gocardless_subscription_documents — composite PK
  // (subscription_id, source_doc) stays. Add column + index.
  await addCompanyCodeColumn(knex, 'gocardless_subscription_documents');
  await knex.schema.alterTable('gocardless_subscription_documents', (t) => {
    t.index(['company_code', 'subscription_id'], 'ix_subdoc_company_sub');
  });

  // gocardless_partner_signups — no UNIQUE other than id. Add column.
  await addCompanyCodeColumn(knex, 'gocardless_partner_signups');
  await knex.schema.alterTable('gocardless_partner_signups', (t) => {
    t.index(['company_code', 'status'], 'ix_signups_company_status');
  });
}

export async function down(knex: Knex): Promise<void> {
  // Best-effort reverse — drops the new indexes, leaves company_code
  // columns in place (SQLite column drop requires table rebuild,
  // not worth the risk in down()).
  const dropMaybe = async (table: string, indexName: string) => {
    try {
      await knex.schema.alterTable(table, (t) => {
        t.dropIndex([], indexName);
      });
    } catch {
      /* index may not exist */
    }
  };

  await dropMaybe('gocardless_mandates', 'ix_mandates_company_account');
  await dropMaybe('gocardless_mandates', 'ix_mandates_company_status');
  await dropMaybe('gocardless_imports', 'ix_imports_company_date');
  await dropMaybe('mandate_setup_requests', 'ix_msr_company_status');
  await dropMaybe('gocardless_payment_requests', 'ix_pr_company_status');
  await dropMaybe('gocardless_payment_requests', 'ix_pr_company_account');
  await dropMaybe('gocardless_subscriptions', 'ix_sub_company_status');
  await dropMaybe('gocardless_subscriptions', 'ix_sub_company_account');
  await dropMaybe('gocardless_subscription_documents', 'ix_subdoc_company_sub');
  await dropMaybe('gocardless_partner_signups', 'ix_signups_company_status');
}
