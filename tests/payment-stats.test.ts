import { describe, it, expect } from 'vitest';
import { getPaymentStats } from '../src/services/payment-stats.js';

interface Mandate {
  mandate_status: string;
}
interface PaymentRequest {
  status: string;
  amount: number;
  created_at: string; // ISO date
}

interface MockState {
  mandates: Mandate[];
  requests: PaymentRequest[];
}

function makeAppDb(state: MockState): any {
  const db: any = (table: string) => {
    if (table === 'gocardless_mandates') {
      let statusEq: string | null = null;
      const builder: any = {
        where: (cond: Record<string, unknown>) => {
          if ('mandate_status' in cond) statusEq = String(cond.mandate_status);
          return builder;
        },
        count: () => {
          const filtered = state.mandates.filter(
            (m) => statusEq === null || m.mandate_status === statusEq,
          );
          return Promise.resolve([{ count: filtered.length }]);
        },
      };
      return builder;
    }
    if (table === 'gocardless_payment_requests') {
      let statusEq: string | null = null;
      let statusIn: string[] | null = null;
      let createdAtFrom: string | null = null;
      const builder: any = {
        where: (cond: Record<string, unknown>) => {
          if ('status' in cond) statusEq = String(cond.status);
          return builder;
        },
        whereIn: (col: string, vals: string[]) => {
          if (col === 'status') statusIn = vals;
          return builder;
        },
        andWhere: (col: string, op: string, val: string) => {
          if (col === 'created_at' && op === '>=') createdAtFrom = val;
          return builder;
        },
        select: (..._args: unknown[]) => {
          const filtered = state.requests.filter((r) => {
            if (statusEq && r.status !== statusEq) return false;
            if (statusIn && !statusIn.includes(r.status)) return false;
            if (createdAtFrom && r.created_at < createdAtFrom) return false;
            return true;
          });
          const total = filtered.reduce((s, r) => s + r.amount, 0);
          return Promise.resolve([{ count: filtered.length, total }]);
        },
        count: () => {
          const filtered = state.requests.filter((r) => {
            if (statusEq && r.status !== statusEq) return false;
            if (createdAtFrom && r.created_at < createdAtFrom) return false;
            return true;
          });
          return Promise.resolve([{ count: filtered.length }]);
        },
      };
      return builder;
    }
    throw new Error(`Unexpected table: ${table}`);
  };
  db.raw = (sql: string) => sql;
  return db;
}

describe('getPaymentStats', () => {
  it('counts active mandates only', async () => {
    const state: MockState = {
      mandates: [
        { mandate_status: 'active' },
        { mandate_status: 'active' },
        { mandate_status: 'cancelled' },
        { mandate_status: 'expired' },
      ],
      requests: [],
    };
    const db = makeAppDb(state);
    const result = await getPaymentStats(db, new Date('2026-04-15T12:00:00Z'));

    expect(result.success).toBe(true);
    expect(result.active_mandates).toBe(2);
  });

  it('aggregates pending payments across all four pending statuses', async () => {
    const state: MockState = {
      mandates: [],
      requests: [
        { status: 'pending', amount: 100, created_at: '2026-04-10' },
        { status: 'pending_submission', amount: 50, created_at: '2026-04-09' },
        { status: 'submitted', amount: 75, created_at: '2026-04-08' },
        { status: 'confirmed', amount: 25, created_at: '2026-04-07' },
        // Excluded:
        { status: 'paid_out', amount: 999, created_at: '2026-04-01' },
        { status: 'failed', amount: 999, created_at: '2026-04-01' },
      ],
    };
    const db = makeAppDb(state);
    const result = await getPaymentStats(db, new Date('2026-04-15T12:00:00Z'));

    expect(result.pending_count).toBe(4);
    expect(result.pending_amount).toBe(250);
    expect(result.pending_amount_formatted).toBe('£250.00');
  });

  it('totals month-to-date paid-out by created_at >= 1st of month', async () => {
    const state: MockState = {
      mandates: [],
      requests: [
        { status: 'paid_out', amount: 1000, created_at: '2026-04-02' },
        { status: 'paid_out', amount: 250, created_at: '2026-04-14' },
        // Excluded — last month
        { status: 'paid_out', amount: 9999, created_at: '2026-03-30' },
        // Excluded — wrong status
        { status: 'pending', amount: 9999, created_at: '2026-04-10' },
      ],
    };
    const db = makeAppDb(state);
    const result = await getPaymentStats(db, new Date('2026-04-15T12:00:00Z'));

    expect(result.month_collected_count).toBe(2);
    expect(result.month_collected_amount).toBe(1250);
    expect(result.month_collected_formatted).toBe('£1,250.00');
  });

  it('counts failed in last 30 days', async () => {
    const now = new Date('2026-04-30T00:00:00Z');
    const state: MockState = {
      mandates: [],
      requests: [
        { status: 'failed', amount: 0, created_at: '2026-04-15' },
        { status: 'failed', amount: 0, created_at: '2026-04-01' }, // 29 days ago — included
        { status: 'failed', amount: 0, created_at: '2026-03-15' }, // 46 days ago — excluded
        { status: 'pending', amount: 0, created_at: '2026-04-29' }, // wrong status
      ],
    };
    const db = makeAppDb(state);
    const result = await getPaymentStats(db, now);

    expect(result.failed_count_30d).toBe(2);
  });

  it('formats GBP with comma thousands separator + 2dp', async () => {
    const state: MockState = {
      mandates: [],
      requests: [
        { status: 'paid_out', amount: 1234567.5, created_at: '2026-04-02' },
      ],
    };
    const db = makeAppDb(state);
    const result = await getPaymentStats(db, new Date('2026-04-15T12:00:00Z'));

    expect(result.month_collected_formatted).toBe('£1,234,567.50');
  });

  it('returns success=false on DB error', async () => {
    const db: any = () => {
      throw new Error('table missing');
    };
    db.raw = (s: string) => s;
    const result = await getPaymentStats(db);

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/table missing/);
  });
});
