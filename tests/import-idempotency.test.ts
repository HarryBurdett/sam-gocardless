import { describe, it, expect } from 'vitest';
import {
  isPayoutImported,
  isReferenceImported,
  isEmailImported,
  getImportedEmailIds,
} from '../src/services/import-idempotency.js';

interface ImportRow {
  id: number;
  email_id: number | null;
  payout_id: string | null;
  bank_reference: string | null;
  target_system: string;
}

interface MockState {
  rows: ImportRow[];
}

function makeAppDb(state: MockState): any {
  // We model the predicate as a list of "AND-groups" — each top-level
  // .where(obj) or .andWhere(obj) appends one AND-group. A
  // .where(function(){ this.where(...).orWhere(...) }) appends a single
  // OR-group containing two predicates.
  type Pred = (r: ImportRow) => boolean;
  type AndGroup = Pred[]; // all preds AND'd
  type Predicate = { and: AndGroup; or: Pred[] };

  const db: any = (table: string) => {
    if (table !== 'gocardless_imports') {
      throw new Error(`Unexpected table: ${table}`);
    }
    const preds: Predicate = { and: [], or: [] };
    let notNullCols: string[] = [];
    let distinctCol: string | null = null;

    const builder: any = {
      where: (
        cond: Record<string, unknown> | ((b: any) => void),
        op?: any,
        val?: any,
      ) => {
        if (typeof cond === 'function') {
          // Sub-where with OR
          const subOrPreds: Pred[] = [];
          const sub: any = {
            where: (c: Record<string, unknown>) => {
              subOrPreds.push((r) =>
                Object.entries(c).every(([k, v]) => (r as any)[k] === v),
              );
              return sub;
            },
            orWhere: (col: string, opOr: string, valOr: string) => {
              if (opOr === 'like') {
                const pattern = String(valOr);
                const re = new RegExp(
                  '^' +
                    pattern
                      .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
                      .replace(/%/g, '.*') +
                    '$',
                );
                subOrPreds.push((r) => re.test(String((r as any)[col] ?? '')));
              }
              return sub;
            },
          };
          cond(sub);
          // The whole sub-where is one AND-group entry: row matches
          // the sub-where if ANY of the OR preds match.
          preds.and.push((r) => subOrPreds.some((p) => p(r)));
          return builder;
        }
        if (typeof cond === 'object') {
          preds.and.push((r) =>
            Object.entries(cond).every(([k, v]) => (r as any)[k] === v),
          );
        }
        return builder;
      },
      andWhere: (cond: Record<string, unknown>) => {
        preds.and.push((r) =>
          Object.entries(cond).every(([k, v]) => (r as any)[k] === v),
        );
        return builder;
      },
      whereNotNull: (col: string) => {
        notNullCols.push(col);
        return builder;
      },
      distinct: (col: string) => {
        distinctCol = col;
        return builder;
      },
      select: (col: string) => {
        let rows = state.rows.filter((r) => preds.and.every((p) => p(r)));
        rows = rows.filter((r) =>
          notNullCols.every((c) => (r as any)[c] !== null && (r as any)[c] !== undefined),
        );
        if (distinctCol) {
          const seen = new Set();
          rows = rows.filter((r) => {
            const v = (r as any)[distinctCol!];
            if (seen.has(v)) return false;
            seen.add(v);
            return true;
          });
        }
        return Promise.resolve(rows.map((r) => ({ [col]: (r as any)[col] })));
      },
      first: () => {
        const rows = state.rows.filter((r) => preds.and.every((p) => p(r)));
        return Promise.resolve(rows[0]);
      },
    };
    return builder;
  };
  db.fn = { now: () => new Date() };
  return db;
}

describe('isPayoutImported', () => {
  it('returns true when payout_id exists', async () => {
    const state: MockState = {
      rows: [
        {
          id: 1, email_id: null, payout_id: 'PO_X',
          bank_reference: 'REF', target_system: 'opera_se',
        },
      ],
    };
    expect(await isPayoutImported(makeAppDb(state), 'PO_X')).toBe(true);
  });

  it('returns false when payout_id missing', async () => {
    expect(
      await isPayoutImported(makeAppDb({ rows: [] }), 'PO_X'),
    ).toBe(false);
  });

  it('returns false on empty input', async () => {
    expect(await isPayoutImported(makeAppDb({ rows: [] }), '')).toBe(false);
  });

  it('respects target_system filter', async () => {
    const state: MockState = {
      rows: [
        {
          id: 1, email_id: null, payout_id: 'PO_X',
          bank_reference: '', target_system: 'opera_se',
        },
      ],
    };
    expect(
      await isPayoutImported(makeAppDb(state), 'PO_X', {
        targetSystem: 'opera_3',
      }),
    ).toBe(false);
    expect(
      await isPayoutImported(makeAppDb(state), 'PO_X', {
        targetSystem: 'opera_se',
      }),
    ).toBe(true);
  });
});

describe('isReferenceImported', () => {
  it('returns true on exact reference match', async () => {
    const state: MockState = {
      rows: [
        {
          id: 1, email_id: null, payout_id: null,
          bank_reference: 'INTSYSUKLTD-AB12CD', target_system: 'opera_se',
        },
      ],
    };
    expect(
      await isReferenceImported(makeAppDb(state), 'INTSYSUKLTD-AB12CD'),
    ).toBe(true);
  });

  it('returns true on reference with currency suffix', async () => {
    const state: MockState = {
      rows: [
        {
          id: 1, email_id: null, payout_id: null,
          bank_reference: 'INTSYSUKLTD-AB12CD (EUR)',
          target_system: 'opera_se',
        },
      ],
    };
    expect(
      await isReferenceImported(makeAppDb(state), 'INTSYSUKLTD-AB12CD'),
    ).toBe(true);
  });

  it('returns false when neither match', async () => {
    expect(
      await isReferenceImported(makeAppDb({ rows: [] }), 'X'),
    ).toBe(false);
  });
});

describe('isEmailImported', () => {
  it('returns true when email_id exists', async () => {
    const state: MockState = {
      rows: [
        {
          id: 1, email_id: 42, payout_id: null,
          bank_reference: '', target_system: 'opera_se',
        },
      ],
    };
    expect(await isEmailImported(makeAppDb(state), 42)).toBe(true);
  });

  it('returns false when email_id missing', async () => {
    expect(await isEmailImported(makeAppDb({ rows: [] }), 42)).toBe(false);
  });

  it('rejects bad email_id', async () => {
    expect(await isEmailImported(makeAppDb({ rows: [] }), 0)).toBe(false);
  });
});

describe('getImportedEmailIds', () => {
  it('returns distinct positive email_ids', async () => {
    const state: MockState = {
      rows: [
        { id: 1, email_id: 10, payout_id: null, bank_reference: '', target_system: 'opera_se' },
        { id: 2, email_id: 20, payout_id: null, bank_reference: '', target_system: 'opera_se' },
        { id: 3, email_id: 10, payout_id: null, bank_reference: '', target_system: 'opera_se' }, // dup
        { id: 4, email_id: null, payout_id: 'X', bank_reference: '', target_system: 'opera_se' },
      ],
    };
    const ids = await getImportedEmailIds(makeAppDb(state));
    expect(ids.sort()).toEqual([10, 20]);
  });
});
