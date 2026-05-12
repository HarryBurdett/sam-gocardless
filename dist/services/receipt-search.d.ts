/**
 * Receipt search across GoCardless import history.
 *
 * Faithful port of `search_gocardless_receipts` from
 * apps/gocardless/api/routes.py:2423.
 *
 * Reads import history from the per-app DB, flattens payments_json
 * into individual receipt rows, enriches with Opera customer names,
 * and applies customer/date filters.
 */
import type { Knex } from 'knex';
export interface Receipt {
    import_id: number;
    receipt_date: string;
    payout_id: string;
    bank_reference: string;
    batch_ref: string;
    customer_account: string;
    customer_name: string;
    gc_customer_name: string;
    amount: number;
    currency: string;
    payment_id: string;
    invoice_ref: string;
}
export interface ReceiptSearchOptions {
    customer?: string | null;
    fromDate?: string | null;
    toDate?: string | null;
    limit?: number;
}
export interface ReceiptSearchResponse {
    success: boolean;
    total: number;
    total_amount: number;
    receipts: Receipt[];
    error?: string;
}
export declare function searchReceipts(appDb: Knex, operaDb: Knex | null, opts?: ReceiptSearchOptions): Promise<ReceiptSearchResponse>;
//# sourceMappingURL=receipt-search.d.ts.map