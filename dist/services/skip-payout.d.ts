/**
 * Skip a GoCardless payout — record to history without importing.
 *
 * Faithful port of `skip_gocardless_payout` from
 * apps/gocardless/api/routes.py:3187.
 *
 * Used for:
 *   - Foreign currency payouts that need manual posting in Opera
 *   - Payouts already manually entered
 *   - Duplicate payouts
 *
 * The payout appears in import history with imported_by="MANUAL-*"
 * and won't show in the available-payouts list.
 */
import type { Knex } from 'knex';
export interface SkipPayoutInput {
    payoutId: string;
    bankReference: string;
    grossAmount: number;
    currency?: string;
    paymentCount?: number;
    reason?: string;
    fxAmount?: number | null;
    payments?: Array<{
        matched_account?: string;
        customer_account?: string;
        customer_name?: string;
        amount?: number;
        description?: string;
    }>;
    targetSystem?: 'opera_se' | 'opera_3';
}
export interface SkipPayoutResponse {
    success: boolean;
    message?: string;
    record_id?: number;
    reason?: string;
    error?: string;
}
export declare function skipPayout(appDb: Knex, input: SkipPayoutInput): Promise<SkipPayoutResponse>;
//# sourceMappingURL=skip-payout.d.ts.map