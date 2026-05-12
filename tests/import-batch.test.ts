import { describe, it, expect, vi } from 'vitest';
import {
  validateImportRequest,
  importGocardlessBatch,
  resolveDestinationBank,
  type BatchPostingExecutor,
  type ImportLockAdapter,
  type IncomingPayment,
} from '../src/services/import-batch.js';

interface OperaState {
  banks: Array<{
    nk_acnt: string;
    nk_desc: string;
    nk_sort: string;
    nk_number: string;
  }>;
  homeCurrency?: { code: string; description: string };
  periodValid?: boolean;
}

function makeOperaDb(state: OperaState): any {
  const db: any = (table: string) => {
    if (table !== 'nbank') {
      throw new Error(`Unexpected operaDb table: ${table}`);
    }
    let rawWhereSql: string | null = null;
    let rawWhereParams: any[] | null = null;

    const builder: any = {
      whereRaw: (sql: string, params: any[]) => {
        rawWhereSql = sql;
        rawWhereParams = params;
        return builder;
      },
      select: () => builder,
      first: async () => {
        if (rawWhereSql && rawWhereSql.includes('RTRIM(nk_acnt)')) {
          const code = rawWhereParams?.[0];
          const found = state.banks.find((b) => b.nk_acnt.trim() === code);
          return found;
        }
        return undefined;
      },
      then: async (resolve: any) => {
        return resolve(state.banks);
      },
    };
    return builder;
  };
  db.fn = { now: () => '__NOW__' };
  db.raw = (sql: string) => sql;
  return db;
}

function makeOperaDbWithCurrency(state: OperaState): any {
  const db = makeOperaDb(state);
  // override raw for period + home-currency lookups
  db.raw = async (sql: string, _params?: any) => {
    const s = sql.toLowerCase();
    if (s.includes('xcurcy')) {
      return state.homeCurrency
        ? [
            {
              xc_currcde: state.homeCurrency.code,
              xc_desc: state.homeCurrency.description,
            },
          ]
        : [];
    }
    if (s.includes('seqco')) {
      return [
        {
          co_curcde: state.homeCurrency?.code ?? 'GBP',
          co_curdes: state.homeCurrency?.description ?? 'Sterling',
          co_opanl: 'N',
          co_rtupdnl: 'N',
        },
      ];
    }
    if (s.includes('nclndd')) {
      // Could be getPeriodForDate (returns ncd_period, ncd_year) or
      // getPeriodStatus (returns the ledger status column).
      if (s.includes('ncd_period') && s.includes('ncd_year') && !s.includes('ncd_year = ?')) {
        return [{ ncd_period: 4, ncd_year: 2026 }];
      }
      if (s.includes('ncd_slstat') || s.includes('ncd_nlstat') || s.includes('ncd_plstat')) {
        return [{ period_status: state.periodValid === false ? 2 : 0 }];
      }
      return [];
    }
    if (s.includes('np_year') && s.includes('np_perno')) {
      return [{ np_year: 2026, np_perno: 4, np_periods: 12 }];
    }
    return [];
  };
  return db;
}

function makeAppDb(opts: { existingPayouts?: string[] } = {}): any {
  const db: any = (table: string) => {
    if (table !== 'gocardless_imports') {
      throw new Error(`Unexpected appDb table: ${table}`);
    }
    let payoutIdFilter: string | null = null;
    const builder: any = {
      where: (cond: any) => {
        if (typeof cond === 'object' && cond.payout_id) {
          payoutIdFilter = cond.payout_id;
        }
        return builder;
      },
      andWhere: () => builder,
      first: async () => {
        if (
          payoutIdFilter &&
          (opts.existingPayouts ?? []).includes(payoutIdFilter)
        ) {
          return { id: 1 };
        }
        return undefined;
      },
      insert: async () => [1],
    };
    return builder;
  };
  db.fn = { now: () => '__NOW__' };
  return db;
}

const SAMPLE_PAYMENTS: IncomingPayment[] = [
  {
    customer_account: 'A001',
    customer_name: 'Acme Ltd',
    amount: 100,
    mandate_id: 'MD001',
    auto_allocate: true,
  },
  {
    customer_account: 'A002',
    customer_name: 'Beta plc',
    amount: 50,
    mandate_id: 'MD002',
    auto_allocate: true,
  },
];

const KNOWN_BANKS: OperaState['banks'] = [
  {
    nk_acnt: 'BC010',
    nk_desc: 'Barclays Current',
    nk_sort: '20-00-00',
    nk_number: '12345678',
  },
];

describe('validateImportRequest', () => {
  it('rejects empty payments', async () => {
    const result = await validateImportRequest(
      makeOperaDbWithCurrency({ banks: KNOWN_BANKS, periodValid: true }),
      makeAppDb(),
      {
        bankCode: 'BC010',
        postDate: '2026-04-30',
        payments: [],
      },
      {},
      [],
    );
    expect(result.success).toBe(false);
  });

  it('rejects already-imported payout id', async () => {
    const result = await validateImportRequest(
      makeOperaDbWithCurrency({ banks: KNOWN_BANKS, periodValid: true }),
      makeAppDb({ existingPayouts: ['PO_123'] }),
      {
        bankCode: 'BC010',
        postDate: '2026-04-30',
        payments: SAMPLE_PAYMENTS,
        payoutId: 'PO_123',
      },
      {},
      [],
    );
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.duplicate_payout).toBe(true);
    }
  });

  it('rejects payment with missing customer_account', async () => {
    const result = await validateImportRequest(
      makeOperaDbWithCurrency({ banks: KNOWN_BANKS, periodValid: true }),
      makeAppDb(),
      {
        bankCode: 'BC010',
        postDate: '2026-04-30',
        payments: [
          {
            customer_account: '',
            amount: 100,
          } as IncomingPayment,
        ],
      },
      {},
      [],
    );
    expect(result.success).toBe(false);
  });

  it('rejects mismatched mandate→customer pairing', async () => {
    const result = await validateImportRequest(
      makeOperaDbWithCurrency({ banks: KNOWN_BANKS, periodValid: true }),
      makeAppDb(),
      {
        bankCode: 'BC010',
        postDate: '2026-04-30',
        payments: [
          {
            customer_account: 'A999', // wrong account
            customer_name: 'Acme',
            amount: 100,
            mandate_id: 'MD001',
          },
        ],
      },
      {},
      [{ mandate_id: 'MD001', opera_account: 'A001' }],
    );
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toMatch(/mandate MD001 belongs to account A001/);
    }
  });

  it('rejects fees > 0 without fees_nominal_account', async () => {
    const result = await validateImportRequest(
      makeOperaDbWithCurrency({ banks: KNOWN_BANKS, periodValid: true }),
      makeAppDb(),
      {
        bankCode: 'BC010',
        postDate: '2026-04-30',
        payments: SAMPLE_PAYMENTS,
        goCardlessFees: 5,
      },
      {},
      [],
    );
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toMatch(/Fees Nominal Account not configured/);
    }
  });

  it('rejects foreign currency batches when home currency differs', async () => {
    const result = await validateImportRequest(
      makeOperaDbWithCurrency({
        banks: KNOWN_BANKS,
        homeCurrency: { code: 'GBP', description: 'Sterling' },
        periodValid: true,
      }),
      makeAppDb(),
      {
        bankCode: 'BC010',
        postDate: '2026-04-30',
        payments: SAMPLE_PAYMENTS,
        currency: 'EUR',
      },
      {},
      [],
    );
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toMatch(/Foreign currency GoCardless batches/);
    }
  });

  it('accepts a valid batch and surfaces duplicate-customer warnings', async () => {
    const result = await validateImportRequest(
      makeOperaDbWithCurrency({ banks: KNOWN_BANKS, periodValid: true }),
      makeAppDb(),
      {
        bankCode: 'BC010',
        postDate: '2026-04-30',
        payments: [
          {
            customer_account: 'A001',
            customer_name: 'Acme',
            amount: 100,
          },
          {
            customer_account: 'A001',
            customer_name: 'Acme',
            amount: 100,
          },
        ],
      },
      {},
      [],
    );
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.request.warnings.length).toBeGreaterThan(0);
      expect(result.request.warnings[0]).toMatch(/Duplicate/);
    }
  });
});

describe('resolveDestinationBank', () => {
  it('resolves by sort code + account number', async () => {
    const result = await resolveDestinationBank(
      makeOperaDb({ banks: KNOWN_BANKS }),
      'BC010',
      '20-00-00',
      '12345678',
    );
    expect(result).toBe('BC010');
  });
  it('resolves by sort code only when no account given', async () => {
    const result = await resolveDestinationBank(
      makeOperaDb({ banks: KNOWN_BANKS }),
      'BC010',
      '20-00-00',
      null,
    );
    expect(result).toBe('BC010');
  });
  it('falls back to default when nothing matches', async () => {
    const result = await resolveDestinationBank(
      makeOperaDb({ banks: KNOWN_BANKS }),
      'BC010',
      '99-99-99',
      '00000000',
    );
    expect(result).toBe('BC010');
  });
});

describe('importGocardlessBatch', () => {
  it('acquires lock, posts batch, releases lock', async () => {
    const acquire = vi.fn().mockResolvedValue(true);
    const release = vi.fn().mockResolvedValue(undefined);
    const lock: ImportLockAdapter = { acquire, release };
    const postBatch = vi.fn().mockResolvedValue({
      success: true,
      records_imported: 2,
      batch_ref: 'BATCH-1',
      warnings: [],
      errors: [],
    });
    const executor: BatchPostingExecutor = { postBatch };

    const result = await importGocardlessBatch(
      makeOperaDbWithCurrency({ banks: KNOWN_BANKS, periodValid: true }),
      makeAppDb(),
      {
        bankCode: 'BC010',
        postDate: '2026-04-30',
        payments: SAMPLE_PAYMENTS,
        completeBatch: true,
      },
      {},
      [],
      executor,
      lock,
    );

    expect(result.success).toBe(true);
    expect(result.payments_imported).toBe(2);
    expect(acquire).toHaveBeenCalled();
    expect(release).toHaveBeenCalled();
    expect(postBatch).toHaveBeenCalled();
  });

  it('returns 503-style message when lock cannot be acquired', async () => {
    const acquire = vi.fn().mockResolvedValue(false);
    const release = vi.fn();
    const lock: ImportLockAdapter = { acquire, release };
    const postBatch = vi.fn();
    const executor: BatchPostingExecutor = { postBatch };

    const result = await importGocardlessBatch(
      makeOperaDbWithCurrency({ banks: KNOWN_BANKS, periodValid: true }),
      makeAppDb(),
      {
        bankCode: 'BC010',
        postDate: '2026-04-30',
        payments: SAMPLE_PAYMENTS,
      },
      {},
      [],
      executor,
      lock,
    );
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/currently being imported/);
    expect(postBatch).not.toHaveBeenCalled();
  });

  it('releases the lock even when the executor fails', async () => {
    const acquire = vi.fn().mockResolvedValue(true);
    const release = vi.fn().mockResolvedValue(undefined);
    const lock: ImportLockAdapter = { acquire, release };
    const postBatch = vi.fn().mockRejectedValue(new Error('database down'));
    const executor: BatchPostingExecutor = { postBatch };

    await expect(
      importGocardlessBatch(
        makeOperaDbWithCurrency({ banks: KNOWN_BANKS, periodValid: true }),
        makeAppDb(),
        {
          bankCode: 'BC010',
          postDate: '2026-04-30',
          payments: SAMPLE_PAYMENTS,
        },
        {},
        [],
        executor,
        lock,
      ),
    ).rejects.toThrow('database down');
    expect(release).toHaveBeenCalled();
  });
});
