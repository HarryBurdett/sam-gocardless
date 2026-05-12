/**
 * Tests for gocardless lookup endpoints — read-only Opera queries.
 */
import { describe, it, expect } from 'vitest';
import {
  getBatchTypes,
  getNominalAccounts,
  getPaymentTypes,
  getBankAccounts,
  getImportConfig,
  getSetupStatus,
} from '../src/services/lookups.js';

function makeMockOpera(rows: unknown[]): any {
  const db: any = () => ({});
  db.raw = async () => rows;
  return db;
}

describe('getBatchTypes', () => {
  it('returns types and recommends the first GoCardless one', async () => {
    const db = makeMockOpera([
      { ay_cbtype: 'BT', ay_desc: 'Bank Transfer', ay_batched: 1 },
      { ay_cbtype: 'GC', ay_desc: 'GoCardless Direct Debit', ay_batched: 1 },
      { ay_cbtype: 'CC', ay_desc: 'Credit Card', ay_batched: 1 },
    ]);
    const result = await getBatchTypes(db);
    expect(result.success).toBe(true);
    expect(result.batch_types).toHaveLength(3);
    expect(result.recommended?.code).toBe('GC');
    expect(result.recommended?.is_gocardless).toBe(true);
  });

  it('returns warning when no batch types found', async () => {
    const db = makeMockOpera([]);
    const result = await getBatchTypes(db);
    expect(result.success).toBe(true);
    expect(result.batch_types).toEqual([]);
    expect(result.warning).toMatch(/No batched receipt types/);
  });
});

describe('getNominalAccounts', () => {
  it('returns accounts excluding Z-prefixed', async () => {
    const db = makeMockOpera([
      { na_acnt: '7800', na_desc: 'Bank Charges', na_allwprj: 0, na_allwjob: 0, na_project: '', na_job: '' },
      { na_acnt: '4000', na_desc: 'Sales', na_allwprj: 1, na_allwjob: 0, na_project: 'P1', na_job: '' },
    ]);
    const result = await getNominalAccounts(db);
    expect(result.success).toBe(true);
    expect(result.accounts).toHaveLength(2);
    expect(result.accounts[0]?.code).toBe('7800');
    expect(result.accounts[1]?.allow_project).toBe(1);
    expect(result.accounts[1]?.default_project).toBe('P1');
  });
});

describe('getPaymentTypes', () => {
  it('returns payment types from atype', async () => {
    const db = makeMockOpera([
      { ay_cbtype: 'P1', ay_desc: 'Payment 1' },
      { ay_cbtype: 'P2', ay_desc: 'Payment 2' },
    ]);
    const result = await getPaymentTypes(db);
    expect(result.success).toBe(true);
    expect(result.types).toHaveLength(2);
    expect(result.types[0]?.code).toBe('P1');
  });

  it('returns empty list when none found', async () => {
    const db = makeMockOpera([]);
    const result = await getPaymentTypes(db);
    expect(result.success).toBe(true);
    expect(result.types).toEqual([]);
  });
});

describe('getBankAccounts', () => {
  it('returns Opera bank accounts trimmed', async () => {
    const db = makeMockOpera([
      { nk_acnt: 'BC010', nk_desc: 'Barclays Current  ' },
      { nk_acnt: 'BC020', nk_desc: 'Barclays Savings' },
    ]);
    const result = await getBankAccounts(db);
    expect(result.success).toBe(true);
    expect(result.accounts).toHaveLength(2);
    expect(result.accounts[0]?.code).toBe('BC010');
    expect(result.accounts[0]?.description).toBe('Barclays Current');
  });

  it('returns empty list when no bank accounts', async () => {
    const db = makeMockOpera([]);
    const result = await getBankAccounts(db);
    expect(result.accounts).toEqual([]);
  });
});

describe('getImportConfig', () => {
  it('aggregates batch types + nominal accounts + VAT codes', async () => {
    // Use a smarter mock that returns different rows based on SQL keyword
    const db: any = () => ({});
    db.raw = async (sql: string) => {
      if (sql.includes('atype') && sql.includes("ay_type = 'R'")) {
        return [{ ay_cbtype: 'GC', ay_desc: 'GoCardless', ay_batched: 1 }];
      }
      if (sql.includes('nacnt')) {
        return [
          {
            na_acnt: '7800',
            na_desc: 'Bank Charges',
            na_allwprj: 0,
            na_allwjob: 0,
            na_project: '',
            na_job: '',
          },
        ];
      }
      if (sql.includes('ztax')) {
        return [
          {
            tx_code: '1',
            tx_desc: 'Standard',
            tx_rate1: 20,
            tx_rate1dy: null,
            tx_rate2: null,
            tx_rate2dy: null,
            tx_trantyp: 'P',
            tx_nominal: '7800',
          },
        ];
      }
      return [];
    };

    const result = await getImportConfig(db);
    expect(result.success).toBe(true);
    expect(result.batch_types).toHaveLength(1);
    expect(result.batch_types_recommended?.code).toBe('GC');
    expect(result.nominal_accounts).toHaveLength(1);
    expect(result.vat_codes).toHaveLength(1);
    expect(result.vat_codes[0]?.rate).toBe(20);
  });
});

describe('getSetupStatus', () => {
  function makeAppDb(canned: { settings?: any; signup?: any }): any {
    const db: any = (table: string) => {
      if (table === 'settings') {
        return {
          where: () => ({
            first: async () => (canned.settings ? { value: JSON.stringify(canned.settings) } : null),
          }),
        };
      }
      if (table === 'gocardless_partner_signups') {
        return {
          orderBy: () => ({ first: async () => canned.signup ?? null }),
        };
      }
      return {};
    };
    db.raw = async () => [];
    db.fn = { now: () => new Date() };
    return db;
  }

  it('returns configured=true when api_access_token > 10 chars', async () => {
    const db = makeAppDb({
      settings: { api_access_token: 'sandbox_test_token_long_enough' },
    });
    const result = await getSetupStatus(db);
    expect(result.configured).toBe(true);
    expect(result.pending_signup).toBeNull();
  });

  it('returns configured=false and surfaces pending signup when not configured', async () => {
    const db = makeAppDb({
      signup: { id: 1, status: 'pending', merchant_email: 'x@y.com' },
    });
    const result = await getSetupStatus(db);
    expect(result.configured).toBe(false);
    expect(result.pending_signup).toMatchObject({ id: 1, status: 'pending' });
  });

  it('hides completed signups', async () => {
    const db = makeAppDb({
      signup: { id: 1, status: 'completed', merchant_email: 'x@y.com' },
    });
    const result = await getSetupStatus(db);
    expect(result.configured).toBe(false);
    expect(result.pending_signup).toBeNull();
  });

  it('returns configured=false when no app DB', async () => {
    const result = await getSetupStatus(null);
    expect(result.configured).toBe(false);
    expect(result.pending_signup).toBeNull();
  });
});
