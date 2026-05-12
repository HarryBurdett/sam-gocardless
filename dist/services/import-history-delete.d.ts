/**
 * Delete GoCardless import-history records.
 *
 * Faithful port of two endpoints in apps/gocardless/api/routes.py:
 *   DELETE /api/gocardless/import-history             (bulk by date range)
 *   DELETE /api/gocardless/import-history/{record_id} (single record)
 *
 * These only remove tracking rows from the per-app DB. They do NOT
 * touch Opera in any way (the cashbook entries posted by the original
 * import remain). Used to allow a payout to be re-imported.
 */
import type { Knex } from 'knex';
export interface ClearImportHistoryOptions {
    fromDate?: string | null;
    toDate?: string | null;
    targetSystem?: 'opera_se' | 'opera_3';
}
export interface ClearImportHistoryResponse {
    success: boolean;
    deleted_count: number;
    message?: string;
    error?: string;
}
/**
 * Bulk-delete import history within a date range.
 *
 * If no dates supplied, clears ALL records for the given target_system.
 * Caller is expected to confirm before invoking — the Python comment is
 * "use with caution".
 */
export declare function clearImportHistory(appDb: Knex, opts?: ClearImportHistoryOptions): Promise<ClearImportHistoryResponse>;
export interface DeleteImportRecordResponse {
    success: boolean;
    message?: string;
    error?: string;
}
export declare function deleteImportRecord(appDb: Knex, recordId: number): Promise<DeleteImportRecordResponse>;
//# sourceMappingURL=import-history-delete.d.ts.map