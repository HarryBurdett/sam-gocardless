import { describe, it, expect } from 'vitest';
import { skipPayout } from '../src/services/skip-payout.js';

function makeAppDb(captureInsert?: (row: Record<string, unknown>) => void): any {
  const inserted: Record<string, unknown>[] = [];
  const db: any = (table: string) => {
    if (table !== 'gocardless_imports') {
      throw new Error(`Unexpected table: ${table}`);
    }
    return {
      insert: (row: Record<string, unknown>) => {
        inserted.push(row);
        captureInsert?.(row);
        return {
          returning: () => Promise.resolve([{ id: inserted.length }]),
        };
      },
    };
  };
  db.fn = { now: () => new Date() };
  db.raw = async () => [];
  return db;
}

describe('skipPayout', () => {
  it('records a manual skip and returns the record id', async () => {
    let captured: Record<string, unknown> | null = null;
    const appDb = makeAppDb((r) => {
      captured = r;
    });

    const result = await skipPayout(appDb, {
      payoutId: 'PO-123',
      bankReference: 'INTSYSUKLTD-XYZ',
      grossAmount: 1500,
      reason: 'manual',
    });

    expect(result.success).toBe(true);
    expect(result.record_id).toBe(1);
    expect(captured?.imported_by).toBe('MANUAL-SKIP');
    expect(captured?.bank_reference).toBe('INTSYSUKLTD-XYZ');
    expect(captured?.gross_amount).toBe(1500);
    // Net unknown for skipped — use gross
    expect(captured?.net_amount).toBe(1500);
  });

  it('appends currency to imported_by when reason=foreign_currency', async () => {
    let captured: Record<string, unknown> | null = null;
    const appDb = makeAppDb((r) => {
      captured = r;
    });

    const result = await skipPayout(appDb, {
      payoutId: 'PO-123',
      bankReference: 'INTSYSUKLTD-XYZ',
      grossAmount: 1500,
      currency: 'EUR',
      reason: 'foreign_currency',
    });

    expect(result.success).toBe(true);
    expect(captured?.imported_by).toBe('MANUAL-EUR');
    // Display reference should include currency
    expect(captured?.bank_reference).toBe('INTSYSUKLTD-XYZ (EUR)');
  });

  it('uses MANUAL-DUP for duplicate reason', async () => {
    let captured: Record<string, unknown> | null = null;
    const appDb = makeAppDb((r) => {
      captured = r;
    });

    await skipPayout(appDb, {
      payoutId: 'PO-123',
      bankReference: 'X',
      grossAmount: 1500,
      reason: 'duplicate',
    });

    expect(captured?.imported_by).toBe('MANUAL-DUP');
  });

  it('serialises payments JSON when provided', async () => {
    let captured: Record<string, unknown> | null = null;
    const appDb = makeAppDb((r) => {
      captured = r;
    });

    await skipPayout(appDb, {
      payoutId: 'PO-123',
      bankReference: 'X',
      grossAmount: 1500,
      payments: [
        {
          matched_account: 'CUST001',
          customer_name: 'Acme',
          amount: 750,
          description: 'INV001',
        },
        {
          customer_account: 'CUST002',
          customer_name: 'Beta',
          amount: 750,
        },
      ],
    });

    const json = JSON.parse(String(captured?.payments_json ?? '[]'));
    expect(json).toHaveLength(2);
    expect(json[0].customer_account).toBe('CUST001');
    expect(json[0].gc_customer_name).toBe('Acme');
    expect(json[1].customer_account).toBe('CUST002');
  });

  it('returns success=false on insert error', async () => {
    const db: any = () => ({
      insert: () => {
        throw new Error('UNIQUE constraint failed');
      },
    });
    db.fn = { now: () => new Date() };

    const result = await skipPayout(db, {
      payoutId: 'PO-123',
      bankReference: 'X',
      grossAmount: 1500,
    });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/UNIQUE constraint/);
  });
});
