import { importGocardlessBatch, } from './import-batch.js';
export async function importGocardlessBatchFromEmail(operaDb, appDb, input, settings, knownMandates, executor, importLock, archiveAdapter) {
    if (!Number.isFinite(input.emailId) || input.emailId <= 0) {
        return {
            success: false,
            error: 'email_id is required (positive number)',
        };
    }
    const importInput = {
        ...input,
        source: 'email',
        emailId: input.emailId,
    };
    const result = await importGocardlessBatch(operaDb, appDb, importInput, settings, knownMandates, executor, importLock);
    if (!result.success) {
        return { ...result, email_id: input.emailId };
    }
    // Best-effort archive — failure does not roll back the import.
    let archiveStatus = 'not_attempted';
    const folder = input.archiveFolder ?? 'Archive/GoCardless';
    if (folder && archiveAdapter) {
        try {
            archiveStatus = await archiveAdapter.archive({
                emailId: input.emailId,
                archiveFolder: folder,
            });
        }
        catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            archiveStatus = `error: ${msg}`;
        }
    }
    else if (folder && !archiveAdapter) {
        archiveStatus = 'provider_not_available';
    }
    return {
        ...result,
        email_id: input.emailId,
        archive_status: archiveStatus,
    };
}
//# sourceMappingURL=import-from-email.js.map