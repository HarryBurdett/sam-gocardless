/**
 * Revalidate existing GoCardless batches against Opera.
 *
 * Faithful port of `revalidate_gocardless_batches` in
 * `apps/gocardless/api/routes.py:2530-2702`. Used after the operator
 * changes Opera parameters (opens a period, etc.) — refreshes
 * `period_valid` and `possible_duplicate` for previously-seen batches
 * without re-fetching from the GoCardless API.
 *
 * Per batch:
 *   - Parse `payment_date` (first 10 chars, YYYY-MM-DD)
 *   - Detect foreign currency (currency vs Opera home currency)
 *   - validatePostingPeriod(payment_date, 'SL')
 *   - Duplicate scan against Opera atran/aentry:
 *       Foreign currency → reference-only (last segment after '-')
 *       GBP             → reference + amount (1.00 tolerance), THEN
 *                         amount alone within 14 days
 *
 * Returns the batches with revalidation fields merged in. Original
 * fields preserved (like Python's `**batch` spread).
 */
import type { Knex } from 'knex';
export interface BatchInput {
    batch?: {
        gross_amount?: number;
        net_amount?: number;
        bank_reference?: string;
        payment_date?: string;
        currency?: string;
    };
    [key: string]: unknown;
}
export interface RevalidatedBatch extends BatchInput {
    period_valid: boolean;
    period_error: string | null;
    possible_duplicate: boolean;
    bank_tx_warning: string | null;
    is_foreign_currency: boolean;
    home_currency: string;
}
export interface RevalidateBatchesResult {
    success: boolean;
    batches: RevalidatedBatch[];
    current_period: {
        year: number | null;
        period: number | null;
    } | null;
    message?: string;
    error?: string;
}
export declare function revalidateBatches(operaDb: Knex, batches: BatchInput[]): Promise<RevalidateBatchesResult>;
//# sourceMappingURL=revalidate-batches.d.ts.map