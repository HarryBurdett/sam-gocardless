/**
 * Tests for the GoCardless health-check service.
 */
import { describe, it, expect } from 'vitest';
import { runHealthCheck } from '../src/services/health-check.js';
import type { GoCardlessSettings } from '../src/services/settings.js';

const TEST_COMPANY = 'C';

function makeMockOpera(canned: {
  banks?: string[];
  customers?: string[];
  nominals?: string[];
}): any {
  const db: any = () => ({});
  db.raw = async (sql: string) => {
    if (sql.includes('FROM nbank')) {
      return (canned.banks ?? []).map((c) => ({ code: c }));
    }
    if (sql.includes('FROM sname')) {
      return (canned.customers ?? []).map((c) => ({ code: c }));
    }
    if (sql.includes('FROM nacnt')) {
      return (canned.nominals ?? []).map((c) => ({ code: c }));
    }
    return [];
  };
  return db;
}

function makeMockApp(canned: {
  mandateAccounts?: string[];
  paymentRequestAccounts?: string[];
  missingTables?: boolean;
}): any {
  const db: any = (table: string) => {
    const builder: any = {
      where: () => builder,
      whereNotNull: () => builder,
      andWhereRaw: () => builder,
      distinct: () => builder,
      select: async () => {
        if (canned.missingTables) {
          throw new Error('Invalid object name');
        }
        if (table === 'gocardless_mandates') {
          return (canned.mandateAccounts ?? []).map((a) => ({ opera_account: a }));
        }
        if (table === 'gocardless_payment_requests') {
          return (canned.paymentRequestAccounts ?? []).map((a) => ({ opera_account: a }));
        }
        return [];
      },
    };
    return builder;
  };
  db.raw = async () => [];
  return db;
}

function makeSettings(over: Partial<GoCardlessSettings> = {}): GoCardlessSettings {
  return {
    default_batch_type: '',
    default_bank_code: '',
    fees_nominal_account: '',
    fees_vat_code: '1',
    fees_payment_type: '',
    company_reference: '',
    exclude_description_patterns: [],
    auto_allocate: false,
    gocardless_bank_code: '',
    gocardless_transfer_cbtype: '',
    subscription_tag: 'SUB',
    subscription_frequencies: ['W', 'M', 'A'],
    ...over,
  };
}

describe('runHealthCheck', () => {
  it('reports healthy when settings + payment data all valid', async () => {
    const opera = makeMockOpera({
      banks: ['BC010', 'BC020'],
      customers: ['CUST001', 'CUST002'],
      nominals: ['1100', '1200', '7800'],
    });
    const appDb = makeMockApp({
      mandateAccounts: ['CUST001'],
      paymentRequestAccounts: ['CUST001', 'CUST002'],
    });
    const settings = makeSettings({
      default_bank_code: 'BC010',
      fees_nominal_account: '7800',
    });

    const result = await runHealthCheck({
      operaDb: opera,
      appDb,
      companyCode: TEST_COMPANY,
      settings,
    });

    expect(result.healthy).toBe(true);
    expect(result.app).toBe('gocardless');
    expect(result.checks.find((c) => c.name === 'Settings bank code')?.passed).toBe(true);
    expect(result.checks.find((c) => c.name === 'Settings fees account')?.passed).toBe(true);
    expect(result.checks.find((c) => c.name === 'Payment history customers')?.passed).toBe(true);
  });

  it('reports an error when bank code is missing from Opera', async () => {
    const opera = makeMockOpera({ banks: ['BC020'] });
    const settings = makeSettings({ default_bank_code: 'BC010' });

    const result = await runHealthCheck({
      operaDb: opera,
      appDb: null,
      companyCode: TEST_COMPANY,
      settings,
    });

    const bankCheck = result.checks.find((c) => c.name === 'Settings bank code');
    expect(bankCheck?.passed).toBe(false);
    expect(bankCheck?.severity).toBe('error');
    expect(bankCheck?.orphan_count).toBe(1);
    expect(result.healthy).toBe(false);
  });

  it('skips checks when settings are null', async () => {
    const opera = makeMockOpera({ banks: ['BC010'] });
    const result = await runHealthCheck({
      operaDb: opera,
      appDb: null,
      companyCode: TEST_COMPANY,
      settings: null,
    });

    const settingsCheck = result.checks.find((c) => c.name === 'GoCardless settings');
    expect(settingsCheck).toBeDefined();
    expect(settingsCheck?.severity).toBe('info');
  });

  it('reports orphan customers when payment data references missing Opera customers', async () => {
    const opera = makeMockOpera({
      banks: ['BC010'],
      customers: ['CUST001'],
      nominals: [],
    });
    const appDb = makeMockApp({
      mandateAccounts: ['CUST001', 'OLDCUST'],
      paymentRequestAccounts: ['MISSING'],
    });
    const settings = makeSettings();

    const result = await runHealthCheck({
      operaDb: opera,
      appDb,
      companyCode: TEST_COMPANY,
      settings,
    });

    const histCheck = result.checks.find((c) => c.name === 'Payment history customers');
    expect(histCheck?.passed).toBe(false);
    expect(histCheck?.orphan_count).toBe(2);
    expect(histCheck?.severity).toBe('warning');
  });

  it('reports an error when Opera connection returns no banks', async () => {
    const opera = makeMockOpera({});
    const result = await runHealthCheck({
      operaDb: opera,
      appDb: null,
      companyCode: TEST_COMPANY,
      settings: null,
    });

    const sanity = result.checks.find((c) => c.name === 'Opera connection');
    expect(sanity?.passed).toBe(false);
    expect(sanity?.severity).toBe('error');
    expect(result.healthy).toBe(false);
  });
});
