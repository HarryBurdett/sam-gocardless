/**
 * Align `mandate_setup_requests` schema with the canonical Python
 * SQLite schema in `sql_rag/gocardless_payments.py:228-261`.
 *
 * Migration 001 used a pared-down version. This migration drops +
 * recreates the table with the wider Python column set so the
 * mandate setup flow can write the same fields the legacy code does.
 *
 * Recreate (vs alter) is safe because nothing references the old
 * schema yet (greenfield).
 */
import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('mandate_setup_requests');
  await knex.schema.createTable('mandate_setup_requests', (table) => {
    table.increments('id').primary();
    table.string('opera_account', 32).notNullable();
    table.string('opera_name', 200);
    table.string('customer_email', 200).notNullable();
    table.string('billing_request_id', 64);
    table.string('billing_request_flow_id', 64);
    table.text('authorisation_url');
    table.string('mandate_id', 64);
    table.string('gocardless_customer_id', 64);
    table.string('status', 32).defaultTo('pending');
    table.text('status_detail');
    table.timestamp('email_sent_at');
    table.timestamp('mandate_active_at');
    table.timestamp('created_at').defaultTo(knex.fn.now());
    table.timestamp('updated_at').defaultTo(knex.fn.now());
    table.index('opera_account');
    table.index('status');
    table.index('billing_request_id');
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('mandate_setup_requests');
  await knex.schema.createTable('mandate_setup_requests', (table) => {
    table.increments('id').primary();
    table.string('request_id', 64).notNullable().unique();
    table.string('opera_account', 32);
    table.string('customer_email', 200);
    table.string('status', 32);
    table.timestamp('created_at').defaultTo(knex.fn.now());
  });
}
