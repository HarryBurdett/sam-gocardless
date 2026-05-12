/**
 * GoCardless email parser — TS port of `sql_rag/gocardless_parser.py`.
 *
 * Faithful regex-based parser for GoCardless payout notification
 * emails. Extracts the per-customer payment table, summary totals,
 * bank reference, payment date and currency. Used by `scan-emails`,
 * `parse-content`, and `import-from-email`.
 *
 * No LLM involved — the format is stable enough that regex is
 * reliable, and the determinism matters for duplicate detection.
 */
export interface GoCardlessPayment {
    customer_name: string;
    description: string;
    amount: number;
    invoice_refs: string[];
    matched_account?: string | null;
    matched_name?: string | null;
    match_score?: number;
    match_status?: 'matched' | 'unmatched' | 'multiple';
}
export interface GoCardlessBatch {
    payments: GoCardlessPayment[];
    gross_amount: number;
    gocardless_fees: number;
    app_fees: number;
    vat_on_fees: number;
    net_amount: number;
    bank_reference: string | null;
    payment_date: Date | null;
    email_subject: string | null;
    currency: string;
}
export declare function parseAmount(amountStr: string): number;
export declare function detectTransactionCurrency(content: string): string;
export declare function detectPayoutCurrency(content: string): string;
export declare function detectCurrency(content: string): string;
export declare function extractInvoiceRefs(description: string): string[];
export declare function parseGocardlessEmail(content: string): GoCardlessBatch;
export declare function batchTotalFees(b: GoCardlessBatch): number;
export declare function batchCalculatedGross(b: GoCardlessBatch): number;
//# sourceMappingURL=parser.d.ts.map