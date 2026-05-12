/**
 * Align `gocardless_subscriptions` and `gocardless_subscription_documents`
 * schemas with the canonical Python SQLite schema in
 * `sql_rag/gocardless_payments.py:161-218`.
 *
 * Migration 001 used a pared-down version of these tables. This
 * migration drops + recreates them so the subscription detail /
 * lifecycle / link / unlink endpoints can read and write the same
 * fields the legacy Python code does:
 *
 *   - subscriptions: adds opera_name, source_doc, amount_pence,
 *     currency, interval_unit, interval_count, day_of_month, name,
 *     start_date, end_date, synced_at. Drops the placeholder
 *     `amount` (pounds) and `frequency` (single char) columns since
 *     the rest of the system reads pence + interval pair.
 *
 *   - subscription_documents: simplifies to (subscription_id,
 *     source_doc, added_at) — matches Python's junction-table shape
 *     used by add_subscription_document /
 *     remove_subscription_document /
 *     get_subscriptions_by_source_doc.
 *
 * Recreate (vs alter) is safe because nothing in production
 * references the old schema yet (greenfield).
 */
import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('gocardless_subscription_documents');
  await knex.schema.dropTableIfExists('gocardless_subscriptions');

  await knex.schema.createTable('gocardless_subscriptions', (table) => {
    table.increments('id').primary();
    table.string('subscription_id', 64).notNullable().unique();
    table.string('mandate_id', 64).notNullable();
    table.string('opera_account', 32);
    table.string('opera_name', 200);
    table.string('source_doc', 64);
    table.integer('amount_pence').notNullable();
    table.string('currency', 3).defaultTo('GBP');
    table.string('interval_unit', 16).notNullable();
    table.integer('interval_count').defaultTo(1);
    table.integer('day_of_month');
    table.string('name', 200);
    table.string('status', 32).defaultTo('active');
    table.string('start_date', 16);
    table.string('end_date', 16);
    table.timestamp('created_at').defaultTo(knex.fn.now());
    table.timestamp('updated_at').defaultTo(knex.fn.now());
    table.timestamp('synced_at');
    table.index('mandate_id');
    table.index('opera_account');
    table.index('source_doc');
  });

  await knex.schema.createTable('gocardless_subscription_documents', (table) => {
    table.string('subscription_id', 64).notNullable();
    table.string('source_doc', 64).notNullable();
    table.timestamp('added_at').defaultTo(knex.fn.now());
    table.primary(['subscription_id', 'source_doc']);
    table.index('subscription_id');
    table.index('source_doc');
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('gocardless_subscription_documents');
  await knex.schema.dropTableIfExists('gocardless_subscriptions');

  await knex.schema.createTable('gocardless_subscriptions', (table) => {
    table.increments('id').primary();
    table.string('subscription_id', 64).notNullable().unique();
    table.string('mandate_id', 64);
    table.string('opera_account', 32);
    table.decimal('amount', 12, 2);
    table.string('frequency', 16);
    table.string('status', 32);
    table.timestamp('created_at').defaultTo(knex.fn.now());
    table.timestamp('updated_at').defaultTo(knex.fn.now());
    table.index('mandate_id');
    table.index('opera_account');
  });

  await knex.schema.createTable('gocardless_subscription_documents', (table) => {
    table.increments('id').primary();
    table.string('opera_account', 32).notNullable();
    table.string('document_ref', 64).notNullable();
    table.string('analysis_code', 16);
    table.string('subscription_id', 64);
    table.timestamp('updated_at').defaultTo(knex.fn.now());
    table.index(['opera_account', 'document_ref']);
  });
}
