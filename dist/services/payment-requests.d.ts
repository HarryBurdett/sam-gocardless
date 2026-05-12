/**
 * Payment-request listing for the GoCardless dashboard.
 *
 * Faithful port of `list_payment_requests`
 * (apps/gocardless/api/routes.py:8217-8246).
 *
 * Reads from the per-app DB's `gocardless_payment_requests` table
 * and enriches each row with customer_name from the matching mandate.
 *
 * Filters: status, opera_account. Default limit 100.
 */
import type { Knex } from 'knex';
export interface PaymentRequest {
    id: number;
    payment_id: string;
    mandate_id: string;
    opera_account: string;
    amount: number;
    amount_pence: number | null;
    currency: string;
    status: string;
    reference: string;
    charge_date: string;
    payout_id: string;
    invoice_refs: string;
    opera_receipt_ref: string;
    error_message: string;
    created_at: string;
    updated_at: string;
    customer_name: string;
}
export interface ListPaymentRequestsOptions {
    status?: string | null;
    operaAccount?: string | null;
    limit?: number;
}
export interface ListPaymentRequestsResponse {
    success: boolean;
    requests: PaymentRequest[];
    count: number;
    error?: string;
}
export interface GetPaymentRequestResponse {
    success: boolean;
    payment_request?: PaymentRequest;
    error?: string;
}
export declare function getPaymentRequest(appDb: Knex, requestId: number): Promise<GetPaymentRequestResponse>;
export interface SyncRemote {
    (paymentId: string): Promise<{
        success: boolean;
        payment?: {
            status?: string;
            charge_date?: string;
            [k: string]: unknown;
        };
        error?: string;
    }>;
}
export interface SyncPaymentStatusesResponse {
    success: boolean;
    message?: string;
    total_checked?: number;
    updated?: number;
    error?: string;
}
export declare function syncPaymentStatuses(appDb: Knex, syncRemote: SyncRemote): Promise<SyncPaymentStatusesResponse>;
export interface CancelPaymentRequestResponse {
    success: boolean;
    message?: string;
    error?: string;
    /** True when local row was marked cancelled (whether or not the
     *  GoCardless API also accepted the cancel). */
    local_cancelled?: boolean;
    /** Set when the GoCardless API call returned an error message —
     *  local cancel still proceeds. Matches Python's "log + continue"
     *  behaviour. */
    remote_warning?: string;
}
export declare function cancelPaymentRequest(appDb: Knex, requestId: number, cancelRemote?: (paymentId: string) => Promise<{
    success: boolean;
    error?: string;
}>): Promise<CancelPaymentRequestResponse>;
export declare function listPaymentRequests(appDb: Knex, opts?: ListPaymentRequestsOptions): Promise<ListPaymentRequestsResponse>;
//# sourceMappingURL=payment-requests.d.ts.map