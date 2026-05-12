import { describe, it, expect } from 'vitest';
import {
  listPaymentRequests,
  getPaymentRequest,
  cancelPaymentRequest,
  syncPaymentStatuses,
} from '../src/services/payment-requests.js';

interface RequestRow {
  id: number;
  payment_id: string;
  mandate_id: string;
  opera_account: string;
  amount: number;
  amount_pence: number | null;
  currency: string;
  status: string;
  reference: string;
  charge_date: string;
  payout_id: string;
  invoice_refs: string;
  opera_receipt_ref: string;
  error_message: string;
  created_at: string;
  updated_at: string;
}

interface MandateRow {
  opera_account: string;
  opera_name: string;
}

interface MockState {
  requests: RequestRow[];
  mandates: MandateRow[];
}

function makeAppDb(state: MockState): any {
  const db: any = (table: string) => {
    let conds: Record<string, unknown> = {};
    let inCol: string | null = null;
    let inVals: unknown[] | null = null;
    let limitN = Infinity;
    let order: { col: string; dir: 'asc' | 'desc' } | null = null;
    let selectedCols: string[] | null = null;
    if (table === 'gocardless_payment_requests') {
      const builder: any = {
        where: (cond: Record<string, unknown>) => {
          Object.assign(conds, cond);
          return builder;
        },
        whereIn: (col: string, vals: unknown[]) => {
          inCol = col;
          inVals = vals;
          return builder;
        },
        select: (..._cols: string[]) => {
          let rows = state.requests.filter((r) =>
            Object.entries(conds).every(([k, v]) => (r as any)[k] === v),
          );
          if (inCol && inVals) {
            rows = rows.filter((r) =>
              inVals!.includes((r as any)[inCol!]),
            );
          }
          return Promise.resolve(rows);
        },
        orderBy: (col: string, dir: 'asc' | 'desc' = 'asc') => {
          order = { col, dir };
          return builder;
        },
        limit: (n: number) => {
          limitN = n;
          return builder;
        },
        first: () => {
          const found = state.requests.find((r) =>
            Object.entries(conds).every(([k, v]) => (r as any)[k] === v),
          );
          return Promise.resolve(found);
        },
        update: (data: Record<string, unknown>) => {
          let count = 0;
          for (const r of state.requests) {
            if (
              Object.entries(conds).every(([k, v]) => (r as any)[k] === v)
            ) {
              Object.assign(r, data);
              count++;
            }
          }
          return Promise.resolve(count);
        },
        then: (cb: (rows: RequestRow[]) => unknown) => {
          let rows = state.requests.filter((r) =>
            Object.entries(conds).every(([k, v]) => (r as any)[k] === v),
          );
          if (order) {
            rows = [...rows].sort((a, b) => {
              const cmp = String((a as any)[order!.col]).localeCompare(
                String((b as any)[order!.col]),
              );
              return order!.dir === 'desc' ? -cmp : cmp;
            });
          }
          return Promise.resolve(cb(rows.slice(0, limitN)));
        },
      };
      return builder;
    }
    if (table === 'gocardless_mandates') {
      const builder: any = {
        whereIn: (col: string, vals: unknown[]) => {
          inCol = col;
          inVals = vals;
          return builder;
        },
        where: (cond: Record<string, unknown>) => {
          Object.assign(conds, cond);
          return builder;
        },
        first: () => {
          const found = state.mandates.find((m) =>
            Object.entries(conds).every(([k, v]) => (m as any)[k] === v),
          );
          return Promise.resolve(found);
        },
        select: (...cols: string[]) => {
          selectedCols = cols;
          const rows = state.mandates.filter(
            (m) =>
              !inCol || (inVals && inVals.includes((m as any)[inCol!])),
          );
          return Promise.resolve(rows);
        },
      };
      return builder;
    }
    throw new Error(`Unexpected table: ${table}`);
  };
  db.fn = { now: () => new Date() };
  return db;
}

function emptyRequest(over: Partial<RequestRow> = {}): RequestRow {
  return {
    id: 1,
    payment_id: 'PR_X',
    mandate_id: 'MD_X',
    opera_account: 'CUST01',
    amount: 100,
    amount_pence: 10000,
    currency: 'GBP',
    status: 'pending',
    reference: '',
    charge_date: '2026-04-15',
    payout_id: '',
    invoice_refs: '',
    opera_receipt_ref: '',
    error_message: '',
    created_at: '2026-04-15T10:00:00Z',
    updated_at: '2026-04-15T10:00:00Z',
    ...over,
  };
}

describe('listPaymentRequests', () => {
  it('returns requests in created_at desc order', async () => {
    const state: MockState = {
      requests: [
        emptyRequest({ id: 1, created_at: '2026-04-10T10:00:00Z' }),
        emptyRequest({ id: 2, created_at: '2026-04-15T10:00:00Z' }),
        emptyRequest({ id: 3, created_at: '2026-04-12T10:00:00Z' }),
      ],
      mandates: [],
    };
    const result = await listPaymentRequests(makeAppDb(state));
    expect(result.success).toBe(true);
    expect(result.count).toBe(3);
    expect(result.requests[0]?.id).toBe(2);
  });

  it('filters by status', async () => {
    const state: MockState = {
      requests: [
        emptyRequest({ id: 1, status: 'pending' }),
        emptyRequest({ id: 2, status: 'paid_out' }),
      ],
      mandates: [],
    };
    const result = await listPaymentRequests(makeAppDb(state), {
      status: 'paid_out',
    });
    expect(result.count).toBe(1);
    expect(result.requests[0]?.status).toBe('paid_out');
  });

  it('filters by opera_account', async () => {
    const state: MockState = {
      requests: [
        emptyRequest({ id: 1, opera_account: 'A' }),
        emptyRequest({ id: 2, opera_account: 'B' }),
      ],
      mandates: [],
    };
    const result = await listPaymentRequests(makeAppDb(state), {
      operaAccount: 'A',
    });
    expect(result.count).toBe(1);
  });

  it('respects limit', async () => {
    const state: MockState = {
      requests: Array.from({ length: 5 }, (_, i) =>
        emptyRequest({ id: i + 1, created_at: `2026-04-${10 + i}` }),
      ),
      mandates: [],
    };
    const result = await listPaymentRequests(makeAppDb(state), { limit: 2 });
    expect(result.count).toBe(2);
  });

  it('enriches with customer_name from mandates', async () => {
    const state: MockState = {
      requests: [
        emptyRequest({ id: 1, opera_account: 'A' }),
        emptyRequest({ id: 2, opera_account: 'B' }),
      ],
      mandates: [
        { opera_account: 'A', opera_name: 'Acme Ltd' },
        { opera_account: 'B', opera_name: 'Beta Co' },
      ],
    };
    const result = await listPaymentRequests(makeAppDb(state));
    const aReq = result.requests.find((r) => r.opera_account === 'A');
    expect(aReq?.customer_name).toBe('Acme Ltd');
  });

  it('falls back to opera_account when mandate not found', async () => {
    const state: MockState = {
      requests: [emptyRequest({ id: 1, opera_account: 'CUST01' })],
      mandates: [],
    };
    const result = await listPaymentRequests(makeAppDb(state));
    expect(result.requests[0]?.customer_name).toBe('CUST01');
  });
});

describe('getPaymentRequest', () => {
  it('returns the row with mandate-derived customer_name', async () => {
    const state: MockState = {
      requests: [emptyRequest({ id: 7, opera_account: 'CUST01' })],
      mandates: [{ opera_account: 'CUST01', opera_name: 'Acme Ltd' }],
    };
    const result = await getPaymentRequest(makeAppDb(state), 7);
    expect(result.success).toBe(true);
    expect(result.payment_request?.id).toBe(7);
    expect(result.payment_request?.customer_name).toBe('Acme Ltd');
  });

  it('returns 404 when not found', async () => {
    const state: MockState = { requests: [], mandates: [] };
    const result = await getPaymentRequest(makeAppDb(state), 999);
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/not found/);
  });

  it('rejects bad request_id', async () => {
    const state: MockState = { requests: [], mandates: [] };
    const result = await getPaymentRequest(makeAppDb(state), 0);
    expect(result.success).toBe(false);
  });
});

describe('cancelPaymentRequest', () => {
  it('cancels a pending request — local + remote attempt', async () => {
    const state: MockState = {
      requests: [
        emptyRequest({
          id: 1,
          status: 'pending',
          payment_id: 'PR_X',
        }),
      ],
      mandates: [],
    };
    let remoteCalledWith: string | null = null;
    const cancelRemote = async (paymentId: string) => {
      remoteCalledWith = paymentId;
      return { success: true };
    };
    const result = await cancelPaymentRequest(
      makeAppDb(state),
      1,
      cancelRemote,
    );
    expect(result.success).toBe(true);
    expect(result.local_cancelled).toBe(true);
    expect(remoteCalledWith).toBe('PR_X');
    expect(state.requests[0]?.status).toBe('cancelled');
  });

  it('proceeds with local cancel even when remote fails (logs warning)', async () => {
    const state: MockState = {
      requests: [
        emptyRequest({
          id: 1,
          status: 'pending_submission',
          payment_id: 'PR_Y',
        }),
      ],
      mandates: [],
    };
    const cancelRemote = async () => ({
      success: false,
      error: 'GoCardless rejected',
    });
    const result = await cancelPaymentRequest(
      makeAppDb(state),
      1,
      cancelRemote,
    );
    expect(result.success).toBe(true);
    expect(result.local_cancelled).toBe(true);
    expect(result.remote_warning).toMatch(/GoCardless rejected/);
    expect(state.requests[0]?.status).toBe('cancelled');
  });

  it('refuses cancellation when status is final', async () => {
    const state: MockState = {
      requests: [
        emptyRequest({ id: 1, status: 'paid_out', payment_id: 'PR_Z' }),
      ],
      mandates: [],
    };
    const result = await cancelPaymentRequest(makeAppDb(state), 1);
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/Cannot cancel/);
  });

  it('returns not-found when id missing', async () => {
    const state: MockState = { requests: [], mandates: [] };
    const result = await cancelPaymentRequest(makeAppDb(state), 999);
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/not found/);
  });

  it('skips remote cancel when payment_id is empty', async () => {
    const state: MockState = {
      requests: [
        emptyRequest({ id: 1, status: 'pending', payment_id: '' }),
      ],
      mandates: [],
    };
    let remoteCalled = false;
    const cancelRemote = async () => {
      remoteCalled = true;
      return { success: true };
    };
    const result = await cancelPaymentRequest(
      makeAppDb(state),
      1,
      cancelRemote,
    );
    expect(result.success).toBe(true);
    expect(remoteCalled).toBe(false);
    expect(state.requests[0]?.status).toBe('cancelled');
  });
});

describe('syncPaymentStatuses', () => {
  it('returns 0-checked when no pending requests', async () => {
    const state: MockState = {
      requests: [
        emptyRequest({ id: 1, status: 'paid_out', payment_id: 'P1' }),
        emptyRequest({ id: 2, status: 'failed', payment_id: 'P2' }),
      ],
      mandates: [],
    };
    const result = await syncPaymentStatuses(makeAppDb(state), async () =>
      ({ success: true, payment: { status: 'paid_out' } }),
    );
    expect(result.success).toBe(true);
    expect(result.total_checked).toBe(0);
    expect(result.updated).toBe(0);
  });

  it('updates rows where remote returns a different status', async () => {
    const state: MockState = {
      requests: [
        emptyRequest({ id: 1, status: 'pending', payment_id: 'P1' }),
        emptyRequest({ id: 2, status: 'submitted', payment_id: 'P2' }),
      ],
      mandates: [],
    };
    const remote = async (id: string) => {
      if (id === 'P1') return { success: true, payment: { status: 'paid_out' } };
      if (id === 'P2') return { success: true, payment: { status: 'submitted' } };
      return { success: false };
    };
    const result = await syncPaymentStatuses(makeAppDb(state), remote);
    expect(result.success).toBe(true);
    expect(result.total_checked).toBe(2);
    expect(result.updated).toBe(1); // only P1 changed
    expect(state.requests[0]?.status).toBe('paid_out');
    expect(state.requests[1]?.status).toBe('submitted'); // unchanged
  });

  it('skips remote failures and continues with the rest', async () => {
    const state: MockState = {
      requests: [
        emptyRequest({ id: 1, status: 'pending', payment_id: 'P1' }),
        emptyRequest({ id: 2, status: 'pending', payment_id: 'P2' }),
      ],
      mandates: [],
    };
    const remote = async (id: string) => {
      if (id === 'P1') return { success: false, error: 'API down' };
      if (id === 'P2') return { success: true, payment: { status: 'paid_out' } };
      return { success: false };
    };
    const result = await syncPaymentStatuses(makeAppDb(state), remote);
    expect(result.success).toBe(true);
    expect(result.updated).toBe(1);
    expect(state.requests[0]?.status).toBe('pending'); // skipped
    expect(state.requests[1]?.status).toBe('paid_out');
  });

  it('skips entries with empty payment_id', async () => {
    const state: MockState = {
      requests: [
        emptyRequest({ id: 1, status: 'pending', payment_id: '' }),
      ],
      mandates: [],
    };
    let remoteCalled = false;
    const remote = async () => {
      remoteCalled = true;
      return { success: true };
    };
    const result = await syncPaymentStatuses(makeAppDb(state), remote);
    expect(result.success).toBe(true);
    expect(remoteCalled).toBe(false);
  });

  it('updates charge_date when included in remote response', async () => {
    const state: MockState = {
      requests: [
        emptyRequest({ id: 1, status: 'pending', payment_id: 'P1' }),
      ],
      mandates: [],
    };
    const remote = async () => ({
      success: true,
      payment: {
        status: 'submitted',
        charge_date: '2026-04-22',
      },
    });
    await syncPaymentStatuses(makeAppDb(state), remote);
    expect(state.requests[0]?.charge_date).toBe('2026-04-22');
  });
});
