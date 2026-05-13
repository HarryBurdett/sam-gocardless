/**
 * Tests for the legacy gocardless_payments.db migration (mandates,
 * payment_requests, subscriptions, etc.).
 *
 * Strategy:
 *   1. Build a tmp directory with a legacy-shape SQLite (the same
 *      column subset the real legacy app produced).
 *   2. Call loadCompany() pointing legacyDataRoot at that tmp dir.
 *   3. Assert rows appear in the destination + the migration is
 *      idempotent on a second run.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import knex, { type Knex } from 'knex';
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Router } from 'express';
import { loadCompany } from '../company-registry.js';
import { noOpAdapter } from '../opera-adapter.js';

const silentLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
};

const factory = () => Router();

let tmpHome: string;
let dataRoot: string;
let legacyDataRoot: string;
const CODE = 'intsys';

async function buildLegacyDb(file: string): Promise<void> {
  const db = knex({
    client: 'sqlite3',
    connection: { filename: file },
    useNullAsDefault: true,
    pool: { min: 1, max: 1 },
  });
  try {
    await db.schema.createTable('gocardless_mandates', (t) => {
      t.increments('id');
      t.text('opera_account').notNullable();
      t.text('opera_name');
      t.text('gocardless_customer_id');
      t.text('mandate_id').notNullable();
      t.text('mandate_status').defaultTo('active');
      t.text('scheme').defaultTo('bacs');
      t.text('email');
      t.text('created_at').defaultTo(db.fn.now());
      t.text('updated_at');
      t.text('gocardless_name');
      t.unique(['opera_account', 'mandate_id']);
    });
    await db.schema.createTable('gocardless_payment_requests', (t) => {
      t.increments('id');
      t.text('payment_id').unique();
      t.text('mandate_id').notNullable();
      t.text('opera_account').notNullable();
      t.integer('amount_pence').notNullable();
      t.text('currency').defaultTo('GBP');
      t.text('charge_date');
      t.text('description');
      t.text('invoice_refs');
      t.text('status').defaultTo('pending');
      t.text('payout_id');
      t.text('opera_receipt_ref');
      t.text('error_message');
      t.text('created_at').defaultTo(db.fn.now());
      t.text('updated_at');
    });
    await db('gocardless_mandates').insert([
      {
        opera_account: 'ACME001',
        opera_name: 'Acme Ltd',
        mandate_id: 'MD123',
        mandate_status: 'active',
        scheme: 'bacs',
        email: 'a@acme.test',
        gocardless_customer_id: 'CUST_A',
        gocardless_name: 'Acme on GC',
      },
      {
        opera_account: 'BETA002',
        opera_name: 'Beta Co',
        mandate_id: 'MD456',
        mandate_status: 'pending_submission',
        scheme: 'bacs',
        email: 'b@beta.test',
        gocardless_customer_id: 'CUST_B',
        gocardless_name: 'Beta on GC',
      },
    ]);
    await db('gocardless_payment_requests').insert({
      payment_id: 'PR_1',
      mandate_id: 'MD123',
      opera_account: 'ACME001',
      amount_pence: 12345,
      currency: 'GBP',
      status: 'pending',
      description: 'Old description column not in new schema',
      invoice_refs: 'INV001',
    });
  } finally {
    await db.destroy();
  }
}

beforeEach(async () => {
  tmpHome = mkdtempSync(join(tmpdir(), 'sgc-legacy-mig-'));
  dataRoot = join(tmpHome, 'data');
  legacyDataRoot = join(tmpHome, 'legacy');
  mkdirSync(join(dataRoot, CODE), { recursive: true });
  mkdirSync(join(legacyDataRoot, CODE, 'gocardless'), { recursive: true });
  await buildLegacyDb(
    join(legacyDataRoot, CODE, 'gocardless', 'gocardless_payments.db'),
  );
});

afterEach(() => {
  rmSync(tmpHome, { recursive: true, force: true });
});

describe('legacy payments-db migration', () => {
  it('copies mandates and payment_requests on first load', async () => {
    const instance = await loadCompany(CODE, {
      dataRoot,
      legacyDataRoot,
      operaAdapter: noOpAdapter,
      logger: silentLogger,
      factory,
    });
    try {
      const mandates = await instance.appDb('gocardless_mandates').select();
      expect(mandates).toHaveLength(2);
      const acme = mandates.find((m) => m.opera_account === 'ACME001');
      expect(acme?.mandate_id).toBe('MD123');
      expect(acme?.gocardless_customer_id).toBe('CUST_A');

      const payments = await instance.appDb('gocardless_payment_requests').select();
      expect(payments).toHaveLength(1);
      expect(payments[0].payment_id).toBe('PR_1');
      // Legacy stored only amount_pence; new schema also exposes `amount`
      // (in GBP) which the seeder derives.
      expect(payments[0].amount_pence).toBe(12345);
      expect(payments[0].amount).toBeCloseTo(123.45, 2);
      // Column that exists in legacy but not in the new schema is dropped:
      expect(payments[0].description).toBeUndefined();
    } finally {
      await instance.samDb.destroy();
      await instance.appDb.destroy();
    }
  });

  it('falls back to row-by-row when bulk insert hits a unique-constraint conflict', async () => {
    // Inject a duplicate-mandate row into the legacy DB: same mandate_id
    // as MD123 but a different opera_account (mirrors the
    // `__UNLINKED__` vs real-account pattern in z_demo's real data).
    const legacyDb = knex({
      client: 'sqlite3',
      connection: {
        filename: join(legacyDataRoot, CODE, 'gocardless', 'gocardless_payments.db'),
      },
      useNullAsDefault: true,
      pool: { min: 1, max: 1 },
    });
    try {
      await legacyDb('gocardless_mandates').insert({
        opera_account: '__UNLINKED__',
        opera_name: 'Acme (unlinked)',
        mandate_id: 'MD123',
        mandate_status: 'active',
        scheme: 'bacs',
      });
    } finally {
      await legacyDb.destroy();
    }

    const instance = await loadCompany(CODE, {
      dataRoot,
      legacyDataRoot,
      operaAdapter: noOpAdapter,
      logger: silentLogger,
      factory,
    });
    try {
      const mandates = await instance.appDb('gocardless_mandates').select();
      // Only the first row with mandate_id=MD123 survives in the new schema.
      expect(mandates.length).toBeGreaterThanOrEqual(2);
      const md123 = mandates.filter((m) => m.mandate_id === 'MD123');
      expect(md123).toHaveLength(1);
    } finally {
      await instance.samDb.destroy();
      await instance.appDb.destroy();
    }
  });

  it('migrates gocardless_imports from the legacy core/email_data.db', async () => {
    // Set up the second legacy DB the seed expects.
    const coreDir = join(legacyDataRoot, CODE, 'core');
    mkdirSync(coreDir, { recursive: true });
    const emailDbPath = join(coreDir, 'email_data.db');
    const emailDb = knex({
      client: 'sqlite3',
      connection: { filename: emailDbPath },
      useNullAsDefault: true,
      pool: { min: 1, max: 1 },
    });
    try {
      await emailDb.schema.createTable('gocardless_imports', (t) => {
        t.increments('id');
        t.integer('email_id');
        t.text('payout_id');
        t.text('source').defaultTo('email');
        t.text('bank_reference');
        t.float('gross_amount');
        t.float('net_amount');
        t.float('gocardless_fees');
        t.float('vat_on_fees');
        t.integer('payment_count');
        t.text('payments_json');
        t.text('target_system').notNullable();
        t.text('batch_ref');
        t.text('import_date').notNullable();
        t.text('imported_by');
        t.float('fx_amount');
        t.text('customer_name');
        t.text('post_date');
      });
      await emailDb('gocardless_imports').insert({
        payout_id: 'PO_TEST_1',
        source: 'api',
        bank_reference: 'BANKREF_1',
        gross_amount: 1234.56,
        net_amount: 1230.56,
        gocardless_fees: 4.0,
        vat_on_fees: 0.0,
        payment_count: 3,
        payments_json: '[]',
        target_system: 'opera_se',
        batch_ref: null,
        import_date: '2026-05-01T10:00:00',
        imported_by: 'TEST',
        post_date: '2026-05-01',
      });
    } finally {
      await emailDb.destroy();
    }

    const instance = await loadCompany(CODE, {
      dataRoot,
      legacyDataRoot,
      operaAdapter: noOpAdapter,
      logger: silentLogger,
      factory,
    });
    try {
      const imports = await instance.appDb('gocardless_imports').select();
      expect(imports).toHaveLength(1);
      const r = imports[0];
      expect(r.payout_id).toBe('PO_TEST_1');
      // Renamed columns:
      expect(r.fees_amount).toBeCloseTo(4.0, 2);
      expect(r.imported_at).toBe('2026-05-01T10:00:00');
      // Dropped: customer_name not in new schema (no equivalent column)
      expect(r.customer_name).toBeUndefined();
      // Derived: payment_date falls back to post_date when not set
      expect(r.payment_date).toBe('2026-05-01');
    } finally {
      await instance.samDb.destroy();
      await instance.appDb.destroy();
    }
  });

  it('is idempotent on a second load (no duplicate rows)', async () => {
    const first = await loadCompany(CODE, {
      dataRoot,
      legacyDataRoot,
      operaAdapter: noOpAdapter,
      logger: silentLogger,
      factory,
    });
    await first.samDb.destroy();
    await first.appDb.destroy();

    const second = await loadCompany(CODE, {
      dataRoot,
      legacyDataRoot,
      operaAdapter: noOpAdapter,
      logger: silentLogger,
      factory,
    });
    try {
      const count = await second.appDb('gocardless_mandates').count<{ c: number }[]>('* as c');
      expect(Number(count[0]?.c)).toBe(2);
    } finally {
      await second.samDb.destroy();
      await second.appDb.destroy();
    }
  });
});
