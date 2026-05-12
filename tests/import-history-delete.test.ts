import { describe, it, expect } from 'vitest';
import {
  clearImportHistory,
  deleteImportRecord,
} from '../src/services/import-history-delete.js';

interface MockState {
  rows: Array<Record<string, unknown> & { id: number }>;
}

function makeAppDb(state: MockState): any {
  const db: any = (table: string) => {
    if (table !== 'gocardless_imports') {
      throw new Error(`Unexpected table: ${table}`);
    }
    let filters: Record<string, unknown> = {};
    let dateFrom: string | null = null;
    let dateTo: string | null = null;
    const builder: any = {
      where: (col: Record<string, unknown> | string, val?: unknown) => {
        if (typeof col === 'object') Object.assign(filters, col);
        else if (val !== undefined) filters[col] = val;
        return builder;
      },
      andWhere: (col: string, op: string, val: string) => {
        if (col === 'payment_date') {
          if (op === '>=') dateFrom = val;
          if (op === '<=') dateTo = val;
        }
        return builder;
      },
      delete: async () => {
        const before = state.rows.length;
        state.rows = state.rows.filter((r) => {
          // Don't delete if filters don't match
          if (!Object.keys(filters).every((k) => r[k] === filters[k])) {
            return true;
          }
          // Date range filters
          if (dateFrom !== null) {
            const pd = String(r.payment_date ?? '');
            if (pd < dateFrom) return true;
          }
          if (dateTo !== null) {
            const pd = String(r.payment_date ?? '');
            if (pd > dateTo) return true;
          }
          return false; // delete this row
        });
        return before - state.rows.length;
      },
    };
    return builder;
  };
  return db;
}

describe('clearImportHistory', () => {
  it('clears all rows for opera_se when no dates given', async () => {
    const state: MockState = {
      rows: [
        { id: 1, target_system: 'opera_se', payment_date: '2026-04-15' } as any,
        { id: 2, target_system: 'opera_se', payment_date: '2026-04-16' } as any,
        { id: 3, target_system: 'opera_3', payment_date: '2026-04-15' } as any,
      ],
    };
    const db = makeAppDb(state);
    const result = await clearImportHistory(db);
    expect(result.success).toBe(true);
    expect(result.deleted_count).toBe(2);
    // opera_3 row preserved
    expect(state.rows).toHaveLength(1);
    expect(state.rows[0]?.target_system).toBe('opera_3');
  });

  it('respects from_date / to_date filters', async () => {
    const state: MockState = {
      rows: [
        { id: 1, target_system: 'opera_se', payment_date: '2026-03-01' } as any,
        { id: 2, target_system: 'opera_se', payment_date: '2026-04-15' } as any,
        { id: 3, target_system: 'opera_se', payment_date: '2026-05-01' } as any,
      ],
    };
    const db = makeAppDb(state);
    const result = await clearImportHistory(db, {
      fromDate: '2026-04-01',
      toDate: '2026-04-30',
    });
    expect(result.deleted_count).toBe(1);
    expect(state.rows).toHaveLength(2);
  });

  it('reports 0 deleted when no rows match', async () => {
    const state: MockState = { rows: [] };
    const db = makeAppDb(state);
    const result = await clearImportHistory(db);
    expect(result.success).toBe(true);
    expect(result.deleted_count).toBe(0);
  });
});

describe('deleteImportRecord', () => {
  it('deletes when record exists', async () => {
    const state: MockState = {
      rows: [
        { id: 1, target_system: 'opera_se', payment_date: '2026-04-15' } as any,
      ],
    };
    const db = makeAppDb(state);
    const result = await deleteImportRecord(db, 1);
    expect(result.success).toBe(true);
    expect(result.message).toMatch(/can now be re-imported/);
    expect(state.rows).toHaveLength(0);
  });

  it('returns Record not found when missing', async () => {
    const state: MockState = { rows: [] };
    const db = makeAppDb(state);
    const result = await deleteImportRecord(db, 999);
    expect(result.success).toBe(false);
    expect(result.error).toBe('Record not found');
  });

  it('rejects invalid id', async () => {
    const state: MockState = { rows: [] };
    const db = makeAppDb(state);
    const result = await deleteImportRecord(db, 0);
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/Invalid/);
  });
});
