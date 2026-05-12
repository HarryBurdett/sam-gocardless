import { describe, it, expect } from 'vitest';
import { getDueInvoices } from '../src/services/due-invoices.js';

interface InvoiceRow {
  st_account: string;
  sn_name: string;
  sn_email: string | null;
  st_trref: string;
  st_trdate: string;
  st_dueday: string | null;
  st_trtype: string;
  st_trbal: number;
  st_trvalue: number;
  st_custref: string;
  is_sub: number;
}

interface CreditRow {
  st_account: string;
  unallocated_credit: number;
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
  id: number;
  status: string;
  charge_date: string | null;
  amount_pence: number | null;
  invoice_refs: string | null;
}

interface MockState {
  invoices: InvoiceRow[];
  credit: CreditRow[];
  mandates: MandateRow[];
  subs: SubRow[];
  requests: ReqRow[];
}

function makeOperaDb(state: MockState): any {
  function makeBuilder() {
    let mode: 'invoices' | 'credit' = 'credit';
    const builder: any = {
      innerJoin: () => {
        mode = 'invoices';
        return builder;
      },
      where: () => builder,
      andWhere: () => builder,
      whereIn: () => builder,
      whereRaw: () => builder,
      andWhereRaw: () => builder,
      groupBy: () => builder,
      orderBy: () => builder,
      select: async (..._cols: any[]) => {
        if (mode === 'credit') return state.credit;
        return state.invoices;
      },
    };
    return builder;
  }
  const db: any = (table: string) => {
    if (table !== 'stran') throw new Error(`Unexpected table: ${table}`);
    return makeBuilder();
  };
  db.raw = (sql: string, _args?: any[]) => sql;
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

function emptyInvoice(over: Partial<InvoiceRow> = {}): InvoiceRow {
  return {
    st_account: 'CUST01',
    sn_name: 'Acme Ltd',
    sn_email: 'a@b.com',
    st_trref: 'INV001',
    st_trdate: '2026-04-01',
    st_dueday: '2026-04-30',
    st_trtype: 'I',
    st_trbal: 100,
    st_trvalue: 120,
    st_custref: 'PO-123',
    is_sub: 0,
    ...over,
  };
}

const TODAY = new Date('2026-05-09T00:00:00Z');

describe('getDueInvoices', () => {
  it('returns empty result when no active mandates exist', async () => {
    const state: MockState = {
      invoices: [emptyInvoice()],
      credit: [],
      mandates: [],
      subs: [],
      requests: [],
    };
    const result = await getDueInvoices(
      makeOperaDb(state),
      makeAppDb(state),
      {},
      TODAY,
    );
    expect(result.success).toBe(true);
    expect(result.customers).toHaveLength(0);
    expect(result.invoices).toHaveLength(0);
    expect(result.advance_date).toBe('2026-05-09');
  });

  it('returns invoices grouped by customer with mandate enrichment', async () => {
    const state: MockState = {
      invoices: [
        emptyInvoice({ st_trref: 'INV1', st_trbal: 100 }),
        emptyInvoice({ st_trref: 'INV2', st_trbal: 200 }),
      ],
      credit: [],
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
    const result = await getDueInvoices(
      makeOperaDb(state),
      makeAppDb(state),
      {},
      TODAY,
    );
    expect(result.customers).toHaveLength(1);
    expect(result.customers[0]?.invoice_count).toBe(2);
    expect(result.customers[0]?.total_due).toBe(300);
    expect(result.summary.collectable_amount).toBe(300);
  });

  it('rejects malformed advance_date', async () => {
    const state: MockState = {
      invoices: [],
      credit: [],
      mandates: [{ opera_account: 'CUST01', mandate_id: 'MD1', mandate_status: 'active' }],
      subs: [],
      requests: [],
    };
    const result = await getDueInvoices(
      makeOperaDb(state),
      makeAppDb(state),
      { advanceDate: 'not-a-date' },
      TODAY,
    );
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/Invalid date format/);
  });

  it('honours advance_date filter (excludes invoices due after the window)', async () => {
    const state: MockState = {
      invoices: [
        emptyInvoice({ st_trref: 'INV_NEAR', st_dueday: '2026-05-15' }),
        emptyInvoice({ st_trref: 'INV_FAR', st_dueday: '2026-06-30' }),
      ],
      credit: [],
      mandates: [{ opera_account: 'CUST01', mandate_id: 'MD1', mandate_status: 'active' }],
      subs: [],
      requests: [],
    };
    const result = await getDueInvoices(
      makeOperaDb(state),
      makeAppDb(state),
      { advanceDate: '2026-05-31' },
      TODAY,
    );
    expect(result.invoices).toHaveLength(1);
    expect(result.invoices[0]?.invoice_ref).toBe('INV_NEAR');
  });

  it('include_future=false excludes not-yet-overdue invoices', async () => {
    const state: MockState = {
      invoices: [
        emptyInvoice({ st_trref: 'INV_FUTURE', st_dueday: '2026-05-20' }),
        emptyInvoice({ st_trref: 'INV_OVERDUE', st_dueday: '2026-04-30' }),
      ],
      credit: [],
      mandates: [{ opera_account: 'CUST01', mandate_id: 'MD1', mandate_status: 'active' }],
      subs: [],
      requests: [],
    };
    const result = await getDueInvoices(
      makeOperaDb(state),
      makeAppDb(state),
      { includeFuture: false, advanceDate: '2026-05-31' },
      TODAY,
    );
    expect(result.invoices).toHaveLength(1);
    expect(result.invoices[0]?.invoice_ref).toBe('INV_OVERDUE');
  });

  it('flags payment_requested when an active request covers the invoice', async () => {
    const state: MockState = {
      invoices: [emptyInvoice({ st_trref: 'INV1' })],
      credit: [],
      mandates: [{ opera_account: 'CUST01', mandate_id: 'MD1', mandate_status: 'active' }],
      subs: [],
      requests: [
        {
          id: 1,
          status: 'pending_submission',
          charge_date: '2026-05-15',
          amount_pence: 12000,
          invoice_refs: '["INV1"]',
        },
      ],
    };
    const result = await getDueInvoices(
      makeOperaDb(state),
      makeAppDb(state),
      {},
      TODAY,
    );
    expect(result.invoices[0]?.payment_requested).toBe(true);
    expect(result.invoices[0]?.payment_request_info?.status).toBe(
      'pending_submission',
    );
  });

  it('does not flag payment_requested for cancelled/failed/charged_back', async () => {
    const state: MockState = {
      invoices: [emptyInvoice({ st_trref: 'INV1' })],
      credit: [],
      mandates: [{ opera_account: 'CUST01', mandate_id: 'MD1', mandate_status: 'active' }],
      subs: [],
      requests: [
        {
          id: 1,
          status: 'cancelled',
          charge_date: null,
          amount_pence: null,
          invoice_refs: '["INV1"]',
        },
      ],
    };
    const result = await getDueInvoices(
      makeOperaDb(state),
      makeAppDb(state),
      {},
      TODAY,
    );
    expect(result.invoices[0]?.payment_requested).toBe(false);
  });

  it('attaches unallocated_credit per customer and skips < £0.01', async () => {
    const state: MockState = {
      invoices: [
        emptyInvoice({ st_account: 'CUST01' }),
        emptyInvoice({ st_account: 'CUST02', sn_name: 'Beta Co' }),
      ],
      credit: [
        { st_account: 'CUST01', unallocated_credit: -25.5 },
        { st_account: 'CUST02', unallocated_credit: -0.005 },
      ],
      mandates: [
        { opera_account: 'CUST01', mandate_id: 'MD1', mandate_status: 'active' },
        { opera_account: 'CUST02', mandate_id: 'MD2', mandate_status: 'active' },
      ],
      subs: [],
      requests: [],
    };
    const result = await getDueInvoices(
      makeOperaDb(state),
      makeAppDb(state),
      {},
      TODAY,
    );
    const c1 = result.customers.find((c) => c.account === 'CUST01');
    const c2 = result.customers.find((c) => c.account === 'CUST02');
    expect(c1?.unallocated_credit).toBe(25.5);
    expect(c1?.unallocated_credit_formatted).toBe('£25.50');
    expect(c2?.unallocated_credit).toBe(0);
    expect(c2?.unallocated_credit_formatted).toBeNull();
  });

  it('subscriptions are tagged but excluded from collectable_amount', async () => {
    const state: MockState = {
      invoices: [
        emptyInvoice({ st_trref: 'INV_SUB', st_trbal: 50, is_sub: 1 }),
        emptyInvoice({ st_trref: 'INV_NORMAL', st_trbal: 100, is_sub: 0 }),
      ],
      credit: [],
      mandates: [{ opera_account: 'CUST01', mandate_id: 'MD1', mandate_status: 'active' }],
      subs: [
        {
          opera_account: 'CUST01',
          source_doc: 'DOC1',
          status: 'active',
        },
      ],
      requests: [],
    };
    const result = await getDueInvoices(
      makeOperaDb(state),
      makeAppDb(state),
      {},
      TODAY,
    );
    const subInvoice = result.invoices.find((i) => i.invoice_ref === 'INV_SUB');
    expect(subInvoice?.is_subscription).toBe(true);
    expect(subInvoice?.source_doc).toBe('DOC1');
    expect(result.summary.collectable_amount).toBe(100); // only INV_NORMAL
  });

  it('uses fetchExternalPendingPayments to enrich payment_requested', async () => {
    const state: MockState = {
      invoices: [emptyInvoice({ st_trref: 'INV1' })],
      credit: [],
      mandates: [{ opera_account: 'CUST01', mandate_id: 'MD1', mandate_status: 'active' }],
      subs: [],
      requests: [],
    };
    const result = await getDueInvoices(
      makeOperaDb(state),
      makeAppDb(state),
      {
        fetchExternalPendingPayments: async () => [
          {
            ref: 'INV1',
            info: {
              request_id: 'PM_GC',
              status: 'submitted',
              charge_date: '2026-05-15',
              amount_pence: 10000,
              source: 'gocardless_api',
            },
          },
        ],
      },
      TODAY,
    );
    expect(result.invoices[0]?.payment_requested).toBe(true);
    expect(result.invoices[0]?.payment_request_info?.source).toBe(
      'gocardless_api',
    );
  });

  it('swallows errors from fetchExternalPendingPayments', async () => {
    const state: MockState = {
      invoices: [emptyInvoice({ st_trref: 'INV1' })],
      credit: [],
      mandates: [{ opera_account: 'CUST01', mandate_id: 'MD1', mandate_status: 'active' }],
      subs: [],
      requests: [],
    };
    const result = await getDueInvoices(
      makeOperaDb(state),
      makeAppDb(state),
      {
        fetchExternalPendingPayments: async () => {
          throw new Error('GC API down');
        },
      },
      TODAY,
    );
    expect(result.success).toBe(true);
    expect(result.invoices[0]?.payment_requested).toBe(false);
  });

  it('sorts customers alphabetically by name', async () => {
    const state: MockState = {
      invoices: [
        emptyInvoice({ st_account: 'CUST01', sn_name: 'Charlie' }),
        emptyInvoice({ st_account: 'CUST02', sn_name: 'Alpha' }),
        emptyInvoice({ st_account: 'CUST03', sn_name: 'Bravo' }),
      ],
      credit: [],
      mandates: [
        { opera_account: 'CUST01', mandate_id: 'MD1', mandate_status: 'active' },
        { opera_account: 'CUST02', mandate_id: 'MD2', mandate_status: 'active' },
        { opera_account: 'CUST03', mandate_id: 'MD3', mandate_status: 'active' },
      ],
      subs: [],
      requests: [],
    };
    const result = await getDueInvoices(
      makeOperaDb(state),
      makeAppDb(state),
      {},
      TODAY,
    );
    expect(result.customers.map((c) => c.name)).toEqual([
      'Alpha',
      'Bravo',
      'Charlie',
    ]);
  });
});
