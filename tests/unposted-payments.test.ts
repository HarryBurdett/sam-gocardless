import { describe, it, expect } from 'vitest';
import { getUnpostedPayments } from '../src/services/unposted-payments.js';

interface ReqRow {
  id: number;
  status: string;
  payout_id: string | null;
  invoice_refs: string | null;
  opera_account: string | null;
  amount_pence: number;
  charge_date: string | null;
}

interface StranRow {
  st_trref: string;
  st_trtype: string;
  st_trbal: number;
}

interface AentryRow {
  ae_acnt: string;
  ae_cntr: number;
  ae_cbtype: string;
  ae_entry: string;
  ae_value: number;
  ae_comment: string;
  at_type: number;
  at_inputby: string;
}

interface MockState {
  requests: ReqRow[];
  stran: StranRow[];
  aentry: AentryRow[];
}

function makeAppDb(state: MockState): any {
  const db: any = (table: string) => {
    if (table !== 'gocardless_payment_requests') {
      throw new Error(`Unexpected table: ${table}`);
    }
    let conds: Record<string, unknown> = {};
    let order: { col: string; dir: 'asc' | 'desc' } | null = null;
    let limitN = Infinity;
    const builder: any = {
      where: (cond: Record<string, unknown>) => {
        Object.assign(conds, cond);
        return builder;
      },
      orderBy: (col: string, dir: 'asc' | 'desc' = 'asc') => {
        order = { col, dir };
        return builder;
      },
      limit: (n: number) => {
        limitN = n;
        return builder;
      },
      update: async (patch: Record<string, unknown>) => {
        let count = 0;
        for (const r of state.requests) {
          if (Object.entries(conds).every(([k, v]) => (r as any)[k] === v)) {
            Object.assign(r, patch);
            count++;
          }
        }
        return count;
      },
      then: (cb: (rows: ReqRow[]) => unknown) => {
        let result = state.requests.filter((r) =>
          Object.entries(conds).every(([k, v]) => (r as any)[k] === v),
        );
        if (order) {
          const o = order;
          result = [...result].sort((a, b) => {
            const av = (a as any)[o.col];
            const bv = (b as any)[o.col];
            return o.dir === 'desc' ? bv - av : av - bv;
          });
        }
        return Promise.resolve(cb(result.slice(0, limitN)));
      },
    };
    return builder;
  };
  db.fn = { now: () => '__NOW__' };
  return db;
}

function makeOperaDb(state: MockState): any {
  function makeStran() {
    let conds: Record<string, unknown> = {};
    let absUnderTolerance = false;
    const builder: any = {
      where: (cond: Record<string, unknown>) => {
        Object.assign(conds, cond);
        return builder;
      },
      andWhereRaw: (sql: string) => {
        if (sql.includes('ABS(st_trbal)')) absUnderTolerance = true;
        return builder;
      },
      first: async () => {
        const match = state.stran.find((r) => {
          if (!Object.entries(conds).every(([k, v]) => (r as any)[k] === v)) {
            return false;
          }
          if (absUnderTolerance && Math.abs(r.st_trbal) >= 0.01) return false;
          return true;
        });
        return match;
      },
    };
    return builder;
  }
  function makeAentry() {
    let conds: Record<string, unknown> = {};
    let likeAccount: string | null = null;
    let amountPence: number | null = null;
    const builder: any = {
      innerJoin: () => builder,
      where: (cond: Record<string, unknown>) => {
        Object.assign(conds, cond);
        return builder;
      },
      andWhereRaw: (sql: string, args: any[]) => {
        if (sql.includes('LIKE')) likeAccount = String(args[0] ?? '');
        if (sql.includes('ABS(ae_value')) amountPence = Number(args[0] ?? 0);
        return builder;
      },
      first: async () => {
        const match = state.aentry.find((r) => {
          if (!Object.entries(conds).every(([k, v]) => (r as any)[k] === v)) {
            return false;
          }
          if (likeAccount) {
            const inner = likeAccount.replace(/%/g, '');
            if (!r.ae_comment.includes(inner)) return false;
          }
          if (amountPence !== null) {
            if (Math.abs(r.ae_value - amountPence) > 1) return false;
          }
          return true;
        });
        return match;
      },
    };
    return builder;
  }
  const db: any = (table: string) => {
    if (table === 'stran') return makeStran();
    if (table === 'aentry') return makeAentry();
    throw new Error(`Unexpected table: ${table}`);
  };
  db.raw = (s: string) => s;
  db.fn = { now: () => '__NOW__' };
  return db;
}

function emptyReq(over: Partial<ReqRow> = {}): ReqRow {
  return {
    id: 1,
    status: 'confirmed',
    payout_id: null,
    invoice_refs: null,
    opera_account: 'CUST01',
    amount_pence: 5000,
    charge_date: '2026-04-01',
    ...over,
  };
}

describe('getUnpostedPayments', () => {
  it('returns empty when no payment requests at all', async () => {
    const state: MockState = { requests: [], stran: [], aentry: [] };
    const result = await getUnpostedPayments(
      makeOperaDb(state),
      makeAppDb(state),
    );
    expect(result.success).toBe(true);
    expect(result.has_unposted).toBe(false);
    expect(result.unposted).toHaveLength(0);
  });

  it('skips rows whose status is not confirmed/paid_out', async () => {
    const state: MockState = {
      requests: [
        emptyReq({ id: 1, status: 'pending' }),
        emptyReq({ id: 2, status: 'cancelled' }),
        emptyReq({ id: 3, status: 'confirmed' }),
      ],
      stran: [],
      aentry: [],
    };
    const result = await getUnpostedPayments(
      makeOperaDb(state),
      makeAppDb(state),
    );
    expect(result.unposted_count).toBe(1);
    expect(result.unposted[0]?.id).toBe(3);
  });

  it('check 1: marks posted when isPayoutImported returns true', async () => {
    const state: MockState = {
      requests: [emptyReq({ id: 5, payout_id: 'PO_X' })],
      stran: [],
      aentry: [],
    };
    let called = '';
    const result = await getUnpostedPayments(
      makeOperaDb(state),
      makeAppDb(state),
      {
        isPayoutImported: async (id) => {
          called = id;
          return true;
        },
      },
    );
    expect(called).toBe('PO_X');
    expect(result.unposted_count).toBe(0);
    expect(state.requests[0]?.status).toBe('posted');
  });

  it('check 2: marks posted when invoice has st_trbal ≈ 0', async () => {
    const state: MockState = {
      requests: [
        emptyReq({ id: 5, invoice_refs: '["INV1"]' }),
      ],
      stran: [{ st_trref: 'INV1', st_trtype: 'I', st_trbal: 0.005 }],
      aentry: [],
    };
    const result = await getUnpostedPayments(
      makeOperaDb(state),
      makeAppDb(state),
    );
    expect(result.unposted_count).toBe(0);
    expect(state.requests[0]?.status).toBe('posted');
  });

  it('check 2: skips when invoice still outstanding', async () => {
    const state: MockState = {
      requests: [
        emptyReq({ id: 5, invoice_refs: '["INV1"]' }),
      ],
      stran: [{ st_trref: 'INV1', st_trtype: 'I', st_trbal: 100.0 }],
      aentry: [],
    };
    const result = await getUnpostedPayments(
      makeOperaDb(state),
      makeAppDb(state),
    );
    expect(result.unposted_count).toBe(1);
    expect(state.requests[0]?.status).toBe('confirmed');
  });

  it('check 2: caps at 3 invoice refs', async () => {
    const state: MockState = {
      requests: [
        emptyReq({
          id: 5,
          invoice_refs: '["INV1","INV2","INV3","INV4"]',
        }),
      ],
      // Only INV4 (the 4th) is fully paid — should NOT trigger because of the cap
      stran: [{ st_trref: 'INV4', st_trtype: 'I', st_trbal: 0 }],
      aentry: [],
    };
    const result = await getUnpostedPayments(
      makeOperaDb(state),
      makeAppDb(state),
    );
    expect(result.unposted_count).toBe(1);
  });

  it('check 3: marks posted when matching cashbook receipt found', async () => {
    const state: MockState = {
      requests: [
        emptyReq({ id: 5, opera_account: 'CUST01', amount_pence: 5000 }),
      ],
      stran: [],
      aentry: [
        {
          ae_acnt: 'BANK',
          ae_cntr: 1,
          ae_cbtype: 'R',
          ae_entry: 'R000001',
          ae_value: 5000,
          ae_comment: 'Receipt for CUST01',
          at_type: 4,
          at_inputby: 'GOCARDLS',
        },
      ],
    };
    const result = await getUnpostedPayments(
      makeOperaDb(state),
      makeAppDb(state),
    );
    expect(result.unposted_count).toBe(0);
    expect(state.requests[0]?.status).toBe('posted');
  });

  it('check 3: skips when amount differs by more than 1p', async () => {
    const state: MockState = {
      requests: [
        emptyReq({ id: 5, opera_account: 'CUST01', amount_pence: 5000 }),
      ],
      stran: [],
      aentry: [
        {
          ae_acnt: 'BANK',
          ae_cntr: 1,
          ae_cbtype: 'R',
          ae_entry: 'R000001',
          ae_value: 5050, // off by 50p
          ae_comment: 'CUST01',
          at_type: 4,
          at_inputby: 'GOCARDLS',
        },
      ],
    };
    const result = await getUnpostedPayments(
      makeOperaDb(state),
      makeAppDb(state),
    );
    expect(result.unposted_count).toBe(1);
  });

  it('reports unposted with amount in pounds + customer_name from lookup', async () => {
    const state: MockState = {
      requests: [
        emptyReq({
          id: 5,
          status: 'paid_out',
          opera_account: 'CUST02',
          amount_pence: 12345,
        }),
      ],
      stran: [],
      aentry: [],
    };
    const result = await getUnpostedPayments(
      makeOperaDb(state),
      makeAppDb(state),
      {
        customerNamesByAccount: new Map([['CUST02', 'Acme Ltd']]),
      },
    );
    expect(result.unposted_count).toBe(1);
    expect(result.unposted[0]?.amount).toBeCloseTo(123.45, 2);
    expect(result.unposted[0]?.customer_name).toBe('Acme Ltd');
    expect(result.has_unposted).toBe(true);
  });

  it('totals unposted amount across rows', async () => {
    const state: MockState = {
      requests: [
        emptyReq({ id: 1, amount_pence: 1500 }),
        emptyReq({ id: 2, amount_pence: 2500 }),
        emptyReq({ id: 3, amount_pence: 1000, status: 'cancelled' }),
      ],
      stran: [],
      aentry: [],
    };
    const result = await getUnpostedPayments(
      makeOperaDb(state),
      makeAppDb(state),
    );
    expect(result.unposted_total).toBe(40);
  });

  it('honours getUnprocessedBatchCount and reports has_unposted=true even with zero rows', async () => {
    const state: MockState = { requests: [], stran: [], aentry: [] };
    const result = await getUnpostedPayments(
      makeOperaDb(state),
      makeAppDb(state),
      { getUnprocessedBatchCount: async () => 3 },
    );
    expect(result.unposted_count).toBe(0);
    expect(result.unprocessed_batches).toBe(3);
    expect(result.has_unposted).toBe(true);
  });

  it('still returns success=true with empty list when DB read fails (matches Python)', async () => {
    const operaDb: any = (_t: string) => {
      const builder: any = {
        innerJoin: () => builder,
        where: () => builder,
        andWhereRaw: () => builder,
        first: () => Promise.reject(new Error('DB unavailable')),
      };
      return builder;
    };
    operaDb.raw = (s: string) => s;
    const appDb: any = (_t: string) => {
      const builder: any = {
        where: () => builder,
        orderBy: () => builder,
        limit: () => builder,
        then: (_resolve: any, reject: any) => {
          reject(new Error('DB unavailable'));
        },
      };
      return builder;
    };
    appDb.fn = { now: () => '__NOW__' };
    const result = await getUnpostedPayments(operaDb, appDb);
    expect(result.success).toBe(true);
    expect(result.has_unposted).toBe(false);
    expect(result.unposted).toHaveLength(0);
    expect(result.error).toMatch(/DB unavailable/);
  });

  it('swallows isPayoutImported errors and falls through to other checks', async () => {
    const state: MockState = {
      requests: [
        emptyReq({ id: 5, payout_id: 'PO_X', invoice_refs: '["INV1"]' }),
      ],
      stran: [{ st_trref: 'INV1', st_trtype: 'I', st_trbal: 0 }],
      aentry: [],
    };
    const result = await getUnpostedPayments(
      makeOperaDb(state),
      makeAppDb(state),
      {
        isPayoutImported: async () => {
          throw new Error('email_storage offline');
        },
      },
    );
    expect(result.unposted_count).toBe(0);
    expect(state.requests[0]?.status).toBe('posted');
  });
});
