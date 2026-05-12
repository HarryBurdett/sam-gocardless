import { describe, it, expect } from 'vitest';
import { getCollectableInvoices } from '../src/services/collectable-invoices.js';

interface StranRow {
  st_account: string;
  sn_name: string;
  st_trref: string;
  st_trdate: string;
  st_dueday: string | null;
  st_trtype: string;
  st_trbal: number;
}

interface MandateRow {
  opera_account: string;
  mandate_id: string;
  mandate_status: string;
}

interface SubRow {
  opera_account: string;
  source_doc: string | null;
  status: string;
}

interface ReqRow {
  status: string;
  invoice_refs: string | null;
}

interface MockState {
  stran: StranRow[];
  mandates: MandateRow[];
  subs: SubRow[];
  requests: ReqRow[];
}

function makeOperaDb(state: MockState): any {
  const db: any = (table: string) => {
    if (table !== 'stran') throw new Error(`Unexpected table: ${table}`);
    let cmpConds: Array<{ col: string; op: string; val: any }> = [];
    let conds: Record<string, unknown> = {};
    const builder: any = {
      innerJoin: () => builder,
      where: (col: any, op?: any, val?: any) => {
        if (typeof col === 'string') {
          if (op !== undefined && val !== undefined) {
            cmpConds.push({ col, op, val });
          } else {
            conds[col] = op;
          }
        } else {
          Object.assign(conds, col);
        }
        return builder;
      },
      andWhere: (col: any, op?: any, val?: any) => builder.where(col, op, val),
      orderBy: () => builder,
      select: async (..._cols: any[]) => {
        return state.stran.filter((r) => {
          for (const c of cmpConds) {
            const lhs = (r as any)[c.col];
            if (c.op === '>') {
              if (!(Number(lhs) > Number(c.val))) return false;
            } else if (c.op === '>=') {
              if (!(Number(lhs) >= Number(c.val))) return false;
            }
          }
          for (const [k, v] of Object.entries(conds)) {
            if ((r as any)[k] !== v) return false;
          }
          return true;
        });
      },
    };
    return builder;
  };
  db.raw = (s: string) => s;
  return db;
}

function makeAppDb(state: MockState): any {
  const db: any = (table: string) => {
    let conds: Record<string, unknown> = {};
    const builder: any = {
      where: (cond: Record<string, unknown>) => {
        Object.assign(conds, cond);
        return builder;
      },
      select: async (..._cols: string[]) => {
        if (table === 'gocardless_mandates') {
          return state.mandates.filter((r) =>
            Object.entries(conds).every(([k, v]) => (r as any)[k] === v),
          );
        }
        if (table === 'gocardless_subscriptions') return state.subs;
        if (table === 'gocardless_payment_requests') return state.requests;
        throw new Error(`Unexpected table: ${table}`);
      },
    };
    return builder;
  };
  db.fn = { now: () => '__NOW__' };
  return db;
}

function emptyStran(over: Partial<StranRow> = {}): StranRow {
  return {
    st_account: 'CUST01',
    sn_name: 'Acme Ltd',
    st_trref: 'INV001',
    st_trdate: '2026-04-01',
    st_dueday: '2026-04-30',
    st_trtype: 'I',
    st_trbal: 100,
    ...over,
  };
}

const TODAY = new Date('2026-05-09T00:00:00Z');

describe('getCollectableInvoices', () => {
  it('returns outstanding invoices with mandate enrichment', async () => {
    const state: MockState = {
      stran: [emptyStran()],
      mandates: [
        {
          opera_account: 'CUST01',
          mandate_id: 'MD1',
          mandate_status: 'active',
        },
      ],
      subs: [],
      requests: [],
    };
    const result = await getCollectableInvoices(
      makeOperaDb(state),
      makeAppDb(state),
      {},
      TODAY,
    );
    expect(result.success).toBe(true);
    expect(result.count).toBe(1);
    expect(result.invoices[0]?.has_mandate).toBe(true);
    expect(result.invoices[0]?.mandate_id).toBe('MD1');
    expect(result.mandates_available).toBe(1);
  });

  it('flags overdue rows + computes days_overdue from due_date', async () => {
    const state: MockState = {
      stran: [
        emptyStran({ st_trref: 'INV1', st_dueday: '2026-04-30' }), // 9 days overdue at TODAY
      ],
      mandates: [],
      subs: [],
      requests: [],
    };
    const result = await getCollectableInvoices(
      makeOperaDb(state),
      makeAppDb(state),
      {},
      TODAY,
    );
    expect(result.invoices[0]?.is_overdue).toBe(true);
    expect(result.invoices[0]?.days_overdue).toBe(9);
  });

  it('overdueOnly=true skips not-yet-overdue invoices', async () => {
    const state: MockState = {
      stran: [
        emptyStran({ st_trref: 'INV1', st_dueday: '2026-06-30' }), // future
        emptyStran({ st_trref: 'INV2', st_dueday: '2026-04-01' }), // overdue
      ],
      mandates: [],
      subs: [],
      requests: [],
    };
    const result = await getCollectableInvoices(
      makeOperaDb(state),
      makeAppDb(state),
      { overdueOnly: true },
      TODAY,
    );
    expect(result.count).toBe(1);
    expect(result.invoices[0]?.invoice_ref).toBe('INV2');
  });

  it('flags payment_requested when invoice already covered by an active request', async () => {
    const state: MockState = {
      stran: [emptyStran({ st_trref: 'INV1' })],
      mandates: [],
      subs: [],
      requests: [
        { status: 'pending', invoice_refs: '["INV1","INV2"]' },
      ],
    };
    const result = await getCollectableInvoices(
      makeOperaDb(state),
      makeAppDb(state),
      {},
      TODAY,
    );
    expect(result.invoices[0]?.payment_requested).toBe(true);
  });

  it('does NOT flag payment_requested when only cancelled/failed requests exist', async () => {
    const state: MockState = {
      stran: [emptyStran({ st_trref: 'INV1' })],
      mandates: [],
      subs: [],
      requests: [
        { status: 'cancelled', invoice_refs: '["INV1"]' },
        { status: 'failed', invoice_refs: '["INV1"]' },
        { status: 'charged_back', invoice_refs: '["INV1"]' },
      ],
    };
    const result = await getCollectableInvoices(
      makeOperaDb(state),
      makeAppDb(state),
      {},
      TODAY,
    );
    expect(result.invoices[0]?.payment_requested).toBe(false);
  });

  it('totals collectable amount and mandate-covered amount separately', async () => {
    const state: MockState = {
      stran: [
        emptyStran({
          st_account: 'CUST01',
          st_trref: 'A',
          st_trbal: 100,
        }),
        emptyStran({
          st_account: 'CUST02',
          st_trref: 'B',
          st_trbal: 250,
        }),
      ],
      mandates: [
        {
          opera_account: 'CUST01',
          mandate_id: 'MD1',
          mandate_status: 'active',
        },
      ],
      subs: [],
      requests: [],
    };
    const result = await getCollectableInvoices(
      makeOperaDb(state),
      makeAppDb(state),
      {},
      TODAY,
    );
    expect(result.total_collectable).toBe(350);
    expect(result.total_with_mandate).toBe(100);
    expect(result.total_collectable_formatted).toBe('£350.00');
    expect(result.total_with_mandate_formatted).toBe('£100.00');
  });

  it('formats amount with thousand separators', async () => {
    const state: MockState = {
      stran: [emptyStran({ st_trbal: 1234567.89 })],
      mandates: [],
      subs: [],
      requests: [],
    };
    const result = await getCollectableInvoices(
      makeOperaDb(state),
      makeAppDb(state),
      {},
      TODAY,
    );
    expect(result.invoices[0]?.amount_formatted).toBe('£1,234,567.89');
  });

  it('treats unmatched mandates correctly (excludes __UNLINKED__)', async () => {
    const state: MockState = {
      stran: [emptyStran({ st_account: 'CUST01' })],
      mandates: [
        {
          opera_account: '__UNLINKED__',
          mandate_id: 'MD_UNL',
          mandate_status: 'active',
        },
      ],
      subs: [],
      requests: [],
    };
    const result = await getCollectableInvoices(
      makeOperaDb(state),
      makeAppDb(state),
      {},
      TODAY,
    );
    expect(result.invoices[0]?.has_mandate).toBe(false);
    expect(result.mandates_available).toBe(0);
  });

  it('reports DB error gracefully', async () => {
    const operaDb: any = (_t: string) => {
      const builder: any = {
        innerJoin: () => builder,
        where: () => builder,
        andWhere: () => builder,
        orderBy: () => builder,
        select: () => Promise.reject(new Error('DB unavailable')),
      };
      return builder;
    };
    operaDb.raw = (s: string) => s;
    const appDb: any = (_t: string) => {
      const builder: any = {
        where: () => builder,
        select: async () => [],
      };
      return builder;
    };
    appDb.fn = { now: () => '__NOW__' };
    const result = await getCollectableInvoices(operaDb, appDb, {}, TODAY);
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/DB unavailable/);
  });
});
