/**
 * Auto-allocate a sales receipt to outstanding invoices.
 *
 * Faithful port of `OperaSQLImport.auto_allocate_receipt`
 * (sql_rag/opera_sql_import.py:7017-7426). Called per-payment from the
 * GoCardless batch posting executor immediately after each stran
 * receipt INSERT, when `auto_allocate=true` is set on the payment.
 *
 * Allocation rules (priority order, exact legacy parity):
 *   Rule 0 — payment request invoice lookup: if `gc_payment_id` is
 *     supplied AND the payment request was raised with stored
 *     `invoice_refs`, allocate to those still outstanding (skipping
 *     any already paid manually in Opera). Any excess stays on
 *     account. Partial allocation supported.
 *   Rule 1 — invoice reference in description: search description
 *     for /INV\d+/, allocate to matching invoices iff their total
 *     equals the receipt exactly. Otherwise return mismatch error.
 *   Rule 2 — clear-account: if the receipt equals the customer's
 *     total outstanding AND there is ≥1 invoice, allocate to all.
 *
 * Otherwise the receipt is left on account (success=false with
 * a diagnostic message; caller continues — does NOT abort the
 * batch).
 *
 * Side effects (all in the caller's existing trx — no new transaction):
 *   - stran (receipt): st_trbal +allocated, st_paid='A', st_payday,
 *     st_payflag = next payflag
 *   - stran (each allocated invoice): st_trbal -allocated, st_paid='P'
 *     when fully cleared, st_payday, st_payflag, st_lastrec
 *   - salloc: insert one row per allocated invoice + one row for the
 *     receipt itself when fully allocated; al_unique = stran.id
 *     (Opera convention)
 *   - sname.sn_lastrec = allocation date
 *
 * SAM additional safety: every DML uses Knex's `.update()` builder
 * which returns rowsAffected as a real number across mssql/foxpro/
 * sqlite drivers (not `trx.raw('UPDATE...')` which silently returns
 * empty array on mssql/tedious).
 */
import type { Knex } from 'knex';
export interface AllocateReceiptInput {
    customerAccount: string;
    receiptRef: string;
    /** Receipt amount in POUNDS (positive). */
    receiptAmount: number;
    /** YYYY-MM-DD string. */
    allocationDate: string;
    /** Bank account code (for salloc.al_acnt audit). */
    bankAccount: string;
    /** Description to scan for /INV\d+/ references. */
    description?: string | null;
    /** GoCardless payment ID, for Rule 0 lookup. */
    gcPaymentId?: string | null;
    /**
     * ISO timestamp string ('YYYY-MM-DD HH:MM:SS') for datecreated /
     * datemodified columns. Caller passes this so the timestamp is
     * consistent across all rows in the same batch and the SQL is
     * portable across SQL Server (Opera SE) and FoxPro (Opera 3) —
     * neither dialect's "current timestamp" function is the same.
     */
    nowIso: string;
}
export interface AllocatedInvoice {
    ref: string;
    custref: string;
    amount: number;
    full_allocation: boolean;
    unique: string;
    stran_id: number;
}
export interface AllocateReceiptResult {
    success: boolean;
    allocated_amount: number;
    allocations: AllocatedInvoice[];
    receipt_fully_allocated?: boolean;
    allocation_method?: 'payment_request' | 'invoice_reference' | 'clears_account' | 'single_invoice_match';
    message: string;
}
export declare function autoAllocateReceipt(trx: Knex, appDb: Knex | null, input: AllocateReceiptInput): Promise<AllocateReceiptResult>;
//# sourceMappingURL=allocate-receipt.d.ts.map