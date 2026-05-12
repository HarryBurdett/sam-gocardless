/**
 * gocardless_imports table — history of GoCardless batches imported
 * to Opera. In the Python implementation this lives in
 * data/{company}/core/email_data.db (gocardless_imports table) since
 * core-email owns the audit log. Under SAM, core-email is replaced by
 * SAM's email service, so this audit log moves into the gocardless
 * per-app database.
 */
import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('gocardless_imports', (table) => {
    table.increments('id').primary();
    table.string('bank_reference', 200);
    table.date('payment_date');
    table.decimal('gross_amount', 12, 2);
    table.decimal('fees_amount', 12, 2);
    table.decimal('vat_on_fees', 12, 2);
    table.decimal('net_amount', 12, 2);
    table.string('currency', 3).defaultTo('GBP');
    table.string('bank_code', 16);
    table.string('cbtype', 16);
    table.text('payments_json'); // serialised payment details
    table.text('opera_entry_refs'); // serialised list of Opera ae_entref values
    table.string('target_system', 16); // 'opera_se' or 'opera_3'
    table.string('imported_by', 64);
    table.timestamp('imported_at').defaultTo(knex.fn.now());
    table.index('payment_date');
    table.index('bank_code');
    table.index(['target_system', 'payment_date']);
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('gocardless_imports');
}
