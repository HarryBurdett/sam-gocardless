/**
 * GoCardless unposted-payments check.
 *
 * Faithful port of get_unposted_gocardless_payments
 * (apps/gocardless/api/routes.py:6283-6401). Used by the dashboard
 * to warn the operator before they request new payments — surfaces
 * any GoCardless payment_requests whose money has been collected
 * (status='confirmed' or 'paid_out') but the receipt hasn't been
 * posted to Opera yet.
 *
 * Three "already posted" checks per payment, in order:
 *   1. Has the payout been imported? (callback — depends on the
 *      email_storage layer SAM provides)
 *   2. Are the invoice_refs fully paid in Opera? (stran.st_trbal
 *      ≈ 0 for any of the first 3 invoice refs)
 *   3. Is there a matching cashbook receipt? (aentry/atran with
 *      at_type=4, at_inputby='GOCARDLS', amount within 1p,
 *      ae_comment contains opera_account)
 *
 * On any check matching, the local payment_request row is updated
 * to status='posted' (best-effort — failures swallowed).
 */
import type { Knex } from 'knex';
export interface UnpostedPayment {
    id: number | string | null;
    opera_account: string | null;
    customer_name: string;
    amount: number;
    status: string;
    charge_date: string | null;
    invoice_refs: string | string[] | null;
}
export interface UnpostedPaymentsResponse {
    success: boolean;
    has_unposted: boolean;
    unposted_count: number;
    unposted_total: number;
    unprocessed_batches: number;
    unposted: UnpostedPayment[];
    error?: string;
}
export interface PaymentRequestRow {
    id: number;
    status: string | null;
    payout_id: string | null;
    invoice_refs: string | null;
    opera_account: string | null;
    amount_pence: number | string | null;
    charge_date: string | null;
}
export interface UnpostedOptions {
    /**
     * Optional check that returns true when the payout's already been
     * imported. Mirrors Python's `email_storage.is_gocardless_payout_imported`.
     */
    isPayoutImported?: (payoutId: string) => Promise<boolean>;
    /**
     * Optional getter for unprocessed payout email count
     * (Python's `email_storage.get_gocardless_imports`). Returns the
     * number of payout emails that haven't been imported yet.
     */
    getUnprocessedBatchCount?: () => Promise<number>;
    /**
     * Customer-name lookup for response enrichment. The local
     * payment_requests table doesn't carry the name, so callers can
     * inject a map keyed by opera_account.
     */
    customerNamesByAccount?: Map<string, string>;
}
export declare function getUnpostedPayments(operaDb: Knex, appDb: Knex, opts?: UnpostedOptions): Promise<UnpostedPaymentsResponse>;
//# sourceMappingURL=unposted-payments.d.ts.map