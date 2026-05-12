import { describe, it, expect } from 'vitest';
import { getImportHistory } from '../src/services/import-history.js';

interface MockOpts {
  imports?: Array<{
    id: number;
    bank_reference: string;
    payment_date: string | null;
    gross_amount: number;
    fees_amount: number;
    vat_on_fees: number;
    net_amount: number;
    currency: string;
    bank_code: string;
    cbtype: string;
    payments_json: string;
    opera_entry_refs: string;
    target_system: string;
    imported_by: string;
    imported_at: string;
  }>;
  mandates?: Array<{ opera_account: string; customer_name: string }>;
  operaNames?: Array<{ sn_account: string; sn_name: string }>;
}

function makeAppDb(opts: MockOpts): any {
  const db: any = (table: string) => {
    if (table === 'gocardless_imports') {
      const builder: any = {
        _filters: { target_system: '' },
        _limit: 50,
        where: (col: Record<string, unknown>) => {
          Object.assign(builder._filters, col);
          return builder;
        },
        andWhere: () => builder,
        orderBy: () => builder,
        limit: (n: number) => {
          builder._limit = n;
          return builder;
        },
        then: (cb: (rows: unknown[]) => unknown) => {
          const filtered = (opts.imports ?? []).filter(
            (i) => i.target_system === builder._filters.target_system,
          );
          return Promise.resolve(cb(filtered.slice(0, builder._limit)));
        },
      };
      return builder;
    }
    if (table === 'gocardless_mandates') {
      return {
        select: () => ({
          whereIn: () => Promise.resolve(opts.mandates ?? []),
        }),
      };
    }
    return {};
  };
  db.raw = async () => [];
  db.fn = { now: () => new Date() };
  return db;
}

function makeOperaDb(names: Array<{ sn_account: string; sn_name: string }>): any {
  const db: any = () => ({});
  db.raw = async () => names;
  return db;
}

describe('getImportHistory', () => {
  it('returns past imports parsed and dated', async () => {
    const appDb = makeAppDb({
      imports: [
        {
          id: 1,
          bank_reference: 'INTSYS-ABC123',
          payment_date: '2026-04-15',
          gross_amount: 1500,
          fees_amount: 18,
          vat_on_fees: 3.6,
          net_amount: 1478.4,
          currency: 'GBP',
          bank_code: 'BC010',
          cbtype: 'GC',
          payments_json: JSON.stringify([
            { customer_account: 'ACME', amount: 1500 },
          ]),
          opera_entry_refs: JSON.stringify(['INTSYS-ABC123']),
          target_system: 'opera_se',
          imported_by: 'admin',
          imported_at: '2026-04-15T10:00:00Z',
        },
      ],
    });
    const operaDb = makeOperaDb([{ sn_account: 'ACME', sn_name: 'Acme Ltd' }]);

    const result = await getImportHistory(appDb, operaDb);

    expect(result.success).toBe(true);
    expect(result.count).toBe(1);
    expect(result.history[0]?.bank_reference).toBe('INTSYS-ABC123');
    expect(result.history[0]?.gross_amount).toBe(1500);
    // Opera enrichment applied
    expect(result.history[0]?.payments[0]?.opera_customer_name).toBe('Acme Ltd');
  });

  it('returns empty history with count=0 when no imports', async () => {
    const appDb = makeAppDb({});
    const result = await getImportHistory(appDb, null);
    expect(result.success).toBe(true);
    expect(result.count).toBe(0);
    expect(result.history).toEqual([]);
  });

  it('omits Opera enrichment when operaDb is null', async () => {
    const appDb = makeAppDb({
      imports: [
        {
          id: 1,
          bank_reference: 'X',
          payment_date: '2026-04-15',
          gross_amount: 100,
          fees_amount: 0,
          vat_on_fees: 0,
          net_amount: 100,
          currency: 'GBP',
          bank_code: 'BC010',
          cbtype: 'GC',
          payments_json: JSON.stringify([{ customer_account: 'ACME' }]),
          opera_entry_refs: '[]',
          target_system: 'opera_se',
          imported_by: 'admin',
          imported_at: '2026-04-15T10:00:00Z',
        },
      ],
    });

    const result = await getImportHistory(appDb, null);
    expect(result.success).toBe(true);
    expect(result.history[0]?.payments[0]?.opera_customer_name).toBeUndefined();
  });

  it('filters by target_system (opera_se vs opera_3)', async () => {
    const appDb = makeAppDb({
      imports: [
        {
          id: 1,
          bank_reference: 'SE',
          payment_date: '2026-04-15',
          gross_amount: 100,
          fees_amount: 0,
          vat_on_fees: 0,
          net_amount: 100,
          currency: 'GBP',
          bank_code: 'BC010',
          cbtype: 'GC',
          payments_json: '[]',
          opera_entry_refs: '[]',
          target_system: 'opera_se',
          imported_by: 'admin',
          imported_at: '2026-04-15T10:00:00Z',
        },
        {
          id: 2,
          bank_reference: 'O3',
          payment_date: '2026-04-15',
          gross_amount: 100,
          fees_amount: 0,
          vat_on_fees: 0,
          net_amount: 100,
          currency: 'GBP',
          bank_code: 'BC010',
          cbtype: 'GC',
          payments_json: '[]',
          opera_entry_refs: '[]',
          target_system: 'opera_3',
          imported_by: 'admin',
          imported_at: '2026-04-15T10:00:00Z',
        },
      ],
    });
    const result = await getImportHistory(appDb, null, { targetSystem: 'opera_se' });
    expect(result.count).toBe(1);
    expect(result.history[0]?.bank_reference).toBe('SE');
  });
});
