import { describe, it, expect } from 'vitest';
import {
  matchPaymentsHelper,
  matchCustomersWithDuplicateCheck,
  normalizeCompanyName,
  type PaymentInput,
} from '../src/services/match-customers.js';

interface Mandate {
  opera_account: string;
  opera_name?: string | null;
  gocardless_name?: string | null;
  gocardless_customer_id?: string | null;
  mandate_id?: string | null;
  mandate_status?: string | null;
}

interface AppMockState {
  mandates: Mandate[];
  // Captured backfill updates so tests can assert on them
  backfills: Array<{ opera_account: string; gocardless_customer_id: string }>;
}

function makeAppDb(state: AppMockState): any {
  const db: any = (table: string) => {
    if (table !== 'gocardless_mandates') {
      throw new Error(`Unexpected app table: ${table}`);
    }
    let captured: { opera_account?: string } | null = null;
    let updateRow: Record<string, unknown> | null = null;
    let nullCheck = false;
    const builder: any = {
      select: (..._cols: unknown[]) => Promise.resolve(state.mandates),
      where: (cond: Record<string, unknown>) => {
        captured = cond as any;
        return builder;
      },
      andWhere: (_cb: (qb: unknown) => void) => {
        nullCheck = true;
        return builder;
      },
      update: (row: Record<string, unknown>) => {
        updateRow = row;
        if (
          captured?.opera_account &&
          updateRow?.gocardless_customer_id &&
          nullCheck
        ) {
          state.backfills.push({
            opera_account: captured.opera_account,
            gocardless_customer_id: String(updateRow.gocardless_customer_id),
          });
        }
        return Promise.resolve(1);
      },
    };
    return builder;
  };
  db.fn = { now: () => 'NOW()' };
  return db;
}

interface OperaMockState {
  customers: Array<{ sn_account: string; sn_name: string }>;
  receipts: Array<{
    at_value: number;
    at_pstdate: Date | string;
    at_cbtype: string;
    ae_entref: string;
  }>;
}

function makeOperaDb(state: OperaMockState): any {
  const db: any = {
    raw: (sql: string, _params?: unknown[]) => {
      if (sql.includes('FROM sname')) {
        return Promise.resolve(state.customers);
      }
      if (sql.includes('FROM atran')) {
        return Promise.resolve(state.receipts);
      }
      return Promise.resolve([]);
    },
  };
  return db;
}

// =====================================================================
// normalizeCompanyName
// =====================================================================

describe('normalizeCompanyName', () => {
  it('lowercases and trims', () => {
    expect(normalizeCompanyName('  ACME  ')).toBe('acme');
  });
  it('strips parenthetical content', () => {
    expect(normalizeCompanyName('Acme (UK) Limited')).toBe('acme');
  });
  it('normalises " and " to " & "', () => {
    expect(normalizeCompanyName('Smith and Jones')).toBe('smith & jones');
  });
  it('collapses single-letter pairs (I C → IC)', () => {
    expect(normalizeCompanyName('I C Solutions')).toBe('ic solutions');
  });
  it('strips company suffixes', () => {
    expect(normalizeCompanyName('Acme Limited')).toBe('acme');
    expect(normalizeCompanyName('Acme LTD.')).toBe('acme');
    expect(normalizeCompanyName('Acme PLC')).toBe('acme');
    expect(normalizeCompanyName('Acme Holdings')).toBe('acme');
  });
  it('strips trailing punctuation', () => {
    expect(normalizeCompanyName('Acme.,')).toBe('acme');
  });
});

// =====================================================================
// matchPaymentsHelper — matching priorities
// =====================================================================

describe('matchPaymentsHelper', () => {
  it('priority 0: metadata.opera_account wins when customer exists', async () => {
    const appState: AppMockState = { mandates: [], backfills: [] };
    const operaState: OperaMockState = {
      customers: [{ sn_account: 'CUST01', sn_name: 'Acme Limited' }],
      receipts: [],
    };
    const result = await matchPaymentsHelper(
      makeAppDb(appState),
      makeOperaDb(operaState),
      [
        {
          customer_name: 'Different Name',
          amount: 100,
          metadata: { opera_account: 'CUST01', invoices: 'INV001,INV002' },
        },
      ],
    );
    expect(result.success).toBe(true);
    expect(result.payments[0]?.matched_account).toBe('CUST01');
    expect(result.payments[0]?.matched_name).toBe('Acme Limited');
    expect(result.payments[0]?.match_method).toBe(
      'metadata:opera_account=CUST01',
    );
    // Invoice refs from metadata since payment.invoice_refs was empty
    expect(result.payments[0]?.invoice_refs).toEqual(['INV001', 'INV002']);
  });

  it('priority 1: mandate_id direct lookup', async () => {
    const appState: AppMockState = {
      mandates: [
        {
          opera_account: 'CUST02',
          opera_name: 'Beta',
          mandate_id: 'MD001',
        },
      ],
      backfills: [],
    };
    const operaState: OperaMockState = {
      customers: [{ sn_account: 'CUST02', sn_name: 'Beta Limited' }],
      receipts: [],
    };
    const result = await matchPaymentsHelper(
      makeAppDb(appState),
      makeOperaDb(operaState),
      [{ amount: 100, mandate_id: 'MD001' }],
    );
    expect(result.payments[0]?.matched_account).toBe('CUST02');
    expect(result.payments[0]?.matched_name).toBe('Beta Limited');
    expect(result.payments[0]?.match_method).toBe('mandate:MD001');
  });

  it('priority 2: gocardless_customer_id lookup', async () => {
    const appState: AppMockState = {
      mandates: [
        {
          opera_account: 'CUST03',
          opera_name: 'Gamma',
          gocardless_customer_id: 'CU_X',
          mandate_id: 'MD002',
        },
      ],
      backfills: [],
    };
    const operaState: OperaMockState = {
      customers: [{ sn_account: 'CUST03', sn_name: 'Gamma Limited' }],
      receipts: [],
    };
    const result = await matchPaymentsHelper(
      makeAppDb(appState),
      makeOperaDb(operaState),
      [{ amount: 100, customer_id: 'CU_X' }],
    );
    expect(result.payments[0]?.match_method).toBe('customer:CU_X');
    expect(result.payments[0]?.matched_account).toBe('CUST03');
  });

  it('priority 3: name match against mandate opera_name (normalised exact)', async () => {
    const appState: AppMockState = {
      mandates: [
        { opera_account: 'CUST04', opera_name: 'Delta Limited', mandate_id: 'MD003' },
      ],
      backfills: [],
    };
    const operaState: OperaMockState = {
      customers: [{ sn_account: 'CUST04', sn_name: 'Delta Limited' }],
      receipts: [],
    };
    const result = await matchPaymentsHelper(
      makeAppDb(appState),
      makeOperaDb(operaState),
      [{ customer_name: 'DELTA LTD', amount: 100 }],
    );
    expect(result.payments[0]?.matched_account).toBe('CUST04');
    expect(result.payments[0]?.match_method).toBe('name_exact:delta');
  });

  it('priority 4: name match against Opera sname (exact wins over contains)', async () => {
    const appState: AppMockState = { mandates: [], backfills: [] };
    const operaState: OperaMockState = {
      customers: [
        { sn_account: 'CUST05A', sn_name: 'Echo' },
        { sn_account: 'CUST05B', sn_name: 'Echo Holdings UK' },
      ],
      receipts: [],
    };
    const result = await matchPaymentsHelper(
      makeAppDb(appState),
      makeOperaDb(operaState),
      [{ customer_name: 'echo', amount: 100 }],
    );
    expect(result.payments[0]?.matched_account).toBe('CUST05A');
    expect(result.payments[0]?.match_method).toBe('opera_exact:echo');
  });

  it('skips customer_name=unknown / empty / not provided', async () => {
    const appState: AppMockState = { mandates: [], backfills: [] };
    const operaState: OperaMockState = {
      customers: [{ sn_account: 'CUST', sn_name: 'unknown' }],
      receipts: [],
    };
    const result = await matchPaymentsHelper(
      makeAppDb(appState),
      makeOperaDb(operaState),
      [
        { customer_name: 'Unknown', amount: 100 },
        { customer_name: '', amount: 100 },
        { customer_name: 'not provided', amount: 100 },
      ],
    );
    expect(result.payments.every((p) => p.matched_account === null)).toBe(true);
    expect(result.unmatched_count).toBe(3);
  });

  it('skips __UNLINKED__ mandates', async () => {
    const appState: AppMockState = {
      mandates: [
        { opera_account: '__UNLINKED__', opera_name: 'Foxtrot', mandate_id: 'MD_X' },
      ],
      backfills: [],
    };
    const operaState: OperaMockState = { customers: [], receipts: [] };
    const result = await matchPaymentsHelper(
      makeAppDb(appState),
      makeOperaDb(operaState),
      [{ mandate_id: 'MD_X', amount: 100 }],
    );
    expect(result.payments[0]?.matched_account).toBeNull();
  });

  it('backfills gocardless_customer_id when matched by name', async () => {
    const appState: AppMockState = {
      mandates: [
        { opera_account: 'CUST06', opera_name: 'Hotel', mandate_id: 'MD_H',
          gocardless_customer_id: null },
      ],
      backfills: [],
    };
    const operaState: OperaMockState = {
      customers: [{ sn_account: 'CUST06', sn_name: 'Hotel Ltd' }],
      receipts: [],
    };
    const result = await matchPaymentsHelper(
      makeAppDb(appState),
      makeOperaDb(operaState),
      [{ customer_name: 'Hotel', customer_id: 'CU_H', amount: 100 }],
    );
    expect(result.payments[0]?.match_method).toMatch(/^name_exact:/);
    expect(appState.backfills).toEqual([
      { opera_account: 'CUST06', gocardless_customer_id: 'CU_H' },
    ]);
  });

  it('does NOT backfill when matched by mandate_id', async () => {
    const appState: AppMockState = {
      mandates: [
        { opera_account: 'CUST07', mandate_id: 'MD_Z', gocardless_customer_id: null },
      ],
      backfills: [],
    };
    const operaState: OperaMockState = {
      customers: [{ sn_account: 'CUST07', sn_name: 'Zulu' }],
      receipts: [],
    };
    await matchPaymentsHelper(
      makeAppDb(appState),
      makeOperaDb(operaState),
      [{ mandate_id: 'MD_Z', customer_id: 'CU_Z', amount: 100 }],
    );
    expect(appState.backfills).toEqual([]);
  });
});

// =====================================================================
// matchCustomersWithDuplicateCheck — duplicate detection
// =====================================================================

describe('matchCustomersWithDuplicateCheck', () => {
  it('flags possible_duplicate when matching cashbook value found', async () => {
    const appState: AppMockState = {
      mandates: [
        { opera_account: 'CUST08', opera_name: 'India Ltd', mandate_id: 'MD8' },
      ],
      backfills: [],
    };
    const operaState: OperaMockState = {
      customers: [{ sn_account: 'CUST08', sn_name: 'India Ltd' }],
      receipts: [
        {
          at_value: 12500, // £125.00 in pence
          at_pstdate: '2026-04-15',
          at_cbtype: 'GC',
          ae_entref: 'BAT001',
        },
      ],
    };
    const result = await matchCustomersWithDuplicateCheck(
      makeAppDb(appState),
      makeOperaDb(operaState),
      [
        {
          customer_name: 'India Ltd',
          amount: 125.0,
          mandate_id: 'MD8',
        },
      ],
    );
    expect(result.success).toBe(true);
    expect(result.payments[0]?.possible_duplicate).toBe(true);
    expect(result.payments[0]?.duplicate_warning).toMatch(/£125\.00/);
    expect(result.payments[0]?.duplicate_warning).toMatch(/2026-04-15/);
    expect(result.duplicate_count).toBe(1);
    expect(result.matched_count).toBe(1);
  });

  it('respects 1p tolerance', async () => {
    const appState: AppMockState = { mandates: [], backfills: [] };
    const operaState: OperaMockState = {
      customers: [],
      receipts: [
        { at_value: 12500, at_pstdate: '2026-04-15', at_cbtype: 'GC', ae_entref: 'X' },
      ],
    };
    const result = await matchCustomersWithDuplicateCheck(
      makeAppDb(appState),
      makeOperaDb(operaState),
      [
        { amount: 125.0 },  // exact
        { amount: 125.01 }, // 1p over — within tolerance
        { amount: 125.02 }, // 2p over — out of tolerance
      ],
    );
    expect(result.payments[0]?.possible_duplicate).toBe(true);
    expect(result.payments[1]?.possible_duplicate).toBe(true);
    expect(result.payments[2]?.possible_duplicate).toBe(false);
  });

  it('emits matched/review/unmatched/duplicate counts', async () => {
    const appState: AppMockState = {
      mandates: [
        { opera_account: 'CUST09', opera_name: 'Juliet', mandate_id: 'MD9' },
      ],
      backfills: [],
    };
    const operaState: OperaMockState = {
      customers: [{ sn_account: 'CUST09', sn_name: 'Juliet' }],
      receipts: [],
    };
    const result = await matchCustomersWithDuplicateCheck(
      makeAppDb(appState),
      makeOperaDb(operaState),
      [
        { mandate_id: 'MD9', amount: 50 }, // matched
        { customer_name: 'Stranger', amount: 75 }, // unmatched
      ],
    );
    expect(result.total_payments).toBe(2);
    expect(result.matched_count).toBe(1);
    expect(result.unmatched_count).toBe(1);
    expect(result.duplicate_count).toBe(0);
  });

  it('returns success=false when helper itself fails', async () => {
    const failingApp: any = () => {
      throw new Error('table missing');
    };
    failingApp.fn = { now: () => 'NOW()' };
    const result = await matchCustomersWithDuplicateCheck(
      failingApp,
      makeOperaDb({ customers: [], receipts: [] }),
      [{ amount: 100 }],
    );
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/table missing/);
  });
});
