/**
 * Align `gocardless_mandates` and `gocardless_payment_requests` schema
 * with the canonical Python SQLite schema in
 * `sql_rag/gocardless_payments.py`.
 *
 * Migration 001 used a pared-down version of the table that didn't
 * carry every column the legacy app reads/writes. This migration adds
 * the missing columns so the matcher (`/api/gocardless/match-customers`)
 * and the import flow can run faithfully against the per-app DB.
 *
 * Renames:
 *   - gocardless_mandates.status            → mandate_status
 *   - gocardless_mandates.customer_name     → opera_name
 *
 * Adds:
 *   - gocardless_mandates.gocardless_name        (str 200)
 *   - gocardless_mandates.gocardless_customer_id (str 64)
 *   - gocardless_mandates.scheme                 (str 16, default 'bacs')
 *   - gocardless_mandates.email                  (str 200)
 *
 *   - gocardless_payment_requests.payout_id        (str 64)
 *   - gocardless_payment_requests.invoice_refs     (text — JSON array)
 *   - gocardless_payment_requests.opera_receipt_ref (str 64)
 *   - gocardless_payment_requests.error_message    (text)
 *   - gocardless_payment_requests.amount_pence     (int)  — alongside
 *     existing amount(decimal); the matcher and posting code read pence
 *     directly. We keep amount(decimal) for back-compat with payment-stats.
 *
 * Indexes:
 *   - gocardless_mandates: composite unique on (opera_account, mandate_id)
 *   - gocardless_mandates: index on gocardless_customer_id
 *   - gocardless_payment_requests: index on payout_id
 */
import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  // ---- gocardless_mandates ----
  await knex.schema.alterTable('gocardless_mandates', (table) => {
    table.renameColumn('status', 'mandate_status');
    table.renameColumn('customer_name', 'opera_name');
    table.string('gocardless_name', 200);
    table.string('gocardless_customer_id', 64);
    table.string('scheme', 16).defaultTo('bacs');
    table.string('email', 200);
    table.index('gocardless_customer_id');
  });

  // Composite unique constraint — separately, since alterTable in MSSQL
  // can be brittle when mixing renames with constraint changes.
  await knex.schema.alterTable('gocardless_mandates', (table) => {
    table.unique(['opera_account', 'mandate_id'], {
      indexName: 'uq_gocardless_mandates_opera_mandate',
    });
  });

  // ---- gocardless_payment_requests ----
  await knex.schema.alterTable('gocardless_payment_requests', (table) => {
    table.string('payout_id', 64);
    table.text('invoice_refs');
    table.string('opera_receipt_ref', 64);
    table.text('error_message');
    table.integer('amount_pence');
    table.index('payout_id');
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('gocardless_payment_requests', (table) => {
    table.dropIndex('payout_id');
    table.dropColumn('amount_pence');
    table.dropColumn('error_message');
    table.dropColumn('opera_receipt_ref');
    table.dropColumn('invoice_refs');
    table.dropColumn('payout_id');
  });

  await knex.schema.alterTable('gocardless_mandates', (table) => {
    table.dropUnique(['opera_account', 'mandate_id'],
      'uq_gocardless_mandates_opera_mandate');
  });

  await knex.schema.alterTable('gocardless_mandates', (table) => {
    table.dropIndex('gocardless_customer_id');
    table.dropColumn('email');
    table.dropColumn('scheme');
    table.dropColumn('gocardless_customer_id');
    table.dropColumn('gocardless_name');
    table.renameColumn('opera_name', 'customer_name');
    table.renameColumn('mandate_status', 'status');
  });
}
