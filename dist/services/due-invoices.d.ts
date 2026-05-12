/**
 * GoCardless due-invoices listing.
 *
 * Faithful port of get_gocardless_due_invoices
 * (apps/gocardless/api/routes.py:7897-8214). Only shows invoices for
 * customers who have an active GoCardless mandate. Invoices are
 * grouped by customer for batch-collection UI.
 *
 * Filters:
 *   - advance_date (YYYY-MM-DD; default = today). Excludes invoices
 *     whose due date is later than this.
 *   - include_future (default true). When false, also excludes
 *     not-yet-overdue invoices.
 *
 * The Python source optionally hits the GoCardless API (list_payments)
 * to enrich `pending_invoice_requests` with payments made via the GC
 * dashboard (outside our app). That enrichment is injected via the
 * `fetchExternalPendingPayments` callback so the service stays
 * unit-testable. The router supplies the real API client; tests pass
 * a no-op.
 */
import type { Knex } from 'knex';
export interface DueInvoice {
    opera_account: string;
    customer_name: string;
    invoice_ref: string;
    invoice_date: string | null;
    due_date: string | null;
    days_until_due: number | null;
    is_overdue: boolean;
    is_due_by_advance: boolean;
    amount: number;
    amount_formatted: string;
    original_amount: number;
    has_mandate: boolean;
    mandate_id: string | null;
    trans_type: 'Invoice' | 'Credit Note';
    trans_type_code: string | number;
    customer_ref: string;
    payment_requested: boolean;
    payment_request_info: PaymentRequestInfo | null;
    is_subscription: boolean;
    source_doc: string | null;
}
export interface PaymentRequestInfo {
    request_id: number | string | null;
    status: string;
    charge_date: string | null;
    amount_pence: number | null;
    source?: string;
}
export interface DueInvoiceCustomer {
    account: string;
    name: string;
    email: string | null;
    has_mandate: boolean;
    mandate_id: string | null;
    invoices: DueInvoice[];
    total_due: number;
    total_due_formatted: string;
    invoice_count: number;
    unallocated_credit: number;
    unallocated_credit_formatted: string | null;
}
export interface DueInvoicesSummary {
    total_customers: number;
    total_invoices: number;
    total_amount: number;
    total_amount_formatted: string;
    collectable_amount: number;
    collectable_formatted: string;
    customers_with_mandate?: number;
    customers_without_mandate?: number;
}
export interface GetDueInvoicesResponse {
    success: boolean;
    customers: DueInvoiceCustomer[];
    invoices: DueInvoice[];
    summary: DueInvoicesSummary;
    advance_date: string;
    today: string;
    error?: string;
}
export interface GetDueInvoicesOptions {
    advanceDate?: string | null;
    /** Default true. */
    includeFuture?: boolean;
    /** Subscription analsys-tag (defaults to 'SUB' per Python). */
    subscriptionTag?: string;
    /**
     * Optional remote enrichment — called once with the pre-collected
     * pending invoice refs. Implementations should hit GoCardless's
     * list_payments and return (additional) refs covered by external
     * payments. Failures are swallowed (matches Python's "log + continue").
     */
    fetchExternalPendingPayments?: () => Promise<Array<{
        ref: string;
        info: PaymentRequestInfo;
    }>>;
}
export declare function getDueInvoices(operaDb: Knex, appDb: Knex, opts?: GetDueInvoicesOptions, todayDate?: Date): Promise<GetDueInvoicesResponse>;
//# sourceMappingURL=due-invoices.d.ts.map