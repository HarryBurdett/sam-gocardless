import { describe, it, expect } from 'vitest';
import { getRepeatDocuments } from '../src/services/repeat-documents.js';

interface IheadRow {
  ih_doc: string;
  ih_account: string;
  ih_name: string;
  ih_ignore: string;
  ih_dcontr: number;
  ih_scontr: string | null;
  ih_econtr: string | null;
  ih_job: string;
  ih_analsys: string;
  ih_custref: string;
  ih_narr1: string;
  line_nett: number; // pence
  line_vat: number; // pence
}

interface MandateRow {
  mandate_id: string;
  opera_account: string;
  mandate_status: string;
}

interface SubRow {
  subscription_id: string;
  opera_account: string;
  amount_pence: number;
  source_doc: string | null;
  status: string;
  name: string;
  interval_unit: string;
  interval_count: number;
}

interface DocLink {
  subscription_id: string;
  source_doc: string;
}

interface MockState {
  ihead: IheadRow[];
  mandates: MandateRow[];
  subs: SubRow[];
  links: DocLink[];
}

// ---- mock builders ---------------------------------------------------

function makeAppDb(state: MockState): any {
  const db: any = (table: string) => {
    if (table === 'gocardless_mandates') {
      let conds: Record<string, unknown> = {};
      const builder: any = {
        where: (cond: Record<string, unknown>) => {
          Object.assign(conds, cond);
          return builder;
        },
        select: async (..._cols: string[]) => {
          return state.mandates.filter((m) =>
            Object.entries(conds).every(([k, v]) => (m as any)[k] === v),
          );
        },
      };
      return builder;
    }
    if (table === 'gocardless_subscriptions') {
      const builder: any = {
        select: async (..._cols: string[]) => {
          return state.subs;
        },
      };
      return builder;
    }
    if (table === 'gocardless_subscription_documents') {
      const builder: any = {
        select: async (..._cols: string[]) => {
          return state.links;
        },
      };
      return builder;
    }
    throw new Error(`Unexpected table: ${table}`);
  };
  db.fn = { now: () => '__NOW__' };
  return db;
}

function makeOperaDb(state: MockState): any {
  const db: any = (table: string) => {
    if (table === 'ihead') {
      const builder: any = {
        leftJoin: () => builder,
        where: () => builder,
        andWhere: (_cb: any) => builder,
        orderBy: () => builder,
        select: (..._cols: any[]) => {
          // Make the builder thenable so `await` resolves to the rows.
          return Promise.resolve(state.ihead);
        },
      };
      return builder;
    }
    // Subquery for itran sums — return a chainable stub that's never awaited.
    const stub: any = new Proxy(
      function stubFn() {
        return stub;
      },
      {
        get: () => () => stub,
      },
    );
    return stub;
  };
  db.raw = (s: string) => s;
  return db;
}

// ---- factories -------------------------------------------------------

function emptyHead(over: Partial<IheadRow> = {}): IheadRow {
  return {
    ih_doc: 'DOC001',
    ih_account: 'CUST01',
    ih_name: 'Acme Ltd',
    ih_ignore: 'M',
    ih_dcontr: 0,
    ih_scontr: '2026-01-01',
    ih_econtr: null,
    ih_job: '',
    ih_analsys: '',
    ih_custref: '',
    ih_narr1: '',
    line_nett: 10000, // £100.00
    line_vat: 2000, // £20.00
    ...over,
  };
}

function emptySub(over: Partial<SubRow> = {}): SubRow {
  return {
    subscription_id: 'SUB1',
    opera_account: 'CUST01',
    amount_pence: 12000,
    source_doc: null,
    status: 'active',
    name: 'Sub Name',
    interval_unit: 'monthly',
    interval_count: 1,
    ...over,
  };
}

// ---- tests -----------------------------------------------------------

describe('getRepeatDocuments', () => {
  it('filters out docs whose customer has no mandate (default require_mandate=true)', async () => {
    const state: MockState = {
      ihead: [
        emptyHead({ ih_account: 'CUST01' }),
        emptyHead({ ih_doc: 'DOC002', ih_account: 'CUST02' }),
      ],
      mandates: [
        { mandate_id: 'MAN1', opera_account: 'CUST01', mandate_status: 'active' },
      ],
      subs: [],
      links: [],
    };
    const result = await getRepeatDocuments(makeOperaDb(state), makeAppDb(state));
    expect(result.success).toBe(true);
    expect(result.count).toBe(1);
    expect(result.documents[0]?.opera_account).toBe('CUST01');
    expect(result.with_mandate).toBe(1);
  });

  it('returns all docs when requireMandate=false', async () => {
    const state: MockState = {
      ihead: [
        emptyHead({ ih_account: 'CUST01' }),
        emptyHead({ ih_doc: 'DOC002', ih_account: 'CUST02' }),
      ],
      mandates: [],
      subs: [],
      links: [],
    };
    const result = await getRepeatDocuments(
      makeOperaDb(state),
      makeAppDb(state),
      { requireMandate: false },
    );
    expect(result.count).toBe(2);
    expect(result.with_mandate).toBe(0);
  });

  it('attaches mandate_id when customer has an active mandate', async () => {
    const state: MockState = {
      ihead: [emptyHead()],
      mandates: [
        {
          mandate_id: 'MAN1',
          opera_account: 'CUST01',
          mandate_status: 'active',
        },
      ],
      subs: [],
      links: [],
    };
    const result = await getRepeatDocuments(makeOperaDb(state), makeAppDb(state));
    expect(result.documents[0]?.has_mandate).toBe(true);
    expect(result.documents[0]?.mandate_id).toBe('MAN1');
  });

  it('computes amount_pence from itran sums (in pence) and formats GBP', async () => {
    const state: MockState = {
      ihead: [emptyHead({ line_nett: 9999, line_vat: 1234 })], // £112.33
      mandates: [
        { mandate_id: 'M', opera_account: 'CUST01', mandate_status: 'active' },
      ],
      subs: [],
      links: [],
    };
    const result = await getRepeatDocuments(makeOperaDb(state), makeAppDb(state));
    expect(result.documents[0]?.amount_pence).toBe(11233);
    expect(result.documents[0]?.amount_formatted).toBe('£112.33');
    expect(result.documents[0]?.ex_vat).toBeCloseTo(99.99, 2);
    expect(result.documents[0]?.vat).toBeCloseTo(12.34, 2);
  });

  it('maps frequency code Q to "Quarterly" and provides interval pair', async () => {
    const state: MockState = {
      ihead: [emptyHead({ ih_ignore: 'Q' })],
      mandates: [
        { mandate_id: 'M', opera_account: 'CUST01', mandate_status: 'active' },
      ],
      subs: [],
      links: [],
    };
    const result = await getRepeatDocuments(makeOperaDb(state), makeAppDb(state));
    expect(result.documents[0]?.frequency).toBe('Quarterly');
    expect(result.documents[0]?.interval_unit).toBe('monthly');
    expect(result.documents[0]?.interval_count).toBe(3);
  });

  it('detects existing subscription via junction table', async () => {
    const state: MockState = {
      ihead: [emptyHead({ ih_doc: 'DOC001' })],
      mandates: [
        { mandate_id: 'M', opera_account: 'CUST01', mandate_status: 'active' },
      ],
      subs: [
        emptySub({
          subscription_id: 'SUB1',
          amount_pence: 12000,
          status: 'active',
          interval_unit: 'monthly',
          interval_count: 1,
        }),
      ],
      links: [{ subscription_id: 'SUB1', source_doc: 'DOC001' }],
    };
    const result = await getRepeatDocuments(makeOperaDb(state), makeAppDb(state));
    expect(result.documents[0]?.has_subscription).toBe(true);
    expect(result.documents[0]?.subscription_id).toBe('SUB1');
    expect(result.with_subscription).toBe(1);
    expect(result.documents[0]?.mismatch).toBeNull();
  });

  it('reports amount mismatch when subscription value differs from doc', async () => {
    const state: MockState = {
      ihead: [emptyHead({ ih_doc: 'DOC001', line_nett: 10000, line_vat: 2000 })], // £120
      mandates: [
        { mandate_id: 'M', opera_account: 'CUST01', mandate_status: 'active' },
      ],
      subs: [
        emptySub({
          subscription_id: 'SUB1',
          amount_pence: 15000, // £150
          interval_unit: 'monthly',
          interval_count: 1,
        }),
      ],
      links: [{ subscription_id: 'SUB1', source_doc: 'DOC001' }],
    };
    const result = await getRepeatDocuments(makeOperaDb(state), makeAppDb(state));
    expect(result.documents[0]?.mismatch).not.toBeNull();
    expect(result.documents[0]?.mismatch?.details[0]).toMatch(/Amount/);
    expect(result.documents[0]?.mismatch?.sub_amount_pence).toBe(15000);
    expect(result.documents[0]?.mismatch?.doc_amount_pence).toBe(12000);
  });

  it('reports frequency mismatch when subscription cadence differs', async () => {
    const state: MockState = {
      ihead: [emptyHead({ ih_doc: 'DOC001', ih_ignore: 'M' })],
      mandates: [
        { mandate_id: 'M', opera_account: 'CUST01', mandate_status: 'active' },
      ],
      subs: [
        emptySub({
          subscription_id: 'SUB1',
          amount_pence: 12000,
          interval_unit: 'yearly',
          interval_count: 1,
        }),
      ],
      links: [{ subscription_id: 'SUB1', source_doc: 'DOC001' }],
    };
    const result = await getRepeatDocuments(makeOperaDb(state), makeAppDb(state));
    expect(result.documents[0]?.mismatch?.details[0]).toMatch(/Frequency/);
  });

  it('suggests a matching unlinked subscription by exact amount', async () => {
    const state: MockState = {
      ihead: [emptyHead()],
      mandates: [
        { mandate_id: 'M', opera_account: 'CUST01', mandate_status: 'active' },
      ],
      subs: [
        emptySub({
          subscription_id: 'SUB_X',
          amount_pence: 12000,
          source_doc: null,
          name: 'Annual Sub',
          status: 'active',
        }),
      ],
      links: [],
    };
    const result = await getRepeatDocuments(makeOperaDb(state), makeAppDb(state));
    expect(result.documents[0]?.matching_subscription?.subscription_id).toBe(
      'SUB_X',
    );
    expect(result.with_match).toBe(1);
  });

  it('falls back to within-£1 tolerance for matching subscription', async () => {
    const state: MockState = {
      ihead: [emptyHead({ line_nett: 10000, line_vat: 2050 })], // £120.50
      mandates: [
        { mandate_id: 'M', opera_account: 'CUST01', mandate_status: 'active' },
      ],
      subs: [
        emptySub({
          subscription_id: 'SUB_X',
          amount_pence: 12000,
          source_doc: null,
        }), // £120 — diff 50p which is within £1
      ],
      links: [],
    };
    const result = await getRepeatDocuments(makeOperaDb(state), makeAppDb(state));
    expect(result.documents[0]?.matching_subscription?.subscription_id).toBe(
      'SUB_X',
    );
  });

  it('does NOT suggest subscriptions already linked via legacy source_doc', async () => {
    const state: MockState = {
      ihead: [emptyHead()],
      mandates: [
        { mandate_id: 'M', opera_account: 'CUST01', mandate_status: 'active' },
      ],
      subs: [
        emptySub({
          subscription_id: 'SUB_X',
          amount_pence: 12000,
          source_doc: 'DOC_OLD',
        }),
      ],
      links: [],
    };
    const result = await getRepeatDocuments(makeOperaDb(state), makeAppDb(state));
    expect(result.documents[0]?.matching_subscription).toBeNull();
  });

  it('flags is_sub_tagged when ih_analsys matches the subscription tag', async () => {
    const state: MockState = {
      ihead: [emptyHead({ ih_analsys: 'SUB' })],
      mandates: [
        { mandate_id: 'M', opera_account: 'CUST01', mandate_status: 'active' },
      ],
      subs: [],
      links: [],
    };
    const result = await getRepeatDocuments(makeOperaDb(state), makeAppDb(state));
    expect(result.documents[0]?.is_sub_tagged).toBe(true);
  });

  it('honours custom subscription tag', async () => {
    const state: MockState = {
      ihead: [emptyHead({ ih_analsys: 'GCSUB' })],
      mandates: [
        { mandate_id: 'M', opera_account: 'CUST01', mandate_status: 'active' },
      ],
      subs: [],
      links: [],
    };
    const result = await getRepeatDocuments(
      makeOperaDb(state),
      makeAppDb(state),
      { subscriptionTag: 'GCSUB' },
    );
    expect(result.documents[0]?.is_sub_tagged).toBe(true);
  });

  it('reports DB error gracefully', async () => {
    const operaDb: any = (table: string) => {
      if (table === 'ihead') {
        const builder: any = {
          leftJoin: () => builder,
          where: () => builder,
          andWhere: () => builder,
          orderBy: () => builder,
          select: () => Promise.reject(new Error('DB unavailable')),
        };
        return builder;
      }
      const stub: any = new Proxy(
        function stubFn() {
          return stub;
        },
        {
          get: () => () => stub,
        },
      );
      return stub;
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
    const result = await getRepeatDocuments(operaDb, appDb);
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/DB unavailable/);
  });
});
