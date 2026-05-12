import { describe, it, expect } from 'vitest';
import {
  scanGocardlessEmails,
  type EmailMailboxAdapter,
  type ScannedEmail,
} from '../src/services/scan-emails.js';

// ---------------------------------------------------------------------
// Mock factories
// ---------------------------------------------------------------------

function makeAppDb(opts: {
  importedEmailIds?: number[];
  importedRefs?: string[];
}): any {
  const db: any = (table: string) => {
    if (table !== 'gocardless_imports') {
      throw new Error(`Unexpected appDb table: ${table}`);
    }
    let mode: 'email_ids' | 'refs' | 'unknown' = 'unknown';
    const builder: any = {
      whereNotNull: (col: string) => {
        if (col === 'email_id') mode = 'email_ids';
        if (col === 'bank_reference') mode = 'refs';
        return builder;
      },
      andWhere: () => builder,
      distinct: () => builder,
      select: async () => {
        if (mode === 'email_ids') {
          return (opts.importedEmailIds ?? []).map((id) => ({ email_id: id }));
        }
        if (mode === 'refs') {
          return (opts.importedRefs ?? []).map((r) => ({ bank_reference: r }));
        }
        return [];
      },
    };
    return builder;
  };
  db.fn = { now: () => '__NOW__' };
  return db;
}

interface OperaState {
  homeCurrency: { code: string };
  periodInfo: { np_year: number; np_perno: number; np_periods: number };
  /** When true, all duplicate checks return no rows. */
  noDuplicates?: boolean;
  /** When true, validate posting period returns valid. */
  periodValid?: boolean;
}

function makeOperaDb(state: OperaState): any {
  const db: any = (_table: string) => {
    const builder: any = {
      where: () => builder,
      andWhere: () => builder,
      andWhereRaw: () => builder,
      whereIn: () => builder,
      whereRaw: () => builder,
      orderBy: () => builder,
      orderByRaw: () => builder,
      groupBy: () => builder,
      having: () => builder,
      havingRaw: () => builder,
      join: () => builder,
      select: async () => [],
      first: async () => undefined,
    };
    return builder;
  };
  db.raw = async (sql: string) => {
    if (sql.includes('seqco')) {
      return [{ co_curcde: state.homeCurrency.code }];
    }
    if (sql.includes('nparm') && sql.includes('np_perno')) {
      return [
        {
          np_year: state.periodInfo.np_year,
          np_perno: state.periodInfo.np_perno,
          np_periods: state.periodInfo.np_periods,
        },
      ];
    }
    if (sql.includes('nclndd')) {
      return [
        {
          ncd_year: state.periodInfo.np_year,
          ncd_perno: state.periodInfo.np_perno,
          ncd_slstat: state.periodValid === false ? 2 : 0,
          ncd_nlstat: 0,
          ncd_plstat: 0,
        },
      ];
    }
    if (sql.includes('co_opanl') || sql.includes('co_rtupdnl')) {
      return [{ co_opanl: 'N', co_rtupdnl: 'N' }];
    }
    return [];
  };
  db.fn = { now: () => '__NOW__' };
  return db;
}

const SAMPLE_EMAIL_HORIZONTAL: ScannedEmail = {
  id: 101,
  subject: 'GoCardless: 9.50 GBP paid out',
  body_text: `Subject: GoCardless: 9.50 GBP paid out
Reference: INTSYSUKLTD-PAY-ABC

Customer    Description    Amount
Acme Ltd    Intsys INV12345    10.00 GBP

Gross amount    10.00 GBP
GoCardless fees    -0.50 GBP
Net amount    9.50 GBP
`,
  received_at: '2026-04-15T08:00:00Z',
  from_address: 'noreply@gocardless.com',
};

function makeMailbox(emails: ScannedEmail[], options: {
  syncFails?: boolean;
} = {}): EmailMailboxAdapter {
  return {
    sync: options.syncFails
      ? async () => {
          throw new Error('IMAP unavailable');
        }
      : async () => undefined,
    list: async () => ({ emails }),
  };
}

// ---------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------

describe('scanGocardlessEmails', () => {
  it('returns no batches when mailbox is empty', async () => {
    const result = await scanGocardlessEmails(
      makeOperaDb({
        homeCurrency: { code: 'GBP' },
        periodInfo: { np_year: 2026, np_perno: 4, np_periods: 12 },
        noDuplicates: true,
        periodValid: true,
      }),
      makeAppDb({}),
      makeMailbox([]),
      {},
    );
    expect(result.success).toBe(true);
    expect(result.total_emails).toBe(0);
    expect(result.batches).toEqual([]);
  });

  it('parses a horizontal-format payout email and includes the batch', async () => {
    const result = await scanGocardlessEmails(
      makeOperaDb({
        homeCurrency: { code: 'GBP' },
        periodInfo: { np_year: 2026, np_perno: 4, np_periods: 12 },
        noDuplicates: true,
        periodValid: true,
      }),
      makeAppDb({}),
      makeMailbox([SAMPLE_EMAIL_HORIZONTAL]),
      {},
    );
    expect(result.success).toBe(true);
    expect(result.parsed_count).toBe(1);
    expect(result.batches?.length).toBe(1);
    const batch = result.batches?.[0];
    expect(batch?.batch.gross_amount).toBe(10);
    expect(batch?.batch.net_amount).toBe(9.5);
    expect(batch?.batch.bank_reference).toBe('INTSYSUKLTD-PAY-ABC');
    expect(batch?.batch.payments[0]?.customer_name).toBe('Acme Ltd');
    expect(batch?.is_foreign_currency).toBe(false);
    expect(batch?.home_currency).toBe('GBP');
  });

  it('skips emails already in import history (by email_id)', async () => {
    const result = await scanGocardlessEmails(
      makeOperaDb({
        homeCurrency: { code: 'GBP' },
        periodInfo: { np_year: 2026, np_perno: 4, np_periods: 12 },
        noDuplicates: true,
        periodValid: true,
      }),
      makeAppDb({ importedEmailIds: [101] }),
      makeMailbox([SAMPLE_EMAIL_HORIZONTAL]),
      {},
    );
    expect(result.skipped_already_imported).toBe(1);
    expect(result.batches?.length).toBe(0);
  });

  it('skips batches whose bank_reference was already imported', async () => {
    const result = await scanGocardlessEmails(
      makeOperaDb({
        homeCurrency: { code: 'GBP' },
        periodInfo: { np_year: 2026, np_perno: 4, np_periods: 12 },
        noDuplicates: true,
        periodValid: true,
      }),
      makeAppDb({ importedRefs: ['INTSYSUKLTD-PAY-ABC'] }),
      makeMailbox([SAMPLE_EMAIL_HORIZONTAL]),
      {},
    );
    expect(result.skipped_already_imported).toBe(1);
    expect(result.batches?.length).toBe(0);
  });

  it('filters by company_reference (override beats settings)', async () => {
    const result = await scanGocardlessEmails(
      makeOperaDb({
        homeCurrency: { code: 'GBP' },
        periodInfo: { np_year: 2026, np_perno: 4, np_periods: 12 },
        noDuplicates: true,
        periodValid: true,
      }),
      makeAppDb({}),
      makeMailbox([SAMPLE_EMAIL_HORIZONTAL]),
      { companyReferenceOverride: 'OTHERCO' },
    );
    expect(result.skipped_wrong_company).toBe(1);
    expect(result.batches?.length).toBe(0);
  });

  it('flags foreign currency when batch currency != home currency', async () => {
    const eurEmail: ScannedEmail = {
      ...SAMPLE_EMAIL_HORIZONTAL,
      id: 102,
      body_text: `Subject: GoCardless: 615 EUR paid out
Reference: INTSYSUKLTD-PAY-EUR
Customer    Description    Amount
Acme    INV1    615.00 EUR

Gross amount    615.00 EUR
Net amount    600.00 EUR
`,
    };
    const result = await scanGocardlessEmails(
      makeOperaDb({
        homeCurrency: { code: 'GBP' },
        periodInfo: { np_year: 2026, np_perno: 4, np_periods: 12 },
        noDuplicates: true,
        periodValid: true,
      }),
      makeAppDb({}),
      makeMailbox([eurEmail]),
      {},
    );
    expect(result.batches?.[0]?.is_foreign_currency).toBe(true);
    expect(result.batches?.[0]?.batch.currency).toBe('EUR');
  });

  it('continues even if mailbox sync throws (cached emails fallback)', async () => {
    const result = await scanGocardlessEmails(
      makeOperaDb({
        homeCurrency: { code: 'GBP' },
        periodInfo: { np_year: 2026, np_perno: 4, np_periods: 12 },
        noDuplicates: true,
        periodValid: true,
      }),
      makeAppDb({}),
      makeMailbox([SAMPLE_EMAIL_HORIZONTAL], { syncFails: true }),
      {},
    );
    expect(result.success).toBe(true);
    expect(result.parsed_count).toBe(1);
  });

  it('skips emails whose subject lacks a payout keyword', async () => {
    const result = await scanGocardlessEmails(
      makeOperaDb({
        homeCurrency: { code: 'GBP' },
        periodInfo: { np_year: 2026, np_perno: 4, np_periods: 12 },
        noDuplicates: true,
        periodValid: true,
      }),
      makeAppDb({}),
      makeMailbox([
        {
          ...SAMPLE_EMAIL_HORIZONTAL,
          id: 103,
          subject: 'GoCardless: New mandate created',
        },
      ]),
      {},
    );
    expect(result.batches?.length).toBe(0);
  });

  it('returns current_period from Opera for client-side validation', async () => {
    const result = await scanGocardlessEmails(
      makeOperaDb({
        homeCurrency: { code: 'GBP' },
        periodInfo: { np_year: 2026, np_perno: 4, np_periods: 12 },
        noDuplicates: true,
        periodValid: true,
      }),
      makeAppDb({}),
      makeMailbox([SAMPLE_EMAIL_HORIZONTAL]),
      {},
    );
    expect(result.current_period).toEqual({ year: 2026, period: 4 });
  });
});
