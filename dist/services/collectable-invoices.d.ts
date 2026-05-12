/**
 * GoCardless collectable-invoices listing.
 *
 * Faithful port of get_collectable_invoices
 * (apps/gocardless/api/routes.py:7721-7894). Reads outstanding sales-
 * ledger invoices (stran.st_trbal > 0, st_trtype='I') joined to
 * sname for customer names, and decorates each row with:
 *   - active mandate status (from local gocardless_mandates)
 *   - whether a payment_request already covers this invoice
 *   - subscription tagging info (when an active subscription has
 *     source_doc = invoice ref or matches by account)
 *
 * Two filters: overdue_only (skips not-yet-overdue rows) and
 * min_amount.
 */
import type { Knex } from 'knex';
export interface CollectableInvoice {
    opera_account: string;
    customer_name: string;
    invoice_ref: string;
    invoice_date: string | null;
    due_date: string | null;
    amount: number;
    amount_formatted: string;
    days_overdue: number;
    is_overdue: boolean;
    has_mandate: boolean;
    mandate_id: string | null;
    mandate_status: string | null;
    trans_type: 'Invoice' | 'Credit Note';
    is_subscription: boolean;
    source_doc: string | null;
    payment_requested: boolean;
}
export interface GetCollectableInvoicesOptions {
    /** Default false. */
    overdueOnly?: boolean;
    /** Default 0 (no minimum). */
    minAmount?: number;
}
export interface GetCollectableInvoicesResponse {
    success: boolean;
    invoices: CollectableInvoice[];
    count: number;
    total_collectable: number;
    total_collectable_formatted: string;
    total_with_mandate: number;
    total_with_mandate_formatted: string;
    mandates_available: number;
    error?: string;
}
export declare function getCollectableInvoices(operaDb: Knex, appDb: Knex, opts?: GetCollectableInvoicesOptions, today?: Date): Promise<GetCollectableInvoicesResponse>;
//# sourceMappingURL=collectable-invoices.d.ts.map