/**
 * Mark a GoCardless payout email as archived (already in Opera).
 *
 * @param appDb        per-app DB
 * @param emailIngest  optional SAM email-ingest service. When SAM
 *                     adds a moveEmail capability, callers can pass
 *                     it here to perform the move; for now we accept
 *                     it for future-proofing and report
 *                     'provider_not_available'.
 */
export async function archiveGocardlessEmail(appDb, input, emailIngest) {
    if (!Number.isFinite(input.emailId) || input.emailId <= 0) {
        return { success: false, error: 'email_id is required (positive number)' };
    }
    // Step 1: tracking row — we always try this even if step 2 fails
    // (matches Python's try/except wrapping a logger.warning).
    let trackingError = null;
    try {
        await appDb('gocardless_imports').insert({
            email_id: input.emailId,
            target_system: 'archived',
            bank_reference: 'ARCHIVED',
            gross_amount: 0,
            net_amount: 0,
            payment_count: 0,
            source: 'email',
            imported_by: 'ARCHIVE',
            imported_at: appDb.fn.now(),
        });
    }
    catch (e) {
        trackingError = e?.message ?? String(e);
        // Continue — Python logs warning + carries on.
    }
    // Step 2: move the email — only if SAM's email-ingest service
    // exposes that capability. Currently SamEmailIngestService doesn't
    // declare moveEmail; report not-available so the frontend knows.
    let archiveStatus = 'not_attempted';
    if (input.archiveFolder && emailIngest) {
        archiveStatus = 'provider_not_available';
    }
    if (trackingError && archiveStatus === 'not_attempted') {
        // If tracking failed AND no move was attempted, surface the error.
        return {
            success: false,
            email_id: input.emailId,
            archive_status: 'not_attempted',
            error: `Could not record archive: ${trackingError}`,
        };
    }
    return {
        success: true,
        message: 'Email archived (already in Opera)',
        email_id: input.emailId,
        archive_status: archiveStatus,
    };
}
//# sourceMappingURL=archive-email.js.map