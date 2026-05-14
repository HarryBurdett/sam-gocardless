/**
 * GoCardless batch import — validation + orchestration layer.
 *
 * Faithful port of the route-level guards from
 * `import_gocardless_batch` (apps/gocardless/api/routes.py:622-949)
 * and the validation prelude from
 * `OperaSQLImport.import_gocardless_batch`
 * (sql_rag/opera_sql_import.py:6017-6213).
 *
 * Scope: every deterministic guard before the SQL posting body runs.
 * The actual posting (aentry / atran / stran / ntran / anoml / sname
 * updates) is delegated to a `BatchPostingExecutor` interface — the
 * SAM team plugs in the implementation that uses the unified Knex
 * client to write to either Opera SE (SQL Server) or Opera 3 via the
 * Write Agent.
 *
 * The exported `validateImportRequest` is the single source of truth
 * for "can we post this batch?" — used by the route and (later) by
 * batch-validate dry-run flows.
 */
import type { Knex } from 'knex';
export interface IncomingPayment {
    customer_account: string;
    customer_name?: string;
    opera_customer_name?: string;
    amount: number;
    description?: string;
    auto_allocate?: boolean;
    gc_payment_id?: string;
    mandate_id?: string;
}
export interface ValidatedPayment {
    customer_account: string;
    customer_name: string;
    opera_customer_name: string;
    amount: number;
    description: string;
    auto_allocate: boolean;
    gc_payment_id: string;
    mandate_id: string;
}
export interface ImportRequest {
    bankCode: string;
    postDate: string;
    reference?: string;
    completeBatch?: boolean;
    cbtype?: string | null;
    goCardlessFees?: number;
    vatOnFees?: number;
    feesNominalAccount?: string | null;
    feesVatCode?: string;
    feesPaymentType?: string | null;
    currency?: string | null;
    payoutId?: string | null;
    source?: 'api' | 'email';
    destBankAccount?: string | null;
    destBankSortCode?: string | null;
    payments: IncomingPayment[];
    /** Optional email id (set when importing from a scanned email). */
    emailId?: number | null;
    /**
     * Operator code threaded into Opera audit-trail fields
     * (atran.at_inputby, aentry.sq_cruser, ntran.nt_inp). Defaults to
     * 'GOCARDLS' to match legacy. Faithful port of
     * opera_sql_import.py:6029 — routes pass logged-in user initials.
     */
    inputBy?: string | null;
}
export interface ImportSettings {
    gocardless_bank_code?: string | null;
    gocardless_transfer_cbtype?: string | null;
}
export interface MandateLink {
    mandate_id: string;
    opera_account: string;
}
export interface ValidatedRequest {
    bankCode: string;
    postDate: Date;
    postDateString: string;
    reference: string;
    completeBatch: boolean;
    cbtype: string | null;
    goCardlessFees: number;
    vatOnFees: number;
    feesNominalAccount: string | null;
    feesVatCode: string;
    feesPaymentType: string | null;
    currency: string | null;
    payoutId: string | null;
    source: 'api' | 'email';
    destBankAccount: string | null;
    destBankSortCode: string | null;
    payments: ValidatedPayment[];
    postingBank: string;
    destinationBank: string | null;
    transferCbtype: string | null;
    emailId: number | null;
    /** Validated operator code (defaults 'GOCARDLS'). */
    inputBy: string;
    warnings: string[];
}
export interface ValidationFailure {
    success: false;
    error: string;
    errors?: string[];
    duplicate_payout?: boolean;
}
export interface ValidationOk {
    success: true;
    request: ValidatedRequest;
}
export type ValidationResult = ValidationFailure | ValidationOk;
export declare function resolveDestinationBank(operaDb: Knex, bankCode: string, destBankSortCode: string | null, destBankAccount: string | null): Promise<string>;
export declare function validateImportRequest(operaDb: Knex, appDb: Knex, input: ImportRequest, settings: ImportSettings, knownMandates: MandateLink[]): Promise<ValidationResult>;
/**
 * Posting executor — the part the SAM team writes against the unified
 * Knex client. Receives a fully validated request and performs the
 * actual aentry/atran/stran/ntran/anoml + balance updates.
 *
 * Returns the high-level outcome the route layer surfaces. Tests pass
 * a mock to verify the orchestration without exercising the SQL
 * writes.
 */
export interface BatchPostingExecutor {
    postBatch(operaDb: Knex, request: ValidatedRequest, 
    /**
     * Per-app SQLite — used by auto-allocation to read
     * `gocardless_payment_requests` for invoice_refs (legacy Rule 0,
     * `auto_allocate_receipt`). Optional so the mock in tests can omit
     * it; production callers always supply it.
     */
    appDb?: Knex | null): Promise<{
        success: boolean;
        records_imported: number;
        batch_ref?: string | null;
        warnings: string[];
        errors: string[];
    }>;
}
export interface RecordImportArgs {
    payoutId: string | null;
    source: 'api' | 'email';
    bankReference: string;
    grossAmount: number;
    netAmount: number;
    goCardlessFees: number;
    vatOnFees: number;
    paymentCount: number;
    paymentsJson: string;
    batchRef: string | null;
    importedBy: string;
    postDate: string;
    emailId?: number | null;
}
export interface ImportLockAdapter {
    acquire(key: string, locker: string): Promise<boolean>;
    release(key: string): Promise<void>;
}
export interface ImportBatchResponse {
    success: boolean;
    message?: string;
    payments_imported?: number;
    complete?: boolean;
    details?: string[];
    error?: string;
    duplicate_payout?: boolean;
}
export declare function importGocardlessBatch(operaDb: Knex, appDb: Knex, input: ImportRequest, settings: ImportSettings, knownMandates: MandateLink[], executor: BatchPostingExecutor, importLock: ImportLockAdapter): Promise<ImportBatchResponse>;
//# sourceMappingURL=import-batch.d.ts.map