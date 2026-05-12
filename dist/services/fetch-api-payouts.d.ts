/**
 * GoCardless API-driven payout fetcher.
 *
 * Faithful port of `get_gocardless_api_payouts`
 * (apps/gocardless/api/routes.py:1952-2313).
 *
 * Pipeline:
 *   1. Pull payouts list from GoCardless API (date-windowed).
 *   2. Early filter: drop payouts already in import history (by
 *      payout_id or bank_reference), and drop those whose reference
 *      prefix doesn't match the configured company_reference.
 *   3. Parallel fetch payment details for each survivor (10 workers,
 *      mirroring Python's ThreadPoolExecutor).
 *   4. Per payout: Opera duplicate-check (reference suffix → definite
 *      dup; or amount + date proximity → possible dup), period gate,
 *      foreign currency flag.
 *   5. Drop confirmed duplicates and period-closed payouts.
 *   6. Match remaining payments to Opera customers via
 *      matchPaymentsHelper.
 *   7. Build batch shape the frontend renders.
 *
 * Returns the legacy response shape: `{success, source, environment,
 * total_payouts, filter_stats, batches}`.
 */
import type { Knex } from 'knex';
import type { GoCardlessClient } from './gocardless-api.js';
export interface FetchApiPayoutsInput {
    status?: string;
    limit?: number;
    daysBack?: number;
    companyReference?: string;
    gcBankCode?: string | null;
    destBankCode?: string | null;
    /** target_system for history dedup, defaults to 'opera_se' */
    targetSystem?: 'opera_se' | 'opera_3' | 'opera3';
}
export interface FilterStats {
    total_from_api: number;
    filtered_duplicate_in_opera: number;
    filtered_already_in_history: number;
    filtered_period_closed: number;
    filtered_all_payments_excluded: number;
    filtered_error: number;
    error_details: string[];
    included: number;
}
export interface PayoutBatch {
    payout_id: string;
    source: 'api';
    possible_duplicate: boolean;
    is_value_mismatch: boolean;
    bank_tx_warning: string | null;
    period_valid: boolean;
    period_error: string | null;
    is_foreign_currency: boolean;
    home_currency: string;
    import_status: string;
    import_status_message: string | null;
    batch: {
        gross_amount: number;
        gocardless_fees: number;
        vat_on_fees: number;
        net_amount: number;
        bank_reference: string;
        currency: string;
        payment_date: string | null;
        payment_count: number;
        payments: Array<Record<string, unknown>>;
        fx_amount: number | null;
        fx_currency: string | null;
        exchange_rate: string | null;
        dest_bank_account: string | null;
        dest_bank_sort_code: string | null;
    };
}
export interface FetchApiPayoutsResponse {
    success: boolean;
    source?: 'api';
    environment?: 'sandbox' | 'live';
    total_payouts?: number;
    filter_stats?: FilterStats;
    batches?: PayoutBatch[];
    /**
     * SAM enhancement — when the user lands on the GoCardless page,
     * surface any `gocardless_imports` rows whose Opera atran/aentry
     * is gone. Strong signal of an Opera restore: the UI can render a
     * banner asking the user to confirm and trigger
     * /recover-from-restore. Always returned (count=0 means clean).
     */
    orphan_check?: {
        detected: boolean;
        count: number;
        summary: Array<{
            bank_reference: string;
            gross_amount: number;
        }>;
    };
    error?: string;
}
export declare function fetchGocardlessApiPayouts(appDb: Knex, operaDb: Knex, client: GoCardlessClient, environment: 'sandbox' | 'live', input: FetchApiPayoutsInput): Promise<FetchApiPayoutsResponse>;
//# sourceMappingURL=fetch-api-payouts.d.ts.map