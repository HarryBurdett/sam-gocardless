/**
 * Payment-request statistics for the GoCardless dashboard.
 *
 * Faithful port of `GoCardlessPaymentsDB.get_statistics` (in
 * `sql_rag/gocardless_payments.py:1419-1471`) — exposes:
 *   - active_mandates                  count of mandates with status='active'
 *   - pending_count + pending_amount   count + sum for status in
 *                                      pending/pending_submission/submitted/confirmed
 *   - month_collected_count + amount   status='paid_out' since 1st of current month
 *   - failed_count_30d                 status='failed' in last 30 days
 *
 * The Python module stored amounts as INTEGER pence; the SAM per-app
 * schema stores them as DECIMAL (already in pounds). The query layer
 * is adapted accordingly — output shape preserved exactly.
 *
 * Reads `gocardless_mandates.mandate_status` and `gocardless_payment_requests`
 * tables provisioned by migration 001_initial_schema.ts.
 */
import type { Knex } from 'knex';

export interface PaymentStats {
  active_mandates: number;
  pending_count: number;
  pending_amount: number;
  pending_amount_formatted: string;
  month_collected_count: number;
  month_collected_amount: number;
  month_collected_formatted: string;
  failed_count_30d: number;
}

export interface PaymentStatsResponse {
  success: boolean;
  active_mandates?: number;
  pending_count?: number;
  pending_amount?: number;
  pending_amount_formatted?: string;
  month_collected_count?: number;
  month_collected_amount?: number;
  month_collected_formatted?: string;
  failed_count_30d?: number;
  error?: string;
}

const PENDING_STATUSES = [
  'pending',
  'pending_submission',
  'submitted',
  'confirmed',
];

function formatGbp(amount: number): string {
  // Mirrors Python f"£{amount:,.2f}" — comma thousands sep, 2dp, GBP symbol
  const sign = amount < 0 ? '-' : '';
  const abs = Math.abs(amount);
  const fixed = abs.toFixed(2);
  const [whole = '0', frac = '00'] = fixed.split('.');
  // Insert comma every three digits
  const withCommas = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${sign}£${withCommas}.${frac}`;
}

function firstOfMonthIso(now: Date = new Date()): string {
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, '0');
  return `${y}-${m}-01`;
}

function thirtyDaysAgoIso(now: Date = new Date()): string {
  const t = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
  return t.toISOString().slice(0, 10);
}

export async function getPaymentStats(
  appDb: Knex,
  now: Date = new Date(),
): Promise<PaymentStatsResponse> {
  try {
    // Active mandates count
    const mandRow = (await appDb('gocardless_mandates')
      .where({ mandate_status: 'active' })
      .count<{ count: number | string }[]>('* as count')) as Array<{
      count: number | string;
    }>;
    const activeMandates = Number(mandRow[0]?.count ?? 0);

    // Pending payments — count + sum
    const pendingRow = (await appDb('gocardless_payment_requests')
      .whereIn('status', PENDING_STATUSES)
      .select(
        appDb.raw('COUNT(*) as count'),
        appDb.raw('COALESCE(SUM(amount), 0) as total'),
      )) as Array<{ count: number | string; total: number | string | null }>;
    const pendingCount = Number(pendingRow[0]?.count ?? 0);
    const pendingAmount = Number(pendingRow[0]?.total ?? 0);

    // This month collected
    const monthStart = firstOfMonthIso(now);
    const monthRow = (await appDb('gocardless_payment_requests')
      .where({ status: 'paid_out' })
      .andWhere('created_at', '>=', monthStart)
      .select(
        appDb.raw('COUNT(*) as count'),
        appDb.raw('COALESCE(SUM(amount), 0) as total'),
      )) as Array<{ count: number | string; total: number | string | null }>;
    const monthCount = Number(monthRow[0]?.count ?? 0);
    const monthAmount = Number(monthRow[0]?.total ?? 0);

    // Failed payments (last 30 days)
    const thirtyAgo = thirtyDaysAgoIso(now);
    const failedRow = (await appDb('gocardless_payment_requests')
      .where({ status: 'failed' })
      .andWhere('created_at', '>=', thirtyAgo)
      .count<{ count: number | string }[]>('* as count')) as Array<{
      count: number | string;
    }>;
    const failedCount = Number(failedRow[0]?.count ?? 0);

    return {
      success: true,
      active_mandates: activeMandates,
      pending_count: pendingCount,
      pending_amount: pendingAmount,
      pending_amount_formatted: formatGbp(pendingAmount),
      month_collected_count: monthCount,
      month_collected_amount: monthAmount,
      month_collected_formatted: formatGbp(monthAmount),
      failed_count_30d: failedCount,
    };
  } catch (err: any) {
    return { success: false, error: err?.message ?? String(err) };
  }
}
