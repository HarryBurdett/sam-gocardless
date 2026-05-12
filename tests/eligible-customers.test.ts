import { describe, it, expect } from 'vitest';
import { getEligibleCustomers } from '../src/services/eligible-customers.js';

interface MandateRow {
  opera_account: string;
  mandate_id: string;
  mandate_status: string;
}

interface SnameRow {
  sn_account: string;
  sn_name: string;
  sn_analsys: string;
  sn_currbal: number;
  sn_email: string;
}

interface MockState {
  mandates: MandateRow[];
  customers: SnameRow[];
}

function makeAppDb(state: MockState): any {
  const db: any = (table: string) => {
    if (table !== 'gocardless_mandates') {
      throw new Error(`Unexpected app table: ${table}`);
    }
    let neqConds: Array<{ col: string; val: unknown }> = [];
    const builder: any = {
      where: (col: string, op: string, val: unknown) => {
        if (op === '!=') neqConds.push({ col, val });
        return builder;
      },
      select: (..._cols: string[]) => {
        const rows = state.mandates.filter((r) =>
          neqConds.every((nc) => (r as any)[nc.col] !== nc.val),
        );
        return Promise.resolve(rows);
      },
    };
    return builder;
  };
  return db;
}

function makeOperaDb(state: MockState): any {
  return {
    raw: (sql: string, params?: unknown[]) => {
      // Filter customers by:
      // - sn_analsys='GC' OR sn_account in (params)
      const accounts = (params ?? []) as string[];
      const matched = state.customers.filter((c) => {
        const isGC = (c.sn_analsys ?? '').trim().toUpperCase() === 'GC';
        const inMandated = accounts.includes(c.sn_account);
        return isGC || inMandated;
      });
      // Sort by sn_name
      matched.sort((a, b) =>
        (a.sn_name ?? '').localeCompare(b.sn_name ?? ''),
      );
      return Promise.resolve(matched);
    },
  };
}

describe('getEligibleCustomers', () => {
  it('returns flagged customers (sn_analsys=GC) when no mandates exist', async () => {
    const state: MockState = {
      mandates: [],
      customers: [
        { sn_account: 'CUST01', sn_name: 'Acme', sn_analsys: 'GC', sn_currbal: 100, sn_email: 'a@a.com' },
        { sn_account: 'CUST02', sn_name: 'Other', sn_analsys: '', sn_currbal: 0, sn_email: '' },
      ],
    };
    const result = await getEligibleCustomers(
      makeAppDb(state),
      makeOperaDb(state),
    );
    expect(result.success).toBe(true);
    expect(result.count).toBe(1);
    expect(result.customers[0]?.account).toBe('CUST01');
    expect(result.customers[0]?.has_mandate).toBe(false);
  });

  it('includes mandated customers even if not flagged', async () => {
    const state: MockState = {
      mandates: [
        {
          opera_account: 'CUST_M',
          mandate_id: 'MD_X',
          mandate_status: 'active',
        },
      ],
      customers: [
        { sn_account: 'CUST_M', sn_name: 'Mandated', sn_analsys: '', sn_currbal: 50, sn_email: 'm@m.com' },
      ],
    };
    const result = await getEligibleCustomers(
      makeAppDb(state),
      makeOperaDb(state),
    );
    expect(result.count).toBe(1);
    expect(result.customers[0]?.has_mandate).toBe(true);
    expect(result.customers[0]?.mandate_id).toBe('MD_X');
    expect(result.customers[0]?.mandate_status).toBe('active');
  });

  it('dedups customers appearing in both populations', async () => {
    const state: MockState = {
      mandates: [
        {
          opera_account: 'CUST01',
          mandate_id: 'MD_X',
          mandate_status: 'active',
        },
      ],
      customers: [
        // Same account appears twice in the SQL (once for GC flag,
        // once for mandate include) — dedup should keep one
        { sn_account: 'CUST01', sn_name: 'Acme', sn_analsys: 'GC', sn_currbal: 100, sn_email: 'a@a.com' },
        { sn_account: 'CUST01', sn_name: 'Acme', sn_analsys: 'GC', sn_currbal: 100, sn_email: 'a@a.com' },
      ],
    };
    const result = await getEligibleCustomers(
      makeAppDb(state),
      makeOperaDb(state),
    );
    expect(result.count).toBe(1);
    expect(result.customers[0]?.has_mandate).toBe(true);
  });

  it('skips __UNLINKED__ mandates from the lookup', async () => {
    const state: MockState = {
      mandates: [
        {
          opera_account: '__UNLINKED__',
          mandate_id: 'MD_RAW',
          mandate_status: 'active',
        },
      ],
      customers: [
        { sn_account: 'CUST01', sn_name: 'Acme', sn_analsys: 'GC', sn_currbal: 0, sn_email: '' },
      ],
    };
    const result = await getEligibleCustomers(
      makeAppDb(state),
      makeOperaDb(state),
    );
    expect(result.customers[0]?.has_mandate).toBe(false);
  });
});
