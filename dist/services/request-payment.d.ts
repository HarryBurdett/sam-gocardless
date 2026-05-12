/**
 * GoCardless request-payment service.
 *
 * Faithful port of:
 *   - request_gocardless_payment (apps/gocardless/api/routes.py:8249-8435)
 *   - request_bulk_payments      (apps/gocardless/api/routes.py:8438-8486)
 *
 * Orchestrates: duplicate-invoice guard, mandate lookup, optional
 * Opera invoice-total summing (st_trbal), unallocated-credit safety
 * check, GoCardless POST /payments, then persist a row in
 * `gocardless_payment_requests`.
 *
 * The Opera read + remote create are injected so this module stays
 * unit-testable. Mirrors the existing pattern used by sync-from-opera.
 */
import type { Knex } from 'knex';
export interface MandateRecord {
    mandate_id: string;
    opera_account: string;
    opera_name: string | null;
}
export interface OperaSnapshot {
    /**
     * Sum of `st_trbal` across the requested invoices, in pounds. Null when
     * the invoices could not be located in stran.
     */
    invoiceTotalPounds: number | null;
    /**
     * Sum of unallocated credit on the customer's account
     * (`SUM(st_trbal) WHERE st_trbal < 0`), in pounds (positive number).
     * 0 when none.
     */
    unallocatedCreditPounds: number;
}
export interface RemoteCreatePaymentResult {
    success: boolean;
    payment?: {
        id?: string;
        status?: string;
        charge_date?: string;
        [k: string]: unknown;
    };
    error?: string;
}
export interface RequestPaymentInput {
    operaAccount: string;
    invoices: string[];
    /** When omitted, the Opera invoice total is used. */
    amountPence?: number | null;
    /** ISO date YYYY-MM-DD. Past dates are dropped (per Python). */
    chargeDate?: string | null;
    description?: string | null;
}
export interface RequestPaymentSettings {
    /** Truncated to 10 chars. Prefixed onto descriptions for bank visibility. */
    request_statement_reference?: string | null;
}
export interface RequestPaymentResponse {
    success: boolean;
    message?: string;
    payment_request?: Record<string, unknown> & {
        customer_name?: string;
        estimated_arrival?: string | null;
    };
    error?: string;
}
declare function normaliseChargeDate(raw: string | null | undefined, today?: Date): string | null;
declare function buildDescription(description: string | null | undefined, invoices: string[], stmtRefRaw: string | null | undefined): string;
declare function parseInvoiceRefs(value: unknown): string[];
export declare function requestPayment(appDb: Knex, input: RequestPaymentInput, settings: RequestPaymentSettings, readOpera: (operaAccount: string, invoices: string[]) => Promise<OperaSnapshot>, createRemote: (input: {
    amountPence: number;
    mandateId: string;
    description: string;
    chargeDate: string | null;
    metadata: Record<string, string>;
}) => Promise<RemoteCreatePaymentResult>, today?: Date): Promise<RequestPaymentResponse>;
export interface BulkRequestPaymentResponse {
    success: boolean;
    results: Array<{
        opera_account: string | null;
    } & RequestPaymentResponse>;
    summary: {
        total: number;
        succeeded: number;
        failed: number;
    };
}
export declare function requestBulkPayments(appDb: Knex, inputs: RequestPaymentInput[], settings: RequestPaymentSettings, readOpera: (operaAccount: string, invoices: string[]) => Promise<OperaSnapshot>, createRemote: (input: {
    amountPence: number;
    mandateId: string;
    description: string;
    chargeDate: string | null;
    metadata: Record<string, string>;
}) => Promise<RemoteCreatePaymentResult>, today?: Date): Promise<BulkRequestPaymentResponse>;
export declare const __test__: {
    buildDescription: typeof buildDescription;
    normaliseChargeDate: typeof normaliseChargeDate;
    parseInvoiceRefs: typeof parseInvoiceRefs;
};
export {};
//# sourceMappingURL=request-payment.d.ts.map