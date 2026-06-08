/**
 * Tests for the Opera id-allocation primitives in
 * src/_shared/opera/id-allocation.ts.
 *
 * Focus: Bug 3 from the 2026-06-05 production audit —
 * getNextJournal must NOT hand out a journal number that has
 * already been used in the current year by another posting source
 * (e.g. Opera Desktop / Zahara), even when nparm.np_nexjrnl is
 * lagging behind MAX(nt_jrnl).
 *
 * Strategy: use a transparent proxy "trx" that intercepts the SQL
 * by string match and returns canned rows / records UPDATE writes.
 * No real DB needed — the function is small and SQL-stable enough
 * that string-match is robust here.
 */
import { describe, it, expect } from 'vitest';
import type { Knex } from 'knex';
import { getNextJournal } from '../src/_shared/opera/id-allocation.js';

type Captured = { sql: string; bindings?: unknown[] };

interface FakeState {
  nparmNext: number;
  nparmYear: number;
  // For ntran MAX lookup per year — populated by the test
  ntranMaxByYear: Record<number, number | null>;
  writes: Captured[];
}

function makeFakeTrx(state: FakeState): Knex {
  const trx = {
    async raw(sql: string, bindings?: unknown[]) {
      const lower = sql.toLowerCase().replace(/\s+/g, ' ').trim();

      // The new combined SELECT that reads BOTH nparm.np_nexjrnl AND the
      // year-scoped MAX(nt_jrnl) — under UPDLOCK on nparm.
      if (
        lower.includes('from nparm') &&
        lower.includes('np_nexjrnl') &&
        lower.includes('max(nt_jrnl)')
      ) {
        const max = state.ntranMaxByYear[state.nparmYear] ?? null;
        return [
          {
            nparm_next: state.nparmNext,
            curr_year: state.nparmYear,
            ntran_max: max,
          },
        ];
      }

      // Legacy single SELECT — only nparm.np_nexjrnl. Kept for
      // back-compat detection if the fix is reverted.
      if (
        lower.includes('select np_nexjrnl from nparm') &&
        !lower.includes('max(nt_jrnl)')
      ) {
        return [{ np_nexjrnl: state.nparmNext }];
      }

      // UPDATE nparm SET np_nexjrnl = ?
      if (lower.startsWith('update nparm')) {
        state.writes.push({ sql, bindings });
        if (bindings && bindings.length > 0) {
          state.nparmNext = Number(bindings[0]);
        }
        return [];
      }

      throw new Error(`Unexpected SQL in fake trx: ${sql}`);
    },
  } as unknown as Knex;
  return trx;
}

describe('getNextJournal', () => {
  describe('Bug 3 hardening: Desktop / Zahara already used higher jrnl numbers', () => {
    it('returns nparm.np_nexjrnl when it is ahead of MAX(nt_jrnl in current year)', async () => {
      // The normal happy path: SAM is the only allocator and nparm
      // is up to date.
      const state: FakeState = {
        nparmNext: 201,
        nparmYear: 2026,
        ntranMaxByYear: { 2026: 200 }, // SAM has used 1..200
        writes: [],
      };
      const trx = makeFakeTrx(state);

      const next = await getNextJournal(trx, 1);
      expect(next).toBe(201);
      // After consuming 1, nparm should advance to 202
      expect(state.nparmNext).toBe(202);
    });

    it('returns MAX(nt_jrnl)+1 when Desktop has allocated higher than nparm (the production scenario)', async () => {
      // Cloudsis 2026-06-05 actual state: nparm=201 but Desktop's
      // posting source has used jrnl up to 6650. SAM must NOT hand
      // out 201 (which is free) without checking it isn't going to
      // collide — but more importantly, the right number is 6651.
      const state: FakeState = {
        nparmNext: 201,
        nparmYear: 2026,
        ntranMaxByYear: { 2026: 6650 }, // Desktop has used up to 6650
        writes: [],
      };
      const trx = makeFakeTrx(state);

      const next = await getNextJournal(trx, 1);
      expect(next).toBe(6651);
      expect(state.nparmNext).toBe(6652);
    });

    it('count > 1 allocates a contiguous block above the safe floor', async () => {
      const state: FakeState = {
        nparmNext: 201,
        nparmYear: 2026,
        ntranMaxByYear: { 2026: 6650 },
        writes: [],
      };
      const trx = makeFakeTrx(state);

      const first = await getNextJournal(trx, 5);
      expect(first).toBe(6651);
      // Block is 6651..6655; nparm should advance to 6656
      expect(state.nparmNext).toBe(6656);
    });

    it('returns 1 when nparm.np_nexjrnl is missing and ntran is empty (first-ever allocation)', async () => {
      const state: FakeState = {
        // nparmNext=1 means nparm.np_nexjrnl is set to 1 (or 0/null
        // which we treat as 1) — the natural starting point
        nparmNext: 1,
        nparmYear: 2026,
        ntranMaxByYear: { 2026: null }, // empty ntran for current year
        writes: [],
      };
      const trx = makeFakeTrx(state);
      const next = await getNextJournal(trx, 1);
      expect(next).toBe(1);
      expect(state.nparmNext).toBe(2);
    });
  });

  describe('default arguments', () => {
    it('defaults count to 1', async () => {
      const state: FakeState = {
        nparmNext: 100,
        nparmYear: 2026,
        ntranMaxByYear: { 2026: 99 },
        writes: [],
      };
      const trx = makeFakeTrx(state);
      const next = await getNextJournal(trx);
      expect(next).toBe(100);
      expect(state.nparmNext).toBe(101);
    });
  });
});
