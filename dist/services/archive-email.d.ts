/**
 * Archive a GoCardless email without importing.
 *
 * Faithful port of `archive_gocardless_email`
 * (apps/gocardless/api/routes.py:3503-3574).
 *
 * Used when the operator sees a payout that's already in Opera (e.g.
 * imported via a previous run, or manually entered). Marks the email
 * as processed so it won't reappear in future scans, and (when SAM's
 * email-ingest service is available at runtime) moves the email to
 * an Archive folder.
 *
 * Side effects:
 *   1. Insert a row into `gocardless_imports` with target_system='archived'
 *      so is_gocardless_email_imported(email_id) returns true on the
 *      next scan.
 *   2. Optional: move the email to `archive_folder` via SAM's email
 *      service. SAM's email-ingest API doesn't currently expose a
 *      moveEmail() method — the move is therefore reported as
 *      `provider_not_available` until that capability lands. The
 *      tracking row write still happens (matches Python's "best-effort
 *      archive even if move fails" behaviour).
 *
 * Body / params:
 *   - email_id (required)
 *   - archive_folder (default 'Archive/GoCardless')
 */
import type { Knex } from 'knex';
import type { SamEmailIngestService } from '../app-context.js';
export type ArchiveStatus = 'archived' | 'move_failed' | 'not_attempted' | 'provider_not_available' | 'email_not_found' | (`error: ${string}` & {});
export interface ArchiveEmailInput {
    emailId: number;
    archiveFolder?: string;
}
export interface ArchiveEmailResponse {
    success: boolean;
    message?: string;
    email_id?: number;
    archive_status?: ArchiveStatus;
    error?: string;
}
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
export declare function archiveGocardlessEmail(appDb: Knex, input: ArchiveEmailInput, emailIngest?: SamEmailIngestService | null): Promise<ArchiveEmailResponse>;
//# sourceMappingURL=archive-email.d.ts.map