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
export async function clearImportHistory(
  appDb: Knex,
  opts: ClearImportHistoryOptions = {},
): Promise<ClearImportHistoryResponse> {
  try {
    const targetSystem = opts.targetSystem ?? 'opera_se';
    let query = appDb('gocardless_imports').where({ target_system: targetSystem });
    if (opts.fromDate) query = query.andWhere('payment_date', '>=', opts.fromDate);
    if (opts.toDate) query = query.andWhere('payment_date', '<=', opts.toDate);

    const deleted = await query.delete();
    const count = Number(deleted ?? 0);

    return {
      success: true,
      deleted_count: count,
      message: `Cleared ${count} import history records`,
    };
  } catch (err: any) {
    return {
      success: false,
      deleted_count: 0,
      error: err?.message ?? String(err),
    };
  }
}

export interface DeleteImportRecordResponse {
  success: boolean;
  message?: string;
  error?: string;
}

export async function deleteImportRecord(
  appDb: Knex,
  recordId: number,
): Promise<DeleteImportRecordResponse> {
  if (!Number.isFinite(recordId) || recordId <= 0) {
    return { success: false, error: 'Invalid record id' };
  }

  try {
    const deleted = await appDb('gocardless_imports').where({ id: recordId }).delete();
    if (deleted > 0) {
      return {
        success: true,
        message: 'Import record deleted - payout can now be re-imported',
      };
    }
    return { success: false, error: 'Record not found' };
  } catch (err: any) {
    return { success: false, error: err?.message ?? String(err) };
  }
}
