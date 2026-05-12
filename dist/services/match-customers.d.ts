/**
 * Match GoCardless payments to Opera customer accounts.
 *
 * Faithful port of `_match_gocardless_payments_helper` and the
 * `/api/gocardless/match-customers` endpoint wrapper in
 * `apps/gocardless/api/routes.py:271-575`.
 *
 * The matcher tries five strategies in priority order:
 *   0. metadata.opera_account from the original payment-request
 *   1. mandate_id → linked Opera account (mandates table)
 *   2. gocardless_customer_id → linked Opera account (mandates table)
 *   3. customer_name → mandate.opera_name / mandate.gocardless_name
 *      (normalised; exact then contains)
 *   4. customer_name → Opera sname.sn_name (normalised; exact then contains)
 *
 * Side effect: when match strategy 3 or 4 succeeds AND the payment
 * carries a `customer_id` AND the matched mandate has no
 * `gocardless_customer_id` recorded, we backfill it. Same behaviour as
 * the Python helper — wires up the gocardless_customer_id that's
 * authoritative for future direct mandate lookups.
 *
 * Wrapper endpoint additionally runs a duplicate check: scans Opera
 * `atran` (cashbook receipts, at_type=1) for transactions with the
 * same value (1p tolerance) and tags `possible_duplicate=true` +
 * a human-readable `duplicate_warning`.
 *
 * Dormant filter on sname (sn_dormant=0 OR NULL) per CLAUDE.md.
 */
import type { Knex } from 'knex';
export interface PaymentInput {
    customer_name?: string;
    description?: string;
    amount?: number;
    invoice_refs?: string[];
    mandate_id?: string;
    customer_id?: string;
    metadata?: Record<string, unknown>;
    gc_payment_id?: string;
}
export interface MatchedPayment {
    customer_name: string;
    description: string;
    amount: number;
    invoice_refs: string[];
    matched_account: string | null;
    matched_name: string | null;
    match_score: number;
    match_method: string | null;
    match_status: 'matched' | 'unmatched';
    possible_duplicate: boolean;
    duplicate_warning: string | null;
    gc_payment_id: string;
}
export interface MatchHelperResult {
    success: boolean;
    payments: MatchedPayment[];
    unmatched_count: number;
    total_count: number;
    error?: string;
}
export interface MatchEndpointResult extends MatchHelperResult {
    total_payments?: number;
    matched_count?: number;
    review_count?: number;
    duplicate_count?: number;
}
export declare function normalizeCompanyName(name: string): string;
export declare function matchPaymentsHelper(appDb: Knex, operaDb: Knex, payments: PaymentInput[]): Promise<MatchHelperResult>;
export interface DuplicateCheckOptions {
    /** at_cbtype filter to scope cashbook duplicate scan */
    defaultBatchType?: string | null;
}
export declare function matchCustomersWithDuplicateCheck(appDb: Knex, operaDb: Knex, payments: PaymentInput[], opts?: DuplicateCheckOptions): Promise<MatchEndpointResult>;
//# sourceMappingURL=match-customers.d.ts.map