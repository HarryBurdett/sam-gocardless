import { describe, it, expect } from 'vitest';
import {
  listMandates,
  listUnlinkedMandates,
  cancelMandate,
  unlinkMandate,
  linkMandate,
  syncMandatesFromGocardless,
  normaliseCompanyName,
  findOperaCustomerMatch,
} from '../src/services/mandates.js';

interface MandateRow {
  id: number;
  mandate_id: string;
  opera_account: string;
  opera_name: string;
  gocardless_name: string;
  gocardless_customer_id: string;
  mandate_status: string;
  scheme: string;
  email: string;
  created_at: string;
  updated_at: string;
}

interface MockState {
  rows: MandateRow[];
}

function makeAppDb(state: MockState): any {
  const db: any = (table: string) => {
    if (table !== 'gocardless_mandates') {
      throw new Error(`Unexpected table: ${table}`);
    }
    let conds: Record<string, unknown> = {};
    let neqConds: Array<{ col: string; val: unknown }> = [];
    const matches = () =>
      state.rows.filter(
        (r) =>
          Object.entries(conds).every(([k, v]) => (r as any)[k] === v) &&
          neqConds.every((nc) => (r as any)[nc.col] !== nc.val),
      );
    const builder: any = {
      where: (cond: Record<string, unknown>) => {
        Object.assign(conds, cond);
        return builder;
      },
      andWhere: (col: string, op: string, val: unknown) => {
        if (op === '!=') neqConds.push({ col, val });
        return builder;
      },
      select: async (..._cols: string[]) => matches(),
      first: async () => matches()[0],
      then: (cb: (rows: MandateRow[]) => unknown) => {
        return Promise.resolve(cb(matches()));
      },
      update: async (data: Record<string, unknown>) => {
        let count = 0;
        for (const r of matches()) {
          Object.assign(r, data);
          count++;
        }
        return count;
      },
      delete: async () => {
        const targets = matches();
        const before = state.rows.length;
        state.rows = state.rows.filter((r) => !targets.includes(r));
        return before - state.rows.length;
      },
      insert: async (row: Record<string, unknown>) => {
        const id = (state.rows[state.rows.length - 1]?.id ?? 0) + 1;
        state.rows.push({
          id,
          mandate_id: '',
          opera_account: '',
          opera_name: '',
          gocardless_name: '',
          gocardless_customer_id: '',
          mandate_status: 'active',
          scheme: 'bacs',
          email: '',
          created_at: '2026-04-15',
          updated_at: '2026-04-15',
          ...(row as Partial<MandateRow>),
        });
        return [id];
      },
    };
    return builder;
  };
  db.fn = { now: () => new Date() };
  return db;
}

function emptyMandate(over: Partial<MandateRow> = {}): MandateRow {
  return {
    id: 1,
    mandate_id: 'MD_X',
    opera_account: 'CUST01',
    opera_name: 'Acme Ltd',
    gocardless_name: '',
    gocardless_customer_id: '',
    mandate_status: 'active',
    scheme: 'bacs',
    email: '',
    created_at: '2026-04-15',
    updated_at: '2026-04-15',
    ...over,
  };
}

describe('listMandates', () => {
  it('returns mandates sorted alphabetically by opera_name', async () => {
    const state: MockState = {
      rows: [
        emptyMandate({ id: 1, mandate_id: 'M1', opera_name: 'Beta' }),
        emptyMandate({ id: 2, mandate_id: 'M2', opera_name: 'Acme' }),
        emptyMandate({ id: 3, mandate_id: 'M3', opera_name: 'cATco' }),
      ],
    };
    const result = await listMandates(makeAppDb(state));
    expect(result.success).toBe(true);
    expect(result.count).toBe(3);
    expect(result.mandates[0]?.opera_name).toBe('Acme');
    expect(result.mandates[1]?.opera_name).toBe('Beta');
    expect(result.mandates[2]?.opera_name).toBe('cATco');
  });

  it('filters by status', async () => {
    const state: MockState = {
      rows: [
        emptyMandate({ id: 1, mandate_status: 'active' }),
        emptyMandate({ id: 2, mandate_status: 'cancelled' }),
      ],
    };
    const result = await listMandates(makeAppDb(state), { status: 'active' });
    expect(result.count).toBe(1);
    expect(result.mandates[0]?.mandate_status).toBe('active');
  });

  it('dedups __UNLINKED__ rows when a linked version of the same mandate_id exists', async () => {
    const state: MockState = {
      rows: [
        emptyMandate({
          id: 1,
          mandate_id: 'MD_DUP',
          opera_account: '__UNLINKED__',
          opera_name: 'Acme (raw)',
        }),
        emptyMandate({
          id: 2,
          mandate_id: 'MD_DUP',
          opera_account: 'CUST01',
          opera_name: 'Acme Ltd',
        }),
      ],
    };
    const result = await listMandates(makeAppDb(state));
    expect(result.count).toBe(1);
    expect(result.mandates[0]?.opera_account).toBe('CUST01');
  });

  it('keeps __UNLINKED__ rows when no linked version exists for that mandate_id', async () => {
    const state: MockState = {
      rows: [
        emptyMandate({
          id: 1,
          mandate_id: 'MD_LONELY',
          opera_account: '__UNLINKED__',
          opera_name: 'Lonely',
        }),
      ],
    };
    const result = await listMandates(makeAppDb(state));
    expect(result.count).toBe(1);
  });
});

describe('listUnlinkedMandates', () => {
  it('returns only __UNLINKED__ rows', async () => {
    const state: MockState = {
      rows: [
        emptyMandate({ id: 1, opera_account: 'CUST01' }),
        emptyMandate({
          id: 2,
          opera_account: '__UNLINKED__',
          opera_name: 'Bravo',
        }),
        emptyMandate({
          id: 3,
          opera_account: '__UNLINKED__',
          opera_name: 'Alpha',
        }),
      ],
    };
    const result = await listUnlinkedMandates(makeAppDb(state));
    expect(result.success).toBe(true);
    expect(result.count).toBe(2);
    // Sorted alphabetically by opera_name
    expect(result.mandates[0]?.opera_name).toBe('Alpha');
    expect(result.mandates[1]?.opera_name).toBe('Bravo');
  });
});

describe('cancelMandate', () => {
  it('updates local mandate_status when remote cancel succeeds', async () => {
    const state: MockState = {
      rows: [emptyMandate({ id: 1, mandate_id: 'MD_X', mandate_status: 'active' })],
    };
    const remote = async () => ({ success: true, status: 'cancelled' });
    const result = await cancelMandate(makeAppDb(state), 'MD_X', remote);
    expect(result.success).toBe(true);
    expect(result.status).toBe('cancelled');
    expect(state.rows[0]?.mandate_status).toBe('cancelled');
  });

  it('does NOT update local when remote cancel fails', async () => {
    const state: MockState = {
      rows: [emptyMandate({ id: 1, mandate_id: 'MD_X', mandate_status: 'active' })],
    };
    const remote = async () => ({ success: false, error: 'API error' });
    const result = await cancelMandate(makeAppDb(state), 'MD_X', remote);
    expect(result.success).toBe(false);
    expect(state.rows[0]?.mandate_status).toBe('active');
  });

  it('returns 404 when mandate_id not in DB', async () => {
    const state: MockState = { rows: [] };
    const remote = async () => ({ success: true, status: 'cancelled' });
    const result = await cancelMandate(makeAppDb(state), 'MISSING', remote);
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/not found/);
  });

  it('handles already-cancelled gracefully (remote success with status)', async () => {
    const state: MockState = {
      rows: [emptyMandate({ id: 1, mandate_id: 'MD_X', mandate_status: 'active' })],
    };
    const remote = async () => ({
      success: true,
      status: 'cancelled',
      alreadyCancelled: true,
    });
    const result = await cancelMandate(makeAppDb(state), 'MD_X', remote);
    expect(result.success).toBe(true);
    expect(state.rows[0]?.mandate_status).toBe('cancelled');
  });

  it('rejects empty mandate_id', async () => {
    const state: MockState = { rows: [] };
    const result = await cancelMandate(makeAppDb(state), '', async () => ({ success: true }));
    expect(result.success).toBe(false);
  });
});

describe('unlinkMandate', () => {
  it('marks the row __UNLINKED__ when currently linked', async () => {
    const state: MockState = {
      rows: [emptyMandate({ id: 1, mandate_id: 'MD_X', opera_account: 'CUST01' })],
    };
    const result = await unlinkMandate(makeAppDb(state), 'MD_X');
    expect(result.success).toBe(true);
    expect(state.rows[0]?.opera_account).toBe('__UNLINKED__');
  });

  it('returns not-found when mandate already unlinked', async () => {
    const state: MockState = {
      rows: [
        emptyMandate({
          id: 1,
          mandate_id: 'MD_X',
          opera_account: '__UNLINKED__',
        }),
      ],
    };
    const result = await unlinkMandate(makeAppDb(state), 'MD_X');
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/not found/);
  });

  it('rejects empty mandate_id', async () => {
    const result = await unlinkMandate(makeAppDb({ rows: [] }), '');
    expect(result.success).toBe(false);
  });
});

describe('linkMandate', () => {
  it('inserts a new (account, mandate) row', async () => {
    const state: MockState = { rows: [] };
    const result = await linkMandate(makeAppDb(state), {
      operaAccount: 'CUST01',
      mandateId: 'MD_NEW',
      operaName: 'Acme Ltd',
      gocardlessCustomerId: 'CU1',
      email: 'a@b.com',
    });
    expect(result.success).toBe(true);
    expect(result.mandate?.opera_account).toBe('CUST01');
    expect(result.mandate?.mandate_id).toBe('MD_NEW');
    expect(state.rows).toHaveLength(1);
    expect(state.rows[0]?.email).toBe('a@b.com');
  });

  it('updates an existing (account, mandate) row instead of duplicating', async () => {
    const state: MockState = {
      rows: [
        emptyMandate({
          id: 1,
          mandate_id: 'MD1',
          opera_account: 'CUST01',
          mandate_status: 'pending_submission',
          email: 'old@b.com',
        }),
      ],
    };
    const result = await linkMandate(makeAppDb(state), {
      operaAccount: 'CUST01',
      mandateId: 'MD1',
      mandateStatus: 'active',
      email: 'new@b.com',
    });
    expect(result.success).toBe(true);
    expect(state.rows).toHaveLength(1);
    expect(state.rows[0]?.mandate_status).toBe('active');
    expect(state.rows[0]?.email).toBe('new@b.com');
  });

  it('removes __UNLINKED__ placeholder when linking the same mandate to a real account', async () => {
    const state: MockState = {
      rows: [
        emptyMandate({
          id: 1,
          mandate_id: 'MD1',
          opera_account: '__UNLINKED__',
          opera_name: '',
        }),
      ],
    };
    const result = await linkMandate(makeAppDb(state), {
      operaAccount: 'CUST01',
      mandateId: 'MD1',
      operaName: 'Acme Ltd',
    });
    expect(result.success).toBe(true);
    expect(
      state.rows.find((r) => r.opera_account === '__UNLINKED__'),
    ).toBeUndefined();
    expect(state.rows.find((r) => r.opera_account === 'CUST01')).toBeDefined();
  });

  it('refuses re-link to a different account without confirm=true', async () => {
    const state: MockState = {
      rows: [
        emptyMandate({
          id: 1,
          mandate_id: 'MD1',
          opera_account: 'OLD_ACCT',
          opera_name: 'Old Inc',
        }),
      ],
    };
    const result = await linkMandate(makeAppDb(state), {
      operaAccount: 'CUST01',
      mandateId: 'MD1',
    });
    expect(result.success).toBe(false);
    expect(result.needsConfirm).toBe(true);
    expect(result.oldOperaAccount).toBe('OLD_ACCT');
    expect(state.rows).toHaveLength(1);
    expect(state.rows[0]?.opera_account).toBe('OLD_ACCT');
  });

  it('proceeds with re-link when confirm=true (drops old row)', async () => {
    const state: MockState = {
      rows: [
        emptyMandate({
          id: 1,
          mandate_id: 'MD1',
          opera_account: 'OLD_ACCT',
        }),
      ],
    };
    const result = await linkMandate(makeAppDb(state), {
      operaAccount: 'CUST01',
      mandateId: 'MD1',
      confirm: true,
    });
    expect(result.success).toBe(true);
    expect(result.oldOperaAccount).toBe('OLD_ACCT');
    expect(
      state.rows.find((r) => r.opera_account === 'OLD_ACCT'),
    ).toBeUndefined();
    expect(state.rows.find((r) => r.opera_account === 'CUST01')).toBeDefined();
  });

  it('rejects empty inputs', async () => {
    const state: MockState = { rows: [] };
    const result = await linkMandate(makeAppDb(state), {
      operaAccount: '',
      mandateId: 'X',
    });
    expect(result.success).toBe(false);
    const result2 = await linkMandate(makeAppDb(state), {
      operaAccount: 'CUST01',
      mandateId: '',
    });
    expect(result2.success).toBe(false);
  });
});

describe('normaliseCompanyName', () => {
  it('strips common company suffixes', () => {
    expect(normaliseCompanyName('Acme Ltd')).toBe('ACME');
    expect(normaliseCompanyName('Acme Limited')).toBe('ACME');
    expect(normaliseCompanyName('Beta PLC')).toBe('BETA');
    expect(normaliseCompanyName('Gamma Inc')).toBe('GAMMA');
    expect(normaliseCompanyName('Delta Co')).toBe('DELTA');
  });
  it('handles empty / null safely', () => {
    expect(normaliseCompanyName('')).toBe('');
    expect(normaliseCompanyName(null)).toBe('');
    expect(normaliseCompanyName(undefined)).toBe('');
  });
  it('uppercases and trims', () => {
    expect(normaliseCompanyName('  acme inc  ')).toBe('ACME');
  });
});

describe('findOperaCustomerMatch', () => {
  const customers = [
    { account: 'CUST01', name: 'Acme Ltd' },
    { account: 'CUST02', name: 'Beta Trading PLC' },
    { account: 'CUST03', name: 'Gamma' },
  ];

  it('matches exactly after normalisation', () => {
    expect(findOperaCustomerMatch('ACME LIMITED', customers)?.account).toBe(
      'CUST01',
    );
  });

  it('matches partial when one name contains the other', () => {
    expect(findOperaCustomerMatch('Beta', customers)?.account).toBe('CUST02');
    expect(findOperaCustomerMatch('Gamma Solutions', customers)?.account).toBe(
      'CUST03',
    );
  });

  it('returns null when no match found', () => {
    expect(findOperaCustomerMatch('Unknown Co', customers)).toBeNull();
  });

  it('returns null for empty input', () => {
    expect(findOperaCustomerMatch('', customers)).toBeNull();
  });
});

describe('syncMandatesFromGocardless', () => {
  it('inserts new mandates with __UNLINKED__ when no Opera match', async () => {
    const state: MockState = { rows: [] };
    const fetchPage = async () => ({
      mandates: [{ id: 'MD1', status: 'active', links: { customer: 'CU1' } }],
      after: null,
    });
    const fetchCustomer = async () => ({
      company_name: 'Unknown Co',
      email: 'u@u.com',
    });
    const result = await syncMandatesFromGocardless(
      makeAppDb(state),
      fetchPage,
      fetchCustomer,
      [],
    );
    expect(result.success).toBe(true);
    expect(result.synced_count).toBe(1);
    expect(result.new_count).toBe(1);
    expect(result.auto_linked_count).toBe(0);
    expect(state.rows[0]?.opera_account).toBe('__UNLINKED__');
    expect(state.rows[0]?.email).toBe('u@u.com');
  });

  it('auto-links new mandates when Opera customer matches by name', async () => {
    const state: MockState = { rows: [] };
    const fetchPage = async () => ({
      mandates: [{ id: 'MD1', status: 'active', links: { customer: 'CU1' } }],
      after: null,
    });
    const fetchCustomer = async () => ({ company_name: 'Acme Limited' });
    const result = await syncMandatesFromGocardless(
      makeAppDb(state),
      fetchPage,
      fetchCustomer,
      [{ account: 'CUST01', name: 'Acme Ltd' }],
    );
    expect(result.success).toBe(true);
    expect(result.auto_linked_count).toBe(1);
    expect(result.new_count).toBe(1);
    expect(state.rows[0]?.opera_account).toBe('CUST01');
  });

  it('updates existing linked mandate metadata without changing account', async () => {
    const state: MockState = {
      rows: [
        emptyMandate({
          id: 1,
          mandate_id: 'MD1',
          opera_account: 'CUST01',
          mandate_status: 'pending_submission',
        }),
      ],
    };
    const fetchPage = async () => ({
      mandates: [
        { id: 'MD1', status: 'active', scheme: 'bacs', links: { customer: 'CU1' } },
      ],
      after: null,
    });
    const fetchCustomer = async () => ({ company_name: 'Acme Ltd' });
    const result = await syncMandatesFromGocardless(
      makeAppDb(state),
      fetchPage,
      fetchCustomer,
      [],
    );
    expect(result.success).toBe(true);
    expect(result.updated_count).toBe(1);
    expect(state.rows).toHaveLength(1);
    expect(state.rows[0]?.opera_account).toBe('CUST01');
    expect(state.rows[0]?.mandate_status).toBe('active');
  });

  it('upgrades __UNLINKED__ placeholder to a real link when Opera match found', async () => {
    const state: MockState = {
      rows: [
        emptyMandate({
          id: 1,
          mandate_id: 'MD1',
          opera_account: '__UNLINKED__',
          opera_name: 'Beta Trading',
        }),
      ],
    };
    const fetchPage = async () => ({
      mandates: [{ id: 'MD1', status: 'active', links: { customer: 'CU1' } }],
      after: null,
    });
    const fetchCustomer = async () => ({ company_name: 'Beta Trading PLC' });
    const result = await syncMandatesFromGocardless(
      makeAppDb(state),
      fetchPage,
      fetchCustomer,
      [{ account: 'CUST02', name: 'Beta Trading' }],
    );
    expect(result.auto_linked_count).toBe(1);
    expect(state.rows.some((r) => r.opera_account === 'CUST02')).toBe(true);
    // Placeholder cleaned up
    expect(state.rows.some((r) => r.opera_account === '__UNLINKED__')).toBe(false);
  });

  it('paginates through multiple pages', async () => {
    const state: MockState = { rows: [] };
    const pages = [
      {
        mandates: [{ id: 'MD1', status: 'active', links: { customer: 'CU1' } }],
        after: 'CUR1',
      },
      {
        mandates: [{ id: 'MD2', status: 'active', links: { customer: 'CU2' } }],
        after: null,
      },
    ];
    let i = 0;
    const fetchPage = async () => pages[i++] ?? { mandates: [], after: null };
    const fetchCustomer = async () => ({ company_name: 'X' });
    const result = await syncMandatesFromGocardless(
      makeAppDb(state),
      fetchPage,
      fetchCustomer,
      [],
    );
    expect(result.synced_count).toBe(2);
    expect(state.rows).toHaveLength(2);
  });

  it('skips remote mandates without an id', async () => {
    const state: MockState = { rows: [] };
    const fetchPage = async () => ({
      mandates: [
        { id: '', status: 'active', links: { customer: 'CU1' } },
        { id: 'MD1', status: 'active', links: { customer: 'CU1' } },
      ],
      after: null,
    });
    const fetchCustomer = async () => ({ company_name: 'X' });
    const result = await syncMandatesFromGocardless(
      makeAppDb(state),
      fetchPage,
      fetchCustomer,
      [],
    );
    expect(result.synced_count).toBe(1);
  });

  it('cleans up duplicate __UNLINKED__ rows when a linked row exists', async () => {
    const state: MockState = {
      rows: [
        emptyMandate({
          id: 1,
          mandate_id: 'MD1',
          opera_account: '__UNLINKED__',
          opera_name: 'Acme',
        }),
        emptyMandate({
          id: 2,
          mandate_id: 'MD1',
          opera_account: 'CUST01',
          opera_name: 'Acme Ltd',
        }),
      ],
    };
    const fetchPage = async () => ({ mandates: [], after: null });
    const fetchCustomer = async () => null;
    await syncMandatesFromGocardless(
      makeAppDb(state),
      fetchPage,
      fetchCustomer,
      [],
    );
    expect(
      state.rows.find((r) => r.opera_account === '__UNLINKED__'),
    ).toBeUndefined();
    expect(
      state.rows.find((r) => r.opera_account === 'CUST01'),
    ).toBeDefined();
  });

  it('does not throw when fetchCustomer fails', async () => {
    const state: MockState = { rows: [] };
    const fetchPage = async () => ({
      mandates: [{ id: 'MD1', status: 'active', links: { customer: 'CU1' } }],
      after: null,
    });
    const fetchCustomer = async () => {
      throw new Error('upstream unavailable');
    };
    const result = await syncMandatesFromGocardless(
      makeAppDb(state),
      fetchPage,
      fetchCustomer,
      [],
    );
    expect(result.success).toBe(true);
    expect(result.synced_count).toBe(1);
    expect(state.rows[0]?.opera_account).toBe('__UNLINKED__');
  });
});
