import { describe, it, expect } from 'vitest';
import {
  suggestMandateMatch,
  sequenceMatcherRatio,
  normaliseSuggestName,
} from '../src/services/suggest-match.js';

interface CustomerRow {
  sn_account: string;
  sn_name: string;
  sn_analsys: string | null;
  sn_currbal: number | null;
  sn_stop: number;
}

interface MockState {
  rows: CustomerRow[];
}

function makeOperaDb(state: MockState): any {
  const db: any = (table: string) => {
    if (table !== 'sname') throw new Error(`Unexpected table: ${table}`);
    let conds: Record<string, unknown> = {};
    const builder: any = {
      where: (cond: Record<string, unknown>) => {
        Object.assign(conds, cond);
        return builder;
      },
      orderBy: () => builder,
      select: async (..._cols: any[]) => {
        return state.rows
          .filter((r) =>
            Object.entries(conds).every(([k, v]) => (r as any)[k] === v),
          )
          .map((r) => ({
            account: r.sn_account,
            name: r.sn_name,
            analsys: r.sn_analsys,
            balance: r.sn_currbal,
          }));
      },
    };
    return builder;
  };
  db.raw = (s: string) => s;
  return db;
}

function row(over: Partial<CustomerRow> = {}): CustomerRow {
  return {
    sn_account: 'CUST01',
    sn_name: 'Acme Ltd',
    sn_analsys: '',
    sn_currbal: 0,
    sn_stop: 0,
    ...over,
  };
}

// ---------------------------------------------------------------------
// normaliseSuggestName
// ---------------------------------------------------------------------

describe('normaliseSuggestName', () => {
  it('strips company suffixes', () => {
    expect(normaliseSuggestName('Acme Ltd')).toBe('ACME');
    expect(normaliseSuggestName('Acme Limited')).toBe('ACME');
    expect(normaliseSuggestName('Beta PLC')).toBe('BETA');
    expect(normaliseSuggestName('Gamma Inc')).toBe('GAMMA');
    expect(normaliseSuggestName('Delta Co')).toBe('DELTA');
    expect(normaliseSuggestName('Epsilon Company')).toBe('EPSILON');
  });

  it('strips trailing dot (Python suffix list quirk)', () => {
    expect(normaliseSuggestName('Acme.')).toBe('ACME');
  });

  it('handles empty / null', () => {
    expect(normaliseSuggestName('')).toBe('');
    expect(normaliseSuggestName(null)).toBe('');
    expect(normaliseSuggestName(undefined)).toBe('');
  });
});

// ---------------------------------------------------------------------
// sequenceMatcherRatio (Ratcliff/Obershelp port of difflib)
// ---------------------------------------------------------------------

describe('sequenceMatcherRatio', () => {
  it('returns 1.0 for identical strings', () => {
    expect(sequenceMatcherRatio('ABCDEF', 'ABCDEF')).toBe(1.0);
  });

  it('returns 0 for completely different strings', () => {
    expect(sequenceMatcherRatio('ABCDEF', 'XYZ123')).toBe(0);
  });

  it('matches Python difflib output for known pairs', () => {
    // SequenceMatcher(None, 'NEW YORK METS', 'NEW YORK MEATS').ratio()
    // Common matches: 'NEW YORK ME' (11) + 'TS' (2) = 13.
    // ratio = 2 * 13 / (13 + 14) = 26/27 = 0.9629629...
    expect(sequenceMatcherRatio('NEW YORK METS', 'NEW YORK MEATS')).toBeCloseTo(
      0.9629629,
      5,
    );
  });

  it('respects ordering — partial overlap', () => {
    // SequenceMatcher(None, 'abcd', 'bcde').ratio() == 0.75
    expect(sequenceMatcherRatio('abcd', 'bcde')).toBeCloseTo(0.75, 5);
  });

  it('handles empty inputs gracefully', () => {
    expect(sequenceMatcherRatio('', '')).toBe(1.0);
    expect(sequenceMatcherRatio('', 'ABC')).toBe(0);
    expect(sequenceMatcherRatio('ABC', '')).toBe(0);
  });
});

// ---------------------------------------------------------------------
// suggestMandateMatch
// ---------------------------------------------------------------------

describe('suggestMandateMatch', () => {
  it('returns 1.0 score for exact match after normalisation', async () => {
    const state: MockState = {
      rows: [row({ sn_account: 'CUST01', sn_name: 'Acme Limited' })],
    };
    const result = await suggestMandateMatch(makeOperaDb(state), 'Acme Ltd');
    expect(result.success).toBe(true);
    expect(result.suggestions).toHaveLength(1);
    expect(result.suggestions[0]?.score).toBe(1);
  });

  it('returns 0.85 for containment match', async () => {
    const state: MockState = {
      rows: [
        row({ sn_account: 'CUST01', sn_name: 'Beta Trading International' }),
      ],
    };
    const result = await suggestMandateMatch(makeOperaDb(state), 'Beta');
    expect(result.suggestions[0]?.score).toBe(0.85);
  });

  it('uses fuzzy ratio for non-exact non-containment matches', async () => {
    const state: MockState = {
      rows: [row({ sn_account: 'CUST01', sn_name: 'New York Meats' })],
    };
    const result = await suggestMandateMatch(
      makeOperaDb(state),
      'New York Mets',
    );
    expect(result.suggestions).toHaveLength(1);
    expect(result.suggestions[0]?.score).toBeGreaterThan(0.9);
    expect(result.suggestions[0]?.score).toBeLessThan(1);
  });

  it('drops candidates below 0.5 threshold', async () => {
    const state: MockState = {
      rows: [
        row({ sn_account: 'CUST01', sn_name: 'Acme Ltd' }),
        row({ sn_account: 'CUST02', sn_name: 'Totally Unrelated XYZ' }),
      ],
    };
    const result = await suggestMandateMatch(makeOperaDb(state), 'Acme Ltd');
    expect(result.suggestions).toHaveLength(1);
    expect(result.suggestions[0]?.account).toBe('CUST01');
  });

  it('caps results at 5', async () => {
    const state: MockState = {
      rows: Array.from({ length: 8 }, (_, i) =>
        row({ sn_account: `CUST0${i}`, sn_name: 'Acme Ltd' }),
      ),
    };
    const result = await suggestMandateMatch(makeOperaDb(state), 'Acme Ltd');
    expect(result.suggestions).toHaveLength(5);
  });

  it('sorts by score desc, then GC-tagged first, then name asc', async () => {
    const state: MockState = {
      rows: [
        row({
          sn_account: 'CUST01',
          sn_name: 'Acme Bravo',
          sn_analsys: '',
        }),
        row({
          sn_account: 'CUST02',
          sn_name: 'Acme Alpha',
          sn_analsys: 'GC',
        }),
      ],
    };
    const result = await suggestMandateMatch(makeOperaDb(state), 'Acme');
    // Both at 0.85 (containment); GC first, then alphabetical name
    expect(result.suggestions[0]?.account).toBe('CUST02');
    expect(result.suggestions[1]?.account).toBe('CUST01');
  });

  it('flags is_gc=true for sn_analsys="GC"', async () => {
    const state: MockState = {
      rows: [
        row({
          sn_account: 'CUST01',
          sn_name: 'Acme Ltd',
          sn_analsys: 'GC',
        }),
      ],
    };
    const result = await suggestMandateMatch(makeOperaDb(state), 'Acme Ltd');
    expect(result.suggestions[0]?.is_gc).toBe(true);
  });

  it('returns empty list when no rows at all', async () => {
    const state: MockState = { rows: [] };
    const result = await suggestMandateMatch(makeOperaDb(state), 'Anything');
    expect(result.success).toBe(true);
    expect(result.suggestions).toHaveLength(0);
  });

  it('returns empty list when input name is blank', async () => {
    const state: MockState = {
      rows: [row({ sn_name: 'Acme Ltd' })],
    };
    const result = await suggestMandateMatch(makeOperaDb(state), '');
    expect(result.success).toBe(true);
    expect(result.suggestions).toHaveLength(0);
  });

  it('reports soft success on DB error (matches Python)', async () => {
    const operaDb: any = (_t: string) => {
      const builder: any = {
        where: () => builder,
        orderBy: () => builder,
        select: () => Promise.reject(new Error('DB unavailable')),
      };
      return builder;
    };
    operaDb.raw = (s: string) => s;
    const result = await suggestMandateMatch(operaDb, 'Anything');
    expect(result.success).toBe(true);
    expect(result.suggestions).toHaveLength(0);
  });

  it('rounds score to 3 decimal places', async () => {
    const state: MockState = {
      rows: [row({ sn_account: 'CUST01', sn_name: 'New York Meats' })],
    };
    const result = await suggestMandateMatch(
      makeOperaDb(state),
      'New York Mets',
    );
    const score = result.suggestions[0]?.score ?? 0;
    expect(score).toBe(Math.round(score * 1000) / 1000);
  });
});
