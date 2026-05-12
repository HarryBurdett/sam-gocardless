import { describe, it, expect } from 'vitest';
import {
  requestPayment,
  requestBulkPayments,
  __test__,
  type OperaSnapshot,
  type RequestPaymentInput,
} from '../src/services/request-payment.js';

interface MandateRow {
  mandate_id: string;
  opera_account: string;
  opera_name: string | null;
  mandate_status: string;
  created_at: string;
}

interface PaymentRequestRow {
  id: number;
  mandate_id: string;
  opera_account: string;
  amount_pence: number;
  invoice_refs: string;
  payment_id: string | null;
  charge_date: string | null;
  description: string | null;
  status: string;
  currency: string;
}

interface MockState {
  mandates: MandateRow[];
  requests: PaymentRequestRow[];
  nextId: number;
}

function makeAppDb(state: MockState): any {
  function table(name: string) {
    if (name === 'gocardless_mandates') return mandateBuilder();
    if (name === 'gocardless_payment_requests') return requestBuilder();
    throw new Error(`Unexpected table: ${name}`);
  }
  table.fn = { now: () => '__NOW__' };
  return table;

  function mandateBuilder(): any {
    let conds: Record<string, unknown> = {};
    let order: { col: keyof MandateRow; dir: 'asc' | 'desc' } | null = null;
    const builder: any = {
      where: (cond: Record<string, unknown>) => {
        Object.assign(conds, cond);
        return builder;
      },
      orderBy: (col: keyof MandateRow, dir: 'asc' | 'desc' = 'asc') => {
        order = { col, dir };
        return builder;
      },
      first: async () => {
        let rows = state.mandates.filter((m) =>
          Object.entries(conds).every(([k, v]) => (m as any)[k] === v),
        );
        if (order) {
          const o = order;
          rows = [...rows].sort((a, b) => {
            const av = String(a[o.col]);
            const bv = String(b[o.col]);
            const cmp = av.localeCompare(bv);
            return o.dir === 'desc' ? -cmp : cmp;
          });
        }
        return rows[0];
      },
    };
    return builder;
  }

  function requestBuilder(): any {
    let conds: Record<string, unknown> = {};
    const builder: any = {
      where: (cond: Record<string, unknown>) => {
        Object.assign(conds, cond);
        return builder;
      },
      select: async (..._cols: string[]) => {
        return state.requests.filter((r) =>
          Object.entries(conds).every(([k, v]) => (r as any)[k] === v),
        );
      },
      first: async () => {
        return state.requests.find((r) =>
          Object.entries(conds).every(([k, v]) => (r as any)[k] === v),
        );
      },
      insert: (row: Omit<PaymentRequestRow, 'id'>) => {
        const id = ++state.nextId;
        state.requests.push({ id, ...row } as PaymentRequestRow);
        return {
          returning: async () => [{ id }],
        };
      },
    };
    return builder;
  }
}

function makeMandate(over: Partial<MandateRow> = {}): MandateRow {
  return {
    mandate_id: 'MD1',
    opera_account: 'CUST01',
    opera_name: 'Acme Ltd',
    mandate_status: 'active',
    created_at: '2026-04-01T00:00:00Z',
    ...over,
  };
}

const noOpOpera = async (): Promise<OperaSnapshot> => ({
  invoiceTotalPounds: null,
  unallocatedCreditPounds: 0,
});

const okRemote = (id = 'PM1', status = 'pending') => async () => ({
  success: true,
  payment: { id, status, charge_date: '2026-05-15' },
});

describe('requestPayment', () => {
  it('rejects empty opera_account', async () => {
    const state: MockState = { mandates: [], requests: [], nextId: 0 };
    const result = await requestPayment(
      makeAppDb(state),
      { operaAccount: '', invoices: ['INV1'], amountPence: 100 },
      {},
      noOpOpera,
      okRemote(),
    );
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/opera_account/);
  });

  it('refuses when no active mandate', async () => {
    const state: MockState = { mandates: [], requests: [], nextId: 0 };
    const result = await requestPayment(
      makeAppDb(state),
      { operaAccount: 'CUST01', invoices: ['INV1'], amountPence: 100 },
      {},
      noOpOpera,
      okRemote(),
    );
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/No active mandate/);
  });

  it('uses Opera invoice total (pence) when amount omitted', async () => {
    const state: MockState = {
      mandates: [makeMandate()],
      requests: [],
      nextId: 0,
    };
    let captured = 0;
    const result = await requestPayment(
      makeAppDb(state),
      { operaAccount: 'CUST01', invoices: ['INV1'] },
      {},
      async () => ({ invoiceTotalPounds: 12.34, unallocatedCreditPounds: 0 }),
      async (input) => {
        captured = input.amountPence;
        return { success: true, payment: { id: 'PM1', status: 'pending' } };
      },
    );
    expect(result.success).toBe(true);
    expect(captured).toBe(1234);
  });

  it('refuses when invoices specified but Opera total returns null', async () => {
    const state: MockState = {
      mandates: [makeMandate()],
      requests: [],
      nextId: 0,
    };
    const result = await requestPayment(
      makeAppDb(state),
      { operaAccount: 'CUST01', invoices: ['INV1'] },
      {},
      async () => ({ invoiceTotalPounds: null, unallocatedCreditPounds: 0 }),
      okRemote(),
    );
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/Could not find specified invoices/);
  });

  it('rejects amount <= 0', async () => {
    const state: MockState = {
      mandates: [makeMandate()],
      requests: [],
      nextId: 0,
    };
    const result = await requestPayment(
      makeAppDb(state),
      { operaAccount: 'CUST01', invoices: ['INV1'], amountPence: 0 },
      {},
      noOpOpera,
      okRemote(),
    );
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/greater than zero/);
  });

  it('refuses when customer has unallocated credit', async () => {
    const state: MockState = {
      mandates: [makeMandate()],
      requests: [],
      nextId: 0,
    };
    const result = await requestPayment(
      makeAppDb(state),
      { operaAccount: 'CUST01', invoices: ['INV1'], amountPence: 5000 },
      {},
      async () => ({ invoiceTotalPounds: 50.0, unallocatedCreditPounds: 25.5 }),
      okRemote(),
    );
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/unallocated credit/);
    expect(result.error).toMatch(/£25\.50/);
  });

  it('refuses duplicate invoice when prior request still active', async () => {
    const state: MockState = {
      mandates: [makeMandate()],
      requests: [
        {
          id: 1,
          mandate_id: 'MD1',
          opera_account: 'CUST01',
          amount_pence: 5000,
          invoice_refs: '["INV1","INV2"]',
          payment_id: 'PM_PRE',
          charge_date: '2026-05-01',
          description: null,
          status: 'pending',
          currency: 'GBP',
        },
      ],
      nextId: 1,
    };
    const result = await requestPayment(
      makeAppDb(state),
      { operaAccount: 'CUST01', invoices: ['INV2'], amountPence: 1000 },
      {},
      noOpOpera,
      okRemote(),
    );
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/already requested/);
    expect(result.error).toMatch(/INV2/);
  });

  it('does not block on cancelled or failed prior requests', async () => {
    const state: MockState = {
      mandates: [makeMandate()],
      requests: [
        {
          id: 1,
          mandate_id: 'MD1',
          opera_account: 'CUST01',
          amount_pence: 5000,
          invoice_refs: '["INV1"]',
          payment_id: 'PM_PRE',
          charge_date: null,
          description: null,
          status: 'cancelled',
          currency: 'GBP',
        },
      ],
      nextId: 1,
    };
    const result = await requestPayment(
      makeAppDb(state),
      { operaAccount: 'CUST01', invoices: ['INV1'], amountPence: 1000 },
      {},
      noOpOpera,
      okRemote(),
    );
    expect(result.success).toBe(true);
  });

  it('uses statement_reference prefix on description', async () => {
    const state: MockState = {
      mandates: [makeMandate()],
      requests: [],
      nextId: 0,
    };
    let capturedDesc = '';
    await requestPayment(
      makeAppDb(state),
      { operaAccount: 'CUST01', invoices: ['INV1'], amountPence: 1000 },
      { request_statement_reference: 'INTSYS' },
      noOpOpera,
      async (input) => {
        capturedDesc = input.description;
        return { success: true, payment: { id: 'PM1', status: 'pending' } };
      },
    );
    expect(capturedDesc.startsWith('INTSYS')).toBe(true);
    expect(capturedDesc).toContain('INV1');
  });

  it('drops past charge_date and lets GoCardless pick earliest possible', async () => {
    const state: MockState = {
      mandates: [makeMandate()],
      requests: [],
      nextId: 0,
    };
    let captured: string | null = 'unset';
    await requestPayment(
      makeAppDb(state),
      {
        operaAccount: 'CUST01',
        invoices: ['INV1'],
        amountPence: 1000,
        chargeDate: '2025-01-01',
      },
      {},
      noOpOpera,
      async (input) => {
        captured = input.chargeDate;
        return { success: true, payment: { id: 'PM1', status: 'pending' } };
      },
      new Date('2026-05-09T12:00:00Z'),
    );
    expect(captured).toBeNull();
  });

  it('keeps future charge_date untouched', async () => {
    const state: MockState = {
      mandates: [makeMandate()],
      requests: [],
      nextId: 0,
    };
    let captured: string | null = null;
    await requestPayment(
      makeAppDb(state),
      {
        operaAccount: 'CUST01',
        invoices: ['INV1'],
        amountPence: 1000,
        chargeDate: '2027-01-01',
      },
      {},
      noOpOpera,
      async (input) => {
        captured = input.chargeDate;
        return { success: true, payment: { id: 'PM1', status: 'pending' } };
      },
      new Date('2026-05-09T12:00:00Z'),
    );
    expect(captured).toBe('2027-01-01');
  });

  it('persists payment_request and returns enriched response', async () => {
    const state: MockState = {
      mandates: [makeMandate({ opera_name: 'Acme Ltd' })],
      requests: [],
      nextId: 0,
    };
    const result = await requestPayment(
      makeAppDb(state),
      { operaAccount: 'CUST01', invoices: ['INV1'], amountPence: 7500 },
      {},
      noOpOpera,
      async () => ({
        success: true,
        payment: { id: 'PM1', status: 'pending', charge_date: '2026-05-15' },
      }),
    );
    expect(result.success).toBe(true);
    expect(result.message).toMatch(/£75\.00/);
    expect(result.payment_request?.payment_id).toBe('PM1');
    expect(result.payment_request?.amount_pence).toBe(7500);
    expect(result.payment_request?.customer_name).toBe('Acme Ltd');
    expect(result.payment_request?.estimated_arrival).toBe('2026-05-20');
    expect(state.requests).toHaveLength(1);
    expect(state.requests[0]?.invoice_refs).toBe('["INV1"]');
  });

  it('reports remote failure without persisting', async () => {
    const state: MockState = {
      mandates: [makeMandate()],
      requests: [],
      nextId: 0,
    };
    const result = await requestPayment(
      makeAppDb(state),
      { operaAccount: 'CUST01', invoices: ['INV1'], amountPence: 1000 },
      {},
      noOpOpera,
      async () => ({ success: false, error: 'mandate_inactive' }),
    );
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/mandate_inactive/);
    expect(state.requests).toHaveLength(0);
  });
});

describe('requestBulkPayments', () => {
  it('runs each request independently and returns a summary', async () => {
    const state: MockState = {
      mandates: [
        makeMandate({ mandate_id: 'MD1', opera_account: 'CUST01' }),
        makeMandate({ mandate_id: 'MD2', opera_account: 'CUST02' }),
      ],
      requests: [],
      nextId: 0,
    };
    const inputs: RequestPaymentInput[] = [
      { operaAccount: 'CUST01', invoices: ['INV1'], amountPence: 1000 },
      { operaAccount: 'CUST02', invoices: ['INV2'], amountPence: 0 }, // will fail
      { operaAccount: 'CUST03', invoices: ['INV3'], amountPence: 1000 }, // no mandate
    ];
    const result = await requestBulkPayments(
      makeAppDb(state),
      inputs,
      {},
      noOpOpera,
      okRemote(),
    );
    expect(result.summary).toEqual({ total: 3, succeeded: 1, failed: 2 });
    expect(result.success).toBe(false);
    expect(result.results[0]?.success).toBe(true);
    expect(result.results[1]?.success).toBe(false);
    expect(result.results[2]?.success).toBe(false);
  });

  it('reports overall success=true when every request succeeds', async () => {
    const state: MockState = {
      mandates: [makeMandate()],
      requests: [],
      nextId: 0,
    };
    const result = await requestBulkPayments(
      makeAppDb(state),
      [{ operaAccount: 'CUST01', invoices: ['INV1'], amountPence: 1000 }],
      {},
      noOpOpera,
      okRemote(),
    );
    expect(result.success).toBe(true);
    expect(result.summary.succeeded).toBe(1);
  });
});

describe('helper: buildDescription', () => {
  it('uses single invoice when only one', () => {
    expect(__test__.buildDescription(null, ['INV1'], null)).toBe('INV1');
  });
  it('summarises multiple invoices as INVX +N', () => {
    expect(__test__.buildDescription(null, ['INV1', 'INV2', 'INV3'], null)).toBe(
      'INV1 +2',
    );
  });
  it('truncates statement reference to 10 chars', () => {
    const long = 'INTSYS_TOO_LONG';
    expect(__test__.buildDescription(null, ['INV1'], long)).toMatch(/^INTSYS_TOO/);
  });
  it('does not double-prefix when description already starts with stmt ref', () => {
    expect(__test__.buildDescription('INTSYS payment', ['INV1'], 'INTSYS')).toBe(
      'INTSYS payment',
    );
  });
});

describe('helper: normaliseChargeDate', () => {
  it('returns null for past dates', () => {
    expect(
      __test__.normaliseChargeDate('2025-01-01', new Date('2026-05-09T00:00:00Z')),
    ).toBeNull();
  });
  it('keeps today and future dates', () => {
    expect(
      __test__.normaliseChargeDate('2026-05-09', new Date('2026-05-09T00:00:00Z')),
    ).toBe('2026-05-09');
    expect(
      __test__.normaliseChargeDate('2027-01-01', new Date('2026-05-09T00:00:00Z')),
    ).toBe('2027-01-01');
  });
  it('passes malformed input through unchanged', () => {
    expect(
      __test__.normaliseChargeDate('not-a-date', new Date('2026-05-09T00:00:00Z')),
    ).toBe('not-a-date');
  });
});
