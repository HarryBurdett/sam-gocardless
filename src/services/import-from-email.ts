/**
 * GoCardless import-from-email — wraps the standard batch import and
 * adds the email-archive step on success.
 *
 * Faithful port of `import_gocardless_from_email`
 * (apps/gocardless/api/routes.py:3266-3500).
 *
 * Reuses everything from `importGocardlessBatch` (validation,
 * idempotency, mandate verification, period gate, posting, history)
 * and adds:
 *   - email_id propagation through to the import-history row so the
 *     scan-emails endpoint can dedupe on next run
 *   - optional email-archive call via `EmailArchiveAdapter` —
 *     reports `archive_status` independently of import success so
 *     archive failures don't roll back the import
 */
import type { Knex } from 'knex';
import {
  importGocardlessBatch,
  type BatchPostingExecutor,
  type ImportLockAdapter,
  type ImportRequest,
  type ImportSettings,
  type MandateLink,
  type ImportBatchResponse,
} from './import-batch.js';

export type EmailArchiveStatus =
  | 'archived'
  | 'move_failed'
  | 'not_attempted'
  | 'provider_not_available'
  | 'email_not_found'
  | (`error: ${string}` & {});

export interface EmailArchiveAdapter {
  archive(opts: {
    emailId: number;
    archiveFolder: string;
  }): Promise<EmailArchiveStatus>;
}

export interface ImportFromEmailRequest extends Omit<ImportRequest, 'source' | 'emailId'> {
  emailId: number;
  archiveFolder?: string;
}

export interface ImportFromEmailResponse extends ImportBatchResponse {
  email_id?: number;
  archive_status?: EmailArchiveStatus;
}

export async function importGocardlessBatchFromEmail(
  operaDb: Knex,
  appDb: Knex,
  input: ImportFromEmailRequest,
  settings: ImportSettings,
  knownMandates: MandateLink[],
  executor: BatchPostingExecutor,
  importLock: ImportLockAdapter,
  archiveAdapter: EmailArchiveAdapter | null,
): Promise<ImportFromEmailResponse> {
  if (!Number.isFinite(input.emailId) || input.emailId <= 0) {
    return {
      success: false,
      error: 'email_id is required (positive number)',
    };
  }

  const importInput: ImportRequest = {
    ...input,
    source: 'email',
    emailId: input.emailId,
  };

  const result = await importGocardlessBatch(
    operaDb,
    appDb,
    importInput,
    settings,
    knownMandates,
    executor,
    importLock,
  );

  if (!result.success) {
    return { ...result, email_id: input.emailId };
  }

  // Best-effort archive — failure does not roll back the import.
  let archiveStatus: EmailArchiveStatus = 'not_attempted';
  const folder = input.archiveFolder ?? 'Archive/GoCardless';
  if (folder && archiveAdapter) {
    try {
      archiveStatus = await archiveAdapter.archive({
        emailId: input.emailId,
        archiveFolder: folder,
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      archiveStatus = `error: ${msg}` as EmailArchiveStatus;
    }
  } else if (folder && !archiveAdapter) {
    archiveStatus = 'provider_not_available';
  }

  return {
    ...result,
    email_id: input.emailId,
    archive_status: archiveStatus,
  };
}
