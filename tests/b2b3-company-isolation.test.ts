/**
 * Per-company isolation tests — Phase B2b + B3 (migration 009).
 *
 * Verifies the multi-company guarantees added by migration 009 for the
 * remaining per-company tables:
 *   B2b — core registries:
 *     - gocardless_mandates
 *     - gocardless_imports
 *     - mandate_setup_requests
 *   B3  — operator-facing tables:
 *     - gocardless_payment_requests
 *     - gocardless_subscriptions
 *
 * For each table the test asserts:
 *   - Two companies in the same SAM-provisioned database can each own
 *     their own rows without cross-talk.
 *   - The service helpers refuse to operate with an empty / missing
 *     company code (companyScope throws — never silently returns
 *     another company's data).
 *
 * Uses a real in-memory SQLite DB with every migration applied,
 * mirroring `tests/settings-company-isolation.test.ts`.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import knex, { type Knex } from 'knex';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';

import {
  listMandates,
  linkMandate,
  listUnlinkedMandates,
} from '../src/services/mandates.js';
import {
  getImportHistory,
} from '../src/services/import-history.js';
import {
  isPayoutImported,
  isEmailImported,
  getImportedEmailIds,
} from '../src/services/import-idempotency.js';
import { skipPayout } from '../src/services/skip-payout.js';
import {
  listMandateSetups,
} from '../src/services/mandate-setups.js';
import {
  listPaymentRequests,
  getPaymentRequest,
} from '../src/services/payment-requests.js';
import { listSubscriptions } from '../src/services/subscriptions.js';

const MIGRATIONS_DIR = path.resolve(__dirname, '../db/migrations');

async function makeDb(): Promise<Knex> {
  const db = knex({
    client: 'sqlite3',
    connection: { filename: ':memory:' },
    useNullAsDefault: true,
  });
  // Apply every migration in lexical order — mirrors how the SAM host's
  // plugin migration runner does it.
  const files = (await fs.readdir(MIGRATIONS_DIR))
    .filter((f) => f.endsWith('.ts') || f.endsWith('.js'))
    .sort();
  for (const file of files) {
    const mod = (await import(path.resolve(MIGRATIONS_DIR, file))) as {
      up: (k: Knex) => Promise<void>;
    };
    await mod.up(db);
  }
  return db;
}

// ---------------------------------------------------------------------
// gocardless_mandates
// ---------------------------------------------------------------------

describe('gocardless_mandates — per-company isolation', () => {
  let db: Knex;
  beforeEach(async () => {
    db = await makeDb();
  });
  afterEach(async () => {
    await db.destroy();
  });

  it('two companies can each link their own mandates without cross-talk', async () => {
    const linkC = await linkMandate(db, 'C', {
      operaAccount: 'CUST_C_01',
      mandateId: 'MD_C_01',
      operaName: 'Cloudsis Customer One',
      email: 'c1@cloudsis.example',
    });
    expect(linkC.success).toBe(true);
    const linkI = await linkMandate(db, 'I', {
      operaAccount: 'CUST_I_01',
      mandateId: 'MD_I_01',
      operaName: 'Intsys Customer One',
      email: 'i1@intsys.example',
    });
    expect(linkI.success).toBe(true);

    const listC = await listMandates(db, 'C');
    const listI = await listMandates(db, 'I');

    expect(listC.success).toBe(true);
    expect(listC.count).toBe(1);
    expect(listC.mandates[0]?.mandate_id).toBe('MD_C_01');
    expect(listC.mandates[0]?.opera_account).toBe('CUST_C_01');

    expect(listI.success).toBe(true);
    expect(listI.count).toBe(1);
    expect(listI.mandates[0]?.mandate_id).toBe('MD_I_01');
    expect(listI.mandates[0]?.opera_account).toBe('CUST_I_01');
  });

  it('listMandates throws on empty company code (fail-loud, never silent leak)', async () => {
    await linkMandate(db, 'C', {
      operaAccount: 'CUST_C_01',
      mandateId: 'MD_C_01',
    });
    await expect(listMandates(db, '')).rejects.toThrow(/empty company code/i);
    await expect(listMandates(db, '   ')).rejects.toThrow(/empty company code/i);
    await expect(
      listMandates(db, undefined as unknown as string),
    ).rejects.toThrow(/empty company code/i);
  });

  it('linkMandate throws on empty company code', async () => {
    await expect(
      linkMandate(db, '', { operaAccount: 'CUST_X', mandateId: 'MD_X' }),
    ).rejects.toThrow(/empty company code/i);
  });

  it('listUnlinkedMandates is scoped by company', async () => {
    // Both companies stash an __UNLINKED__ mandate (legitimate use:
    // syncMandatesFromGocardless writes one when no Opera match yet).
    await linkMandate(db, 'C', {
      operaAccount: '__UNLINKED__',
      mandateId: 'MD_C_UNL',
      operaName: 'Cloudsis Raw',
    });
    await linkMandate(db, 'I', {
      operaAccount: '__UNLINKED__',
      mandateId: 'MD_I_UNL',
      operaName: 'Intsys Raw',
    });

    const cRes = await listUnlinkedMandates(db, 'C');
    expect(cRes.count).toBe(1);
    expect(cRes.mandates[0]?.mandate_id).toBe('MD_C_UNL');

    const iRes = await listUnlinkedMandates(db, 'I');
    expect(iRes.count).toBe(1);
    expect(iRes.mandates[0]?.mandate_id).toBe('MD_I_UNL');
  });
});

// ---------------------------------------------------------------------
// gocardless_imports — via skipPayout + getImportHistory
// ---------------------------------------------------------------------

describe('gocardless_imports — per-company isolation', () => {
  let db: Knex;
  beforeEach(async () => {
    db = await makeDb();
  });
  afterEach(async () => {
    await db.destroy();
  });

  it('per-company import history (skipPayout writes, getImportHistory reads)', async () => {
    const skipC = await skipPayout(db, 'C', {
      payoutId: 'PO_C_001',
      bankReference: 'CLOUDSIS-REF-C',
      grossAmount: 100,
    });
    expect(skipC.success).toBe(true);
    const skipI = await skipPayout(db, 'I', {
      payoutId: 'PO_I_001',
      bankReference: 'INTSYS-REF-I',
      grossAmount: 250,
    });
    expect(skipI.success).toBe(true);

    const histC = await getImportHistory(db, 'C', null);
    const histI = await getImportHistory(db, 'I', null);

    expect(histC.success).toBe(true);
    expect(histC.total).toBe(1);
    expect(histC.imports[0]?.bank_reference).toBe('CLOUDSIS-REF-C');

    expect(histI.success).toBe(true);
    expect(histI.total).toBe(1);
    expect(histI.imports[0]?.bank_reference).toBe('INTSYS-REF-I');
  });

  it('isPayoutImported is scoped by company — never sees another company payout', async () => {
    // Real imports (not skipped) — seed directly with imported_by!='MANUAL-*'
    // so excludeNonImported() doesn't drop them.
    await db('gocardless_imports').insert({
      company_code: 'C',
      payout_id: 'PO_C_ONLY',
      bank_reference: 'C-REF',
      gross_amount: 100,
      net_amount: 100,
      target_system: 'opera_se',
      imported_by: 'IMPORT',
    });

    expect(await isPayoutImported(db, 'C', 'PO_C_ONLY')).toBe(true);
    // From company I's perspective, the payout is unknown — even though
    // GoCardless could in principle generate the same payout_id globally.
    expect(await isPayoutImported(db, 'I', 'PO_C_ONLY')).toBe(false);
  });

  it('isEmailImported / getImportedEmailIds are scoped by company', async () => {
    // Seed gocardless_imports directly (skipPayout doesn't take email_id).
    await db('gocardless_imports').insert({
      company_code: 'C',
      email_id: 1001,
      bank_reference: 'C-EMAIL',
      gross_amount: 100,
      net_amount: 100,
      target_system: 'opera_se',
      imported_by: 'IMPORT',
    });
    await db('gocardless_imports').insert({
      company_code: 'I',
      email_id: 2002,
      bank_reference: 'I-EMAIL',
      gross_amount: 100,
      net_amount: 100,
      target_system: 'opera_se',
      imported_by: 'IMPORT',
    });

    expect(await isEmailImported(db, 'C', 1001)).toBe(true);
    expect(await isEmailImported(db, 'C', 2002)).toBe(false);
    expect(await isEmailImported(db, 'I', 2002)).toBe(true);
    expect(await isEmailImported(db, 'I', 1001)).toBe(false);

    const idsC = await getImportedEmailIds(db, 'C');
    const idsI = await getImportedEmailIds(db, 'I');
    expect(idsC.sort()).toEqual([1001]);
    expect(idsI.sort()).toEqual([2002]);
  });

  it('getImportHistory throws on empty company code', async () => {
    await expect(getImportHistory(db, '', null)).rejects.toThrow(
      /empty company code/i,
    );
  });

  it('skipPayout throws on empty company code', async () => {
    await expect(
      skipPayout(db, '', {
        payoutId: 'PO_X',
        bankReference: 'X',
        grossAmount: 100,
      }),
    ).rejects.toThrow(/empty company code/i);
  });
});

// ---------------------------------------------------------------------
// mandate_setup_requests
// ---------------------------------------------------------------------

describe('mandate_setup_requests — per-company isolation', () => {
  let db: Knex;
  beforeEach(async () => {
    db = await makeDb();
  });
  afterEach(async () => {
    await db.destroy();
  });

  it('listMandateSetups returns only this company rows', async () => {
    // Seed directly — createMandateSetup needs a working GoCardless
    // billing-request adapter which is out of scope here.
    await db('mandate_setup_requests').insert({
      company_code: 'C',
      billing_request_id: 'BR_C_01',
      opera_account: 'CUST_C_01',
      opera_name: 'Cloudsis Customer',
      customer_email: 'c1@cloudsis.example',
      status: 'pending',
    });
    await db('mandate_setup_requests').insert({
      company_code: 'I',
      billing_request_id: 'BR_I_01',
      opera_account: 'CUST_I_01',
      opera_name: 'Intsys Customer',
      customer_email: 'i1@intsys.example',
      status: 'pending',
    });

    const cRes = await listMandateSetups(db, 'C');
    const iRes = await listMandateSetups(db, 'I');

    expect(cRes.success).toBe(true);
    expect(cRes.setups).toHaveLength(1);
    expect(cRes.setups[0]?.opera_account).toBe('CUST_C_01');

    expect(iRes.success).toBe(true);
    expect(iRes.setups).toHaveLength(1);
    expect(iRes.setups[0]?.opera_account).toBe('CUST_I_01');
  });

  it('listMandateSetups throws on empty company code', async () => {
    await expect(listMandateSetups(db, '')).rejects.toThrow(
      /empty company code/i,
    );
  });
});

// ---------------------------------------------------------------------
// gocardless_payment_requests
// ---------------------------------------------------------------------

describe('gocardless_payment_requests — per-company isolation', () => {
  let db: Knex;
  beforeEach(async () => {
    db = await makeDb();
  });
  afterEach(async () => {
    await db.destroy();
  });

  it('listPaymentRequests returns only this company rows', async () => {
    await db('gocardless_payment_requests').insert({
      company_code: 'C',
      payment_id: 'PM_C_001',
      mandate_id: 'MD_C_01',
      opera_account: 'CUST_C_01',
      amount: 100,
      amount_pence: 10000,
      currency: 'GBP',
      status: 'pending',
    });
    await db('gocardless_payment_requests').insert({
      company_code: 'I',
      payment_id: 'PM_I_001',
      mandate_id: 'MD_I_01',
      opera_account: 'CUST_I_01',
      amount: 250,
      amount_pence: 25000,
      currency: 'GBP',
      status: 'pending',
    });

    const cRes = await listPaymentRequests(db, 'C');
    const iRes = await listPaymentRequests(db, 'I');

    expect(cRes.success).toBe(true);
    expect(cRes.count).toBe(1);
    expect(cRes.requests[0]?.payment_id).toBe('PM_C_001');

    expect(iRes.success).toBe(true);
    expect(iRes.count).toBe(1);
    expect(iRes.requests[0]?.payment_id).toBe('PM_I_001');
  });

  it('getPaymentRequest refuses to leak another company row even by primary-key id', async () => {
    const [cId] = await db('gocardless_payment_requests')
      .insert({
        company_code: 'C',
        payment_id: 'PM_C_001',
        mandate_id: 'MD_C_01',
        opera_account: 'CUST_C_01',
        amount: 100,
        amount_pence: 10000,
        currency: 'GBP',
        status: 'pending',
      })
      .returning('id');
    const numericId =
      typeof cId === 'number'
        ? cId
        : (cId as { id: number })?.id ?? Number(cId);

    // Same row id, wrong company — must NOT return the row.
    const wrongCompany = await getPaymentRequest(db, 'I', numericId);
    expect(wrongCompany.success).toBe(false);

    const rightCompany = await getPaymentRequest(db, 'C', numericId);
    expect(rightCompany.success).toBe(true);
    expect(rightCompany.payment_request?.payment_id).toBe('PM_C_001');
  });

  it('listPaymentRequests throws on empty company code', async () => {
    await expect(listPaymentRequests(db, '')).rejects.toThrow(
      /empty company code/i,
    );
  });
});

// ---------------------------------------------------------------------
// gocardless_subscriptions
// ---------------------------------------------------------------------

describe('gocardless_subscriptions — per-company isolation', () => {
  let db: Knex;
  beforeEach(async () => {
    db = await makeDb();
  });
  afterEach(async () => {
    await db.destroy();
  });

  it('listSubscriptions returns only this company rows', async () => {
    await db('gocardless_subscriptions').insert({
      company_code: 'C',
      subscription_id: 'SUB_C_001',
      mandate_id: 'MD_C_01',
      opera_account: 'CUST_C_01',
      amount_pence: 5000,
      currency: 'GBP',
      interval_unit: 'monthly',
      interval_count: 1,
      status: 'active',
    });
    await db('gocardless_subscriptions').insert({
      company_code: 'I',
      subscription_id: 'SUB_I_001',
      mandate_id: 'MD_I_01',
      opera_account: 'CUST_I_01',
      amount_pence: 9900,
      currency: 'GBP',
      interval_unit: 'monthly',
      interval_count: 3,
      status: 'active',
    });

    const cRes = await listSubscriptions(db, 'C');
    const iRes = await listSubscriptions(db, 'I');

    expect(cRes.success).toBe(true);
    expect(cRes.count).toBe(1);
    expect(cRes.subscriptions[0]?.subscription_id).toBe('SUB_C_001');
    expect(cRes.subscriptions[0]?.amount_pence).toBe(5000);

    expect(iRes.success).toBe(true);
    expect(iRes.count).toBe(1);
    expect(iRes.subscriptions[0]?.subscription_id).toBe('SUB_I_001');
    expect(iRes.subscriptions[0]?.amount_pence).toBe(9900);
  });

  it('listSubscriptions throws on empty company code', async () => {
    await expect(listSubscriptions(db, '')).rejects.toThrow(
      /empty company code/i,
    );
  });
});
