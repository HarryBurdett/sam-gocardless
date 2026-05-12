import { describe, it, expect } from 'vitest';
import { revalidateBatches } from '../src/services/revalidate-batches.js';

interface MockState {
  homeCurrencyRow?: { xc_curr: string; xc_desc: string };
  nparmRow?: { np_year: number; np_perno: number; np_periods: number };
  // Period validation:
  nclnddPeriodForDate?: { ncd_period: number; ncd_year: number };
  opaEnabled?: boolean; // seqco.co_opanl
  nlStatus?: number;    // ncd_nlstat
  slStatus?: number;    // ncd_slstat
  // Duplicate detection:
  refDupRow?: { ae_entref: string; at_value: number; at_date: Date | string } | null;
  amountDupRow?: { ae_entref: string; at_value: number; at_date: Date | string } | null;
}

function makeOperaDb(state: MockState): any {
  return {
    raw: (sql: string, params?: unknown[]) => {
      // Home currency
      if (sql.includes('FROM zxchg')) {
        return Promise.resolve(state.homeCurrencyRow ? [state.homeCurrencyRow] : []);
      }
      // Period info from nparm
      if (sql.includes('FROM nparm')) {
        return Promise.resolve(state.nparmRow ? [state.nparmRow] : []);
      }
      // Period for date from nclndd
      if (sql.includes('FROM nclndd') && !sql.includes('ncd_nlstat') && !sql.includes('ncd_slstat')) {
        return Promise.resolve(state.nclnddPeriodForDate ? [state.nclnddPeriodForDate] : []);
      }
      // OPA from seqco
      if (sql.includes('seqco')) {
        return Promise.resolve([{ co_opanl: state.opaEnabled ? 1 : 0 }]);
      }
      // NL status
      if (sql.includes('ncd_nlstat')) {
        return Promise.resolve([{ period_status: state.nlStatus ?? 0 }]);
      }
      // SL status
      if (sql.includes('ncd_slstat')) {
        return Promise.resolve([{ period_status: state.slStatus ?? 0 }]);
      }
      // Duplicate by ref + amount (or foreign ref-only)
      if (sql.includes('aentry') && sql.includes('ABS(at_value -') && !sql.includes('DATEDIFF')) {
        return Promise.resolve(state.refDupRow ? [state.refDupRow] : []);
      }
      // Duplicate by amount + 14-day window
      if (sql.includes('DATEDIFF(day')) {
        return Promise.resolve(state.amountDupRow ? [state.amountDupRow] : []);
      }
      // Foreign currency ref-only (no amount filter)
      if (sql.includes('aentry') && sql.includes('LIKE') && !sql.includes('ABS(at_value -')) {
        return Promise.resolve(state.refDupRow ? [state.refDupRow] : []);
      }
      return Promise.resolve([]);
    },
  };
}

describe('revalidateBatches', () => {
  it('marks valid period and no duplicate when none found', async () => {
    const state: MockState = {
      homeCurrencyRow: { xc_curr: 'GBP', xc_desc: 'Sterling' },
      nparmRow: { np_year: 2026, np_perno: 4, np_periods: 12 },
      nclnddPeriodForDate: { ncd_period: 4, ncd_year: 2026 },
      opaEnabled: true,
      nlStatus: 0,
      slStatus: 0,
      refDupRow: null,
      amountDupRow: null,
    };
    const result = await revalidateBatches(makeOperaDb(state), [
      {
        batch: {
          gross_amount: 500,
          bank_reference: 'INTSYS-COL-123456',
          payment_date: '2026-04-15',
          currency: 'GBP',
        },
      },
    ]);
    expect(result.success).toBe(true);
    expect(result.batches[0]?.period_valid).toBe(true);
    expect(result.batches[0]?.period_error).toBeNull();
    expect(result.batches[0]?.possible_duplicate).toBe(false);
    expect(result.batches[0]?.is_foreign_currency).toBe(false);
    expect(result.batches[0]?.home_currency).toBe('GBP');
    expect(result.current_period).toEqual({ year: 2026, period: 4 });
    expect(result.message).toMatch(/Revalidated 1 batch/);
  });

  it('marks period invalid when SL is closed', async () => {
    const state: MockState = {
      homeCurrencyRow: { xc_curr: 'GBP', xc_desc: 'Sterling' },
      nparmRow: { np_year: 2026, np_perno: 4, np_periods: 12 },
      nclnddPeriodForDate: { ncd_period: 3, ncd_year: 2026 },
      opaEnabled: true,
      nlStatus: 0,
      slStatus: 2, // closed
    };
    const result = await revalidateBatches(makeOperaDb(state), [
      {
        batch: {
          gross_amount: 500,
          payment_date: '2026-03-15',
          currency: 'GBP',
        },
      },
    ]);
    expect(result.batches[0]?.period_valid).toBe(false);
    expect(result.batches[0]?.period_error).toMatch(/Sales Ledger is closed/);
  });

  it('flags GBP duplicate by reference + amount (£1 tolerance)', async () => {
    const state: MockState = {
      homeCurrencyRow: { xc_curr: 'GBP', xc_desc: 'Sterling' },
      nparmRow: { np_year: 2026, np_perno: 4, np_periods: 12 },
      nclnddPeriodForDate: { ncd_period: 4, ncd_year: 2026 },
      opaEnabled: true,
      nlStatus: 0,
      slStatus: 0,
      refDupRow: {
        ae_entref: 'GC-INTSYS-COL-123456',
        at_value: 50000, // £500.00
        at_date: '2026-04-15',
      },
      amountDupRow: null,
    };
    const result = await revalidateBatches(makeOperaDb(state), [
      {
        batch: {
          gross_amount: 500,
          bank_reference: 'INTSYS-COL-123456',
          payment_date: '2026-04-15',
          currency: 'GBP',
        },
      },
    ]);
    expect(result.batches[0]?.possible_duplicate).toBe(true);
    expect(result.batches[0]?.bank_tx_warning).toMatch(/Already posted - ref/);
    expect(result.batches[0]?.bank_tx_warning).toMatch(/£500\.00/);
  });

  it('falls back to amount-only check within 14 days when no ref match', async () => {
    const state: MockState = {
      homeCurrencyRow: { xc_curr: 'GBP', xc_desc: 'Sterling' },
      nparmRow: { np_year: 2026, np_perno: 4, np_periods: 12 },
      nclnddPeriodForDate: { ncd_period: 4, ncd_year: 2026 },
      opaEnabled: true,
      nlStatus: 0,
      slStatus: 0,
      refDupRow: null,
      amountDupRow: {
        ae_entref: 'BAT001',
        at_value: 50000,
        at_date: '2026-04-10',
      },
    };
    const result = await revalidateBatches(makeOperaDb(state), [
      {
        batch: {
          gross_amount: 500,
          bank_reference: 'INTSYS-COL-999999',
          payment_date: '2026-04-15',
          currency: 'GBP',
        },
      },
    ]);
    expect(result.batches[0]?.possible_duplicate).toBe(true);
    expect(result.batches[0]?.bank_tx_warning).toMatch(/gross amount/);
    expect(result.batches[0]?.bank_tx_warning).toMatch(/BAT001/);
  });

  it('foreign currency: ref-only check, mentions GBP equivalent in warning', async () => {
    const state: MockState = {
      homeCurrencyRow: { xc_curr: 'GBP', xc_desc: 'Sterling' },
      nparmRow: { np_year: 2026, np_perno: 4, np_periods: 12 },
      nclnddPeriodForDate: { ncd_period: 4, ncd_year: 2026 },
      opaEnabled: true,
      nlStatus: 0,
      slStatus: 0,
      refDupRow: {
        ae_entref: 'GC-USD-FXBATCH',
        at_value: 12345,
        at_date: '2026-04-12',
      },
    };
    const result = await revalidateBatches(makeOperaDb(state), [
      {
        batch: {
          gross_amount: 100,
          bank_reference: 'USD-FXBATCH-77',
          payment_date: '2026-04-12',
          currency: 'USD',
        },
      },
    ]);
    expect(result.batches[0]?.is_foreign_currency).toBe(true);
    expect(result.batches[0]?.possible_duplicate).toBe(true);
    expect(result.batches[0]?.bank_tx_warning).toMatch(/foreign currency, GBP equivalent/);
  });

  it('preserves all original batch fields on output', async () => {
    const state: MockState = {
      homeCurrencyRow: { xc_curr: 'GBP', xc_desc: 'Sterling' },
      nparmRow: { np_year: 2026, np_perno: 4, np_periods: 12 },
      nclnddPeriodForDate: { ncd_period: 4, ncd_year: 2026 },
      opaEnabled: true,
      nlStatus: 0,
      slStatus: 0,
    };
    const result = await revalidateBatches(makeOperaDb(state), [
      {
        custom_id: 'X-99',
        payments: [{ id: 'P1' }],
        batch: { gross_amount: 100, currency: 'GBP', payment_date: '2026-04-15' },
      },
    ]);
    expect(result.batches[0]?.custom_id).toBe('X-99');
    expect(result.batches[0]?.payments).toEqual([{ id: 'P1' }]);
  });

  it('falls back to GBP default when zxchg has no row', async () => {
    const state: MockState = {
      homeCurrencyRow: undefined, // empty zxchg
      nparmRow: { np_year: 2026, np_perno: 4, np_periods: 12 },
      nclnddPeriodForDate: { ncd_period: 4, ncd_year: 2026 },
      opaEnabled: true,
      nlStatus: 0,
      slStatus: 0,
    };
    const result = await revalidateBatches(makeOperaDb(state), [
      {
        batch: { gross_amount: 100, currency: 'GBP', payment_date: '2026-04-15' },
      },
    ]);
    expect(result.batches[0]?.home_currency).toBe('GBP');
    expect(result.batches[0]?.is_foreign_currency).toBe(false);
  });
});
