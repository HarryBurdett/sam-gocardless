/**
 * Initial schema for the gocardless per-app database.
 *
 * Mirrors the per-company SQLite schema in the Python implementation
 * (data/{company}/gocardless/gocardless_payments.db) plus the
 * settings JSON file which we promote to a settings table.
 *
 * SAM provisions this database as `ai_sam_app_gocardless` per tenant
 * and runs these migrations via `knex.migrate.latest()` at install.
 */
import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  // Settings — one row per tenant. Stores the JSON dict the Python file held.
  await knex.schema.createTable('settings', (table) => {
    table.increments('id').primary();
    table.string('key', 64).notNullable().unique();
    table.text('value'); // JSON-encoded
    table.timestamp('updated_at').defaultTo(knex.fn.now());
  });

  // Mandate registry — mirrors gocardless_mandates SQLite table
  await knex.schema.createTable('gocardless_mandates', (table) => {
    table.increments('id').primary();
    table.string('mandate_id', 64).notNullable().unique();
    table.string('opera_account', 32);
    table.string('customer_name', 200);
    table.string('status', 32);
    table.timestamp('created_at').defaultTo(knex.fn.now());
    table.timestamp('updated_at').defaultTo(knex.fn.now());
    table.index('opera_account');
    table.index('status');
  });

  // Payment requests — mirrors gocardless_payment_requests SQLite table
  await knex.schema.createTable('gocardless_payment_requests', (table) => {
    table.increments('id').primary();
    table.string('payment_id', 64).notNullable().unique();
    table.string('mandate_id', 64);
    table.string('opera_account', 32);
    table.decimal('amount', 12, 2);
    table.string('currency', 3).defaultTo('GBP');
    table.string('status', 32);
    table.string('reference', 200);
    table.date('charge_date');
    table.timestamp('created_at').defaultTo(knex.fn.now());
    table.timestamp('updated_at').defaultTo(knex.fn.now());
    table.index('mandate_id');
    table.index('opera_account');
    table.index('status');
    table.index('charge_date');
  });

  // Subscription tracking — mirrors gocardless_subscriptions SQLite table
  await knex.schema.createTable('gocardless_subscriptions', (table) => {
    table.increments('id').primary();
    table.string('subscription_id', 64).notNullable().unique();
    table.string('mandate_id', 64);
    table.string('opera_account', 32);
    table.decimal('amount', 12, 2);
    table.string('frequency', 16); // W, M, Q, A
    table.string('status', 32);
    table.timestamp('created_at').defaultTo(knex.fn.now());
    table.timestamp('updated_at').defaultTo(knex.fn.now());
    table.index('mandate_id');
    table.index('opera_account');
  });

  // Subscription documents — opera repeat-doc analysis-code tags
  await knex.schema.createTable('gocardless_subscription_documents', (table) => {
    table.increments('id').primary();
    table.string('opera_account', 32).notNullable();
    table.string('document_ref', 64).notNullable();
    table.string('analysis_code', 16);
    table.string('subscription_id', 64);
    table.timestamp('updated_at').defaultTo(knex.fn.now());
    table.index(['opera_account', 'document_ref']);
  });

  // Partner signups — mirrors gocardless_partner_signups SQLite table
  await knex.schema.createTable('gocardless_partner_signups', (table) => {
    table.increments('id').primary();
    table.string('signup_id', 64).notNullable().unique();
    table.string('merchant_email', 200);
    table.string('status', 32);
    table.text('metadata'); // JSON
    table.timestamp('created_at').defaultTo(knex.fn.now());
  });

  // Mandate setup requests
  await knex.schema.createTable('mandate_setup_requests', (table) => {
    table.increments('id').primary();
    table.string('request_id', 64).notNullable().unique();
    table.string('opera_account', 32);
    table.string('customer_email', 200);
    table.string('status', 32);
    table.timestamp('created_at').defaultTo(knex.fn.now());
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('mandate_setup_requests');
  await knex.schema.dropTableIfExists('gocardless_partner_signups');
  await knex.schema.dropTableIfExists('gocardless_subscription_documents');
  await knex.schema.dropTableIfExists('gocardless_subscriptions');
  await knex.schema.dropTableIfExists('gocardless_payment_requests');
  await knex.schema.dropTableIfExists('gocardless_mandates');
  await knex.schema.dropTableIfExists('settings');
}
