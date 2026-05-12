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
export declare function getPaymentStats(appDb: Knex, now?: Date): Promise<PaymentStatsResponse>;
//# sourceMappingURL=payment-stats.d.ts.map