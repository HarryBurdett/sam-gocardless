import { describe, it, expect, vi } from 'vitest';
import { gocardlessBatchPostingExecutor } from '../src/services/batch-posting-executor.js';
import type { ValidatedRequest } from '../src/services/import-batch.js';

interface SqlCall {
  sql: string;
  params?: any[];
}

interface State {
  calls: SqlCall[];
  /** Map of "table:account-or-key" -> response rows */
  responses: Record<string, any>;
}

function makeOperaDb(state: State): any {
  const raw = async (sql: string, params: any[] = []) => {
    state.calls.push({ sql, params });
    const lower = sql.toLowerCase();
    if (lower.includes('select np_nexjrnl from nparm')) {
      return [{ np_nexjrnl: 1000 }];
    }
    if (lower.includes('select nextid from nextid')) {
      const tbl = (params?.[0] ?? '').toString();
      const counters: Record<string, number> = {
        aentry: 9001,
        atran: 9002,
        stran: 9003,
        ntran: 9004,
        anoml: 9005,
      };
      return [{ nextid: counters[tbl] ?? 1 }];
    }
    if (lower.includes('select ay_entry from atype')) {
      return [{ ay_entry: 'GC00000001' }];
    }
    if (lower.includes('select 1 as x from aentry')) {
      return [];
    }
    if (lower.startsWith('select top 1 ncd_period')) {
      return [{ ncd_period: 4, ncd_year: 2026 }];
    }
    if (lower.includes('select top 1 sn_name')) {
      const acct = (params?.[0] ?? '').toString();
      return [
        {
          sn_name: `Customer ${acct}`,
          sn_region: 'K',
          sn_terrtry: '001',
          sn_custype: 'DD1',
        },
      ];
    }
    if (lower.includes('select rtrim(isnull(sp.sc_dbtctrl')) {
      return [{ control_account: 'NL1100' }];
    }
    if (lower.includes('atype') && lower.includes('ay_batched = 1') && lower.includes('gocardless')) {
      return [{ ay_cbtype: 'GC', ay_desc: 'GoCardless' }];
    }
    if (lower.includes('atype') && lower.includes('ay_batched = 1')) {
      return [{ ay_cbtype: 'GC', ay_desc: 'Cheque' }];
    }
    if (lower.includes('na_type, na_subt') && lower.includes('nacnt')) {
      return [{ na_type: 'B ', na_subt: 'BC' }];
    }
    return { rowCount: 1 };
  };

  // Builder-style call db('table').select(...).first()
  const tableBuilder = (table: string) => {
    const builder: any = {
      select: () => builder,
      where: () => builder,
      whereRaw: () => builder,
      andWhere: () => builder,
      first: async () => {
        if (table === 'sprfls') return { debtors_control: 'NL1100' };
        if (table === 'pprfls') return { creditors_control: 'NL2100' };
        if (table === 'nparm') {
          return {
            debtors_control: 'NL1100',
            creditors_control: 'NL2100',
          };
        }
        return undefined;
      },
    };
    return builder;
  };

  const db: any = (table: string) => tableBuilder(table);
  db.raw = raw;
  db.transaction = async (cb: (trx: any) => Promise<any>) => cb(db);
  return db;
}

const SAMPLE_REQUEST: ValidatedRequest = {
  bankCode: 'BC010',
  postDate: new Date(Date.UTC(2026, 3, 30)),
  postDateString: '2026-04-30',
  reference: 'GOCARDLESS-1',
  completeBatch: false,
  cbtype: null,
  goCardlessFees: 0,
  vatOnFees: 0,
  feesNominalAccount: null,
  feesVatCode: '2',
  feesPaymentType: null,
  currency: null,
  payoutId: 'po_test_1',
  source: 'api',
  destBankAccount: null,
  destBankSortCode: null,
  payments: [
    {
      customer_account: 'A001',
      customer_name: 'Acme Ltd',
      opera_customer_name: 'Acme Ltd',
      amount: 100,
      description: 'Subscription April',
      auto_allocate: true,
      gc_payment_id: 'pm_1',
      mandate_id: 'MD001',
    },
  ],
  postingBank: 'BC010',
  destinationBank: null,
  transferCbtype: null,
  emailId: null,
  warnings: [],
};

describe('gocardlessBatchPostingExecutor', () => {
  it('happy path: aentry header + atran + stran + sname + nbank inserted', async () => {
    const state: State = { calls: [], responses: {} };
    const result = await gocardlessBatchPostingExecutor.postBatch(
      makeOperaDb(state),
      SAMPLE_REQUEST,
    );
    expect(result.success).toBe(true);
    expect(result.records_imported).toBe(1);
    expect(result.batch_ref).toBe('GC00000001');
    // Verify the right INSERT statements ran
    const inserts = state.calls.filter((c) =>
      c.sql.toLowerCase().includes('insert into'),
    );
    const tables = inserts.map((c) => {
      const m = /insert into (\w+)/i.exec(c.sql);
      return m ? m[1] : '?';
    });
    expect(tables).toContain('aentry');
    expect(tables).toContain('atran');
    expect(tables).toContain('stran');
    // No ntran/anoml when complete_batch=false
    expect(tables.filter((t) => t === 'ntran').length).toBe(0);
    expect(tables.filter((t) => t === 'anoml').length).toBe(0);
    // Bank balance update
    const updates = state.calls.filter((c) =>
      c.sql.toLowerCase().includes('update nbank'),
    );
    expect(updates.length).toBe(1);
    // Customer balance update
    const sname = state.calls.filter((c) =>
      c.sql.toLowerCase().includes('update sname'),
    );
    expect(sname.length).toBe(1);
  });

  it('completeBatch=true also inserts ntran/anoml + nacnt updates', async () => {
    const state: State = { calls: [], responses: {} };
    const req: ValidatedRequest = {
      ...SAMPLE_REQUEST,
      completeBatch: true,
    };
    const result = await gocardlessBatchPostingExecutor.postBatch(
      makeOperaDb(state),
      req,
    );
    expect(result.success).toBe(true);
    const tables = state.calls
      .filter((c) => c.sql.toLowerCase().includes('insert into'))
      .map((c) => {
        const m = /insert into (\w+)/i.exec(c.sql);
        return m ? m[1] : '?';
      });
    expect(tables.filter((t) => t === 'ntran').length).toBe(2); // debit + credit
    expect(tables.filter((t) => t === 'anoml').length).toBe(2);
    expect(tables).toContain('njmemo');
  });

  it('posts a separate cashbook entry for fees', async () => {
    const state: State = { calls: [], responses: {} };
    const req: ValidatedRequest = {
      ...SAMPLE_REQUEST,
      goCardlessFees: 5.5,
      vatOnFees: 0,
      feesNominalAccount: 'GA400',
    };
    const result = await gocardlessBatchPostingExecutor.postBatch(
      makeOperaDb(state),
      req,
    );
    expect(result.success).toBe(true);
    // Two aentry inserts: receipts batch + separate fees entry
    const aentryInserts = state.calls.filter((c) =>
      /insert into aentry/i.test(c.sql),
    );
    expect(aentryInserts.length).toBe(2);
  });

  it('posts paired transfer when destinationBank is set', async () => {
    const state: State = { calls: [], responses: {} };
    const req: ValidatedRequest = {
      ...SAMPLE_REQUEST,
      destinationBank: 'BC020',
    };
    const result = await gocardlessBatchPostingExecutor.postBatch(
      makeOperaDb(state),
      req,
    );
    expect(result.success).toBe(true);
    // Receipts aentry + source-side transfer aentry + dest-side transfer aentry
    const aentryInserts = state.calls.filter((c) =>
      /insert into aentry/i.test(c.sql),
    );
    expect(aentryInserts.length).toBe(3);
  });

  it('returns error when control accounts not configured', async () => {
    const failingDb: any = (_table: string) => {
      const builder: any = {
        select: () => builder,
        first: async () => undefined, // no rows = no control account
      };
      return builder;
    };
    failingDb.raw = async () => [];
    failingDb.transaction = async (cb: (trx: any) => Promise<any>) =>
      cb(failingDb);
    const result = await gocardlessBatchPostingExecutor.postBatch(
      failingDb,
      SAMPLE_REQUEST,
    );
    expect(result.success).toBe(false);
    expect(result.errors[0]).toMatch(/control account/i);
  });
});
