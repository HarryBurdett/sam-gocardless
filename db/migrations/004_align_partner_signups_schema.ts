/**
 * Align `gocardless_partner_signups` and add `partner_admin_password`
 * settings key — both faithful to the Python schema in
 * `sql_rag/gocardless_payments.py:264-292` and
 * `apps/gocardless/api/routes.py:1357-1369`.
 *
 * Migration 001 used a pared-down `gocardless_partner_signups` schema
 * (id, signup_id unique, merchant_email, status, metadata JSON,
 * created_at). The Python schema is wider — separate columns for
 * each field that the partner OAuth flow + merchant onboarding write.
 *
 * This migration drops + recreates the table because nothing
 * references the old schema yet (greenfield).
 */
import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('gocardless_partner_signups');

  await knex.schema.createTable('gocardless_partner_signups', (table) => {
    table.increments('id').primary();
    table.string('company_name', 200);
    table.string('company_email', 200);
    table.string('billing_request_id', 64);
    table.string('billing_request_flow_id', 64);
    table.text('authorisation_url');
    table.string('status', 32).defaultTo('pending');
    table.text('status_detail');
    // Python uses INTEGER 0/1 — we use boolean for clarity
    table.boolean('access_token_obtained').defaultTo(false);
    table.text('merchant_access_token');
    table.string('merchant_organisation_id', 64);
    table.string('merchant_creditor_name', 200);
    table.string('merchant_app_url', 500);
    table.string('partner_referral_id', 64);
    table.timestamp('created_at').defaultTo(knex.fn.now());
    table.timestamp('completed_at');
    table.timestamp('updated_at');
    table.index('billing_request_id');
    table.index('status');
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('gocardless_partner_signups');
  await knex.schema.createTable('gocardless_partner_signups', (table) => {
    table.increments('id').primary();
    table.string('signup_id', 64).notNullable().unique();
    table.string('merchant_email', 200);
    table.string('status', 32);
    table.text('metadata');
    table.timestamp('created_at').defaultTo(knex.fn.now());
  });
}
