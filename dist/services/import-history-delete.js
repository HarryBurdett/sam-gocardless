/**
 * Bulk-delete import history within a date range.
 *
 * If no dates supplied, clears ALL records for the given target_system.
 * Caller is expected to confirm before invoking — the Python comment is
 * "use with caution".
 */
export async function clearImportHistory(appDb, opts = {}) {
    try {
        const targetSystem = opts.targetSystem ?? 'opera_se';
        let query = appDb('gocardless_imports').where({ target_system: targetSystem });
        if (opts.fromDate)
            query = query.andWhere('payment_date', '>=', opts.fromDate);
        if (opts.toDate)
            query = query.andWhere('payment_date', '<=', opts.toDate);
        const deleted = await query.delete();
        const count = Number(deleted ?? 0);
        return {
            success: true,
            deleted_count: count,
            message: `Cleared ${count} import history records`,
        };
    }
    catch (err) {
        return {
            success: false,
            deleted_count: 0,
            error: err?.message ?? String(err),
        };
    }
}
export async function deleteImportRecord(appDb, recordId) {
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
    }
    catch (err) {
        return { success: false, error: err?.message ?? String(err) };
    }
}
//# sourceMappingURL=import-history-delete.js.map