/**
 * GoCardless import history — port of `get_gocardless_import_history`
 * from `apps/gocardless/api/routes.py`.
 *
 * Returns past GoCardless batches imported into Opera, optionally
 * enriched with Opera customer names from sname.
 *
 * Storage difference (not behavioural): in Python the history lives
 * in core-email's email_data.db. Under SAM, core-email is replaced
 * by SAM's email service, so the history moves to the gocardless
 * per-app database (table `gocardless_imports`).
 */
import type { Knex } from 'knex';
export interface ImportHistoryRecord {
    id: number;
    bank_reference: string;
    payment_date: string | null;
    gross_amount: number;
    fees_amount: number;
    vat_on_fees: number;
    net_amount: number;
    currency: string;
    bank_code: string;
    cbtype: string;
    imported_by: string;
    imported_at: string;
    target_system: string;
    payments: Array<Record<string, unknown>>;
    opera_entry_refs: string[];
}
export interface ImportHistoryResponse {
    success: boolean;
    /** Legacy key (read by frontend). */
    imports: ImportHistoryRecord[];
    /** Legacy total count (matches `len(history)` in Python). */
    total: number;
    error?: string;
}
interface GetImportHistoryOptions {
    limit?: number;
    fromDate?: string | null;
    toDate?: string | null;
    targetSystem?: 'opera_se' | 'opera_3';
}
export declare function getImportHistory(appDb: Knex, operaDb: Knex | null, opts?: GetImportHistoryOptions): Promise<ImportHistoryResponse>;
/**
 * Has this payout already been imported (by payout_id)?
 *
 * Faithful port of `is_gocardless_payout_imported`
 * (api/email/storage.py). Optionally restricts to a specific
 * target_system ('opera_se' / 'opera3').
 */
export declare function isGocardlessPayoutImported(appDb: Knex, payoutId: string, targetSystem?: 'opera_se' | 'opera_3' | 'opera3'): Promise<boolean>;
/**
 * Has this bank reference already been imported?
 *
 * Matches exact reference, or reference with a currency-suffix
 * (e.g. `INTSYSUKLTD-XYZ (EUR)`), exactly like the Python port.
 */
export declare function isGocardlessReferenceImported(appDb: Knex, bankReference: string, targetSystem?: 'opera_se' | 'opera_3' | 'opera3'): Promise<boolean>;
export {};
//# sourceMappingURL=import-history.d.ts.map