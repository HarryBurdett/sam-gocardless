/**
 * Duplicate-batch detection for GoCardless scan-emails.
 *
 * Faithful port of the four-check duplicate-detection block in
 * `apps/gocardless/api/routes.py:2879-3050`. Runs against Opera's
 * cashbook (atran/aentry) to spot batches that have already been
 * posted by reference, by NET, by GROSS, or by individual payments.
 *
 * Returns flags rather than booleans so the UI can present each
 * warning class separately (the original Python returned three
 * distinct strings).
 */
import type { Knex } from 'knex';
export interface BatchPaymentForDup {
    amount: number;
}
export interface DuplicateInput {
    netAmountPounds: number;
    grossAmountPounds: number;
    goCardlessFeesPounds: number;
    bankReference?: string | null;
    paymentDate?: Date | null;
    payments: BatchPaymentForDup[];
    /** Optional cashbook type filter (e.g. 'BARC'). */
    defaultCbtype?: string | null;
}
export interface DuplicateResult {
    possible_duplicate: boolean;
    duplicate_warning: string | null;
    bank_tx_warning: string | null;
    ref_warning: string | null;
}
export declare function checkDuplicateBatch(operaDb: Knex, input: DuplicateInput): Promise<DuplicateResult>;
//# sourceMappingURL=duplicate-detection.d.ts.map