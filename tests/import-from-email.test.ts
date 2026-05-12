import { describe, it, expect, vi } from 'vitest';
import {
  importGocardlessBatchFromEmail,
  type EmailArchiveAdapter,
} from '../src/services/import-from-email.js';
import type {
  BatchPostingExecutor,
  ImportLockAdapter,
  IncomingPayment,
} from '../src/services/import-batch.js';

// Reuse the OperaDb mock from import-batch.test.ts patterns
function makeOperaDb(state: {
  banks: Array<{ nk_acnt: string; nk_sort: string; nk_number: string; nk_desc: string }>;
}): any {
  const db: any = (table: string) => {
    if (table !== 'nbank') throw new Error(`Unexpected table: ${table}`);
    let codeFilter: string | null = null;
    const builder: any = {
      whereRaw: (sql: string, params: any[]) => {
        if (sql.includes('RTRIM(nk_acnt)')) codeFilter = params?.[0] ?? null;
        return builder;
      },
      select: () => builder,
      first: async () =>
        codeFilter
          ? state.banks.find((b) => b.nk_acnt.trim() === codeFilter)
          : undefined,
      then: async (resolve: any) => resolve(state.banks),
    };
    return builder;
  };
  db.fn = { now: () => '__NOW__' };
  db.raw = async (sql: string) => {
    const s = sql.toLowerCase();
    if (s.includes('seqco')) {
      return [{ co_curcde: 'GBP', co_curdes: 'Sterling', co_opanl: 'N', co_rtupdnl: 'N' }];
    }
    if (s.includes('xcurcy')) {
      return [{ xc_currcde: 'GBP', xc_desc: 'Sterling' }];
    }
    if (s.includes('nclndd') && s.includes('ncd_period') && !s.includes('ncd_year = ?')) {
      return [{ ncd_period: 4, ncd_year: 2026 }];
    }
    if (s.includes('nclndd')) {
      return [{ period_status: 0 }];
    }
    if (s.includes('np_year') && s.includes('np_perno')) {
      return [{ np_year: 2026, np_perno: 4, np_periods: 12 }];
    }
    return [];
  };
  return db;
}

function makeAppDb(): any {
  const db: any = (_table: string) => {
    const builder: any = {
      where: () => builder,
      andWhere: () => builder,
      first: async () => undefined,
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
    auto_allocate: true,
  },
];

const KNOWN_BANKS = [
  {
    nk_acnt: 'BC010',
    nk_desc: 'Barclays Current',
    nk_sort: '20-00-00',
    nk_number: '12345678',
  },
];

describe('importGocardlessBatchFromEmail', () => {
  it('rejects when email_id is missing or invalid', async () => {
    const executor: BatchPostingExecutor = { postBatch: vi.fn() };
    const lock: ImportLockAdapter = {
      acquire: vi.fn().mockResolvedValue(true),
      release: vi.fn(),
    };
    const archive: EmailArchiveAdapter = {
      archive: vi.fn(),
    };
    const result = await importGocardlessBatchFromEmail(
      makeOperaDb({ banks: KNOWN_BANKS }),
      makeAppDb(),
      {
        emailId: 0, // invalid
        bankCode: 'BC010',
        postDate: '2026-04-30',
        payments: SAMPLE_PAYMENTS,
      },
      {},
      [],
      executor,
      lock,
      archive,
    );
    expect(result.success).toBe(false);
    expect(executor.postBatch).not.toHaveBeenCalled();
  });

  it('imports successfully and archives the email', async () => {
    const executor: BatchPostingExecutor = {
      postBatch: vi.fn().mockResolvedValue({
        success: true,
        records_imported: 1,
        batch_ref: 'B-1',
        warnings: [],
        errors: [],
      }),
    };
    const lock: ImportLockAdapter = {
      acquire: vi.fn().mockResolvedValue(true),
      release: vi.fn().mockResolvedValue(undefined),
    };
    const archive: EmailArchiveAdapter = {
      archive: vi.fn().mockResolvedValue('archived'),
    };
    const result = await importGocardlessBatchFromEmail(
      makeOperaDb({ banks: KNOWN_BANKS }),
      makeAppDb(),
      {
        emailId: 42,
        bankCode: 'BC010',
        postDate: '2026-04-30',
        payments: SAMPLE_PAYMENTS,
      },
      {},
      [],
      executor,
      lock,
      archive,
    );
    expect(result.success).toBe(true);
    expect(result.email_id).toBe(42);
    expect(result.archive_status).toBe('archived');
    expect(archive.archive).toHaveBeenCalledWith({
      emailId: 42,
      archiveFolder: 'Archive/GoCardless',
    });
  });

  it('reports provider_not_available when no archive adapter', async () => {
    const executor: BatchPostingExecutor = {
      postBatch: vi.fn().mockResolvedValue({
        success: true,
        records_imported: 1,
        warnings: [],
        errors: [],
      }),
    };
    const lock: ImportLockAdapter = {
      acquire: vi.fn().mockResolvedValue(true),
      release: vi.fn().mockResolvedValue(undefined),
    };
    const result = await importGocardlessBatchFromEmail(
      makeOperaDb({ banks: KNOWN_BANKS }),
      makeAppDb(),
      {
        emailId: 42,
        bankCode: 'BC010',
        postDate: '2026-04-30',
        payments: SAMPLE_PAYMENTS,
      },
      {},
      [],
      executor,
      lock,
      null,
    );
    expect(result.success).toBe(true);
    expect(result.archive_status).toBe('provider_not_available');
  });

  it('surfaces archive errors without failing the import', async () => {
    const executor: BatchPostingExecutor = {
      postBatch: vi.fn().mockResolvedValue({
        success: true,
        records_imported: 1,
        warnings: [],
        errors: [],
      }),
    };
    const lock: ImportLockAdapter = {
      acquire: vi.fn().mockResolvedValue(true),
      release: vi.fn().mockResolvedValue(undefined),
    };
    const archive: EmailArchiveAdapter = {
      archive: vi.fn().mockRejectedValue(new Error('graph 503')),
    };
    const result = await importGocardlessBatchFromEmail(
      makeOperaDb({ banks: KNOWN_BANKS }),
      makeAppDb(),
      {
        emailId: 42,
        bankCode: 'BC010',
        postDate: '2026-04-30',
        payments: SAMPLE_PAYMENTS,
      },
      {},
      [],
      executor,
      lock,
      archive,
    );
    expect(result.success).toBe(true);
    expect(result.archive_status).toMatch(/^error:/);
  });

  it('does not archive when import fails', async () => {
    const executor: BatchPostingExecutor = {
      postBatch: vi.fn().mockResolvedValue({
        success: false,
        records_imported: 0,
        warnings: [],
        errors: ['posting failed'],
      }),
    };
    const lock: ImportLockAdapter = {
      acquire: vi.fn().mockResolvedValue(true),
      release: vi.fn().mockResolvedValue(undefined),
    };
    const archive: EmailArchiveAdapter = {
      archive: vi.fn(),
    };
    const result = await importGocardlessBatchFromEmail(
      makeOperaDb({ banks: KNOWN_BANKS }),
      makeAppDb(),
      {
        emailId: 42,
        bankCode: 'BC010',
        postDate: '2026-04-30',
        payments: SAMPLE_PAYMENTS,
      },
      {},
      [],
      executor,
      lock,
      archive,
    );
    expect(result.success).toBe(false);
    expect(result.email_id).toBe(42);
    expect(archive.archive).not.toHaveBeenCalled();
  });
});
