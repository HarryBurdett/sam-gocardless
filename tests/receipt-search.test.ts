import { describe, it, expect } from 'vitest';
import { searchReceipts } from '../src/services/receipt-search.js';

interface MockOpts {
  imports?: Array<{
    id: number;
    bank_reference: string | null;
    payment_date: string | null;
    payments_json: string | null;
    target_system: string;
    imported_at: string;
  }>;
  operaNames?: Array<{ sn_account: string; sn_name: string }>;
}

function makeAppDb(opts: MockOpts): any {
  const db: any = (table: string) => {
    if (table !== 'gocardless_imports') {
      throw new Error(`Unexpected table: ${table}`);
    }
    let filters: Record<string, unknown> = {};
    let limitN = 1000;
    const builder: any = {
      where: (col: Record<string, unknown>) => {
        Object.assign(filters, col);
        return builder;
      },
      andWhere: () => builder,
      orderBy: () => builder,
      limit: (n: number) => {
        limitN = n;
        return builder;
      },
      then: (cb: (rows: unknown[]) => unknown) => {
        const filtered = (opts.imports ?? []).filter((i) =>
          Object.keys(filters).every((k) => (i as any)[k] === filters[k]),
        );
        return Promise.resolve(cb(filtered.slice(0, limitN)));
      },
    };
    return builder;
  };
  return db;
}

function makeOperaDb(names: Array<{ sn_account: string; sn_name: string }>): any {
  const db: any = () => ({});
  db.raw = async () => names;
  return db;
}

describe('searchReceipts', () => {
  it('flattens payments_json and enriches with Opera names', async () => {
    const appDb = makeAppDb({
      imports: [
        {
          id: 1,
          bank_reference: 'INTSYS-123',
          payment_date: '2026-04-15',
          payments_json: JSON.stringify([
            { customer_account: 'ACME', amount: 1500 },
            { customer_account: 'BETA', amount: 500 },
          ]),
          target_system: 'opera_se',
          imported_at: '2026-04-15T10:00:00Z',
        },
      ],
    });
    const operaDb = makeOperaDb([
      { sn_account: 'ACME', sn_name: 'Acme Ltd' },
      { sn_account: 'BETA', sn_name: 'Beta Corp' },
    ]);

    const result = await searchReceipts(appDb, operaDb);

    expect(result.success).toBe(true);
    expect(result.total).toBe(2);
    expect(result.total_amount).toBe(2000);
    expect(result.receipts[0]?.customer_name).toMatch(/Acme|Beta/);
  });

  it('filters by customer search string (case-insensitive)', async () => {
    const appDb = makeAppDb({
      imports: [
        {
          id: 1,
          bank_reference: 'X',
          payment_date: '2026-04-15',
          payments_json: JSON.stringify([
            { customer_account: 'ACME', amount: 1500, customer_name: 'Acme Ltd' },
            { customer_account: 'BETA', amount: 500, customer_name: 'Beta Corp' },
          ]),
          target_system: 'opera_se',
          imported_at: '2026-04-15T10:00:00Z',
        },
      ],
    });

    const result = await searchReceipts(appDb, null, { customer: 'acme' });

    expect(result.total).toBe(1);
    expect(result.receipts[0]?.customer_account).toBe('ACME');
  });

  it('returns empty when search has no matches', async () => {
    const appDb = makeAppDb({
      imports: [
        {
          id: 1,
          bank_reference: 'X',
          payment_date: '2026-04-15',
          payments_json: JSON.stringify([{ customer_account: 'ACME', amount: 100 }]),
          target_system: 'opera_se',
          imported_at: '2026-04-15T10:00:00Z',
        },
      ],
    });
    const result = await searchReceipts(appDb, null, { customer: 'ghost' });
    expect(result.total).toBe(0);
  });

  it('handles malformed payments_json gracefully', async () => {
    const appDb = makeAppDb({
      imports: [
        {
          id: 1,
          bank_reference: 'X',
          payment_date: '2026-04-15',
          payments_json: 'not-valid-json',
          target_system: 'opera_se',
          imported_at: '2026-04-15T10:00:00Z',
        },
      ],
    });
    const result = await searchReceipts(appDb, null);
    expect(result.success).toBe(true);
    expect(result.total).toBe(0);
  });

  it('respects limit parameter', async () => {
    const appDb = makeAppDb({
      imports: [
        {
          id: 1,
          bank_reference: 'X',
          payment_date: '2026-04-15',
          payments_json: JSON.stringify([
            { customer_account: 'A', amount: 100 },
            { customer_account: 'B', amount: 200 },
            { customer_account: 'C', amount: 300 },
          ]),
          target_system: 'opera_se',
          imported_at: '2026-04-15T10:00:00Z',
        },
      ],
    });
    const result = await searchReceipts(appDb, null, { limit: 2 });
    expect(result.total).toBe(2);
  });
});
