/**
 * Align gocardless_imports schema with the canonical Python schema in
 * api/email/storage.py:1146-1202.
 *
 * Migration 002 created a pared-down version. Adding the missing
 * columns brings the per-app DB to parity with the legacy schema so
 * historic data can be migrated row-for-row, AND so the archive-email
 * + import flows can write the same fields the Python code does.
 */
import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('gocardless_imports', (table) => {
    table.integer('email_id'); // for email-based imports
    table.string('payout_id', 64); // for API-based imports
    table.string('source', 16).defaultTo('email'); // 'email' | 'api' | 'archived'
    table.integer('payment_count');
    table.string('batch_ref', 64); // Opera batch reference (ae_entref)
    table.decimal('fx_amount', 12, 2); // GBP equivalent for foreign-currency payouts
    table.date('post_date'); // posting date
    table.index('email_id');
    table.index('payout_id');
    table.index('source');
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('gocardless_imports', (table) => {
    table.dropIndex('source');
    table.dropIndex('payout_id');
    table.dropIndex('email_id');
    table.dropColumn('post_date');
    table.dropColumn('fx_amount');
    table.dropColumn('batch_ref');
    table.dropColumn('payment_count');
    table.dropColumn('source');
    table.dropColumn('payout_id');
    table.dropColumn('email_id');
  });
}
