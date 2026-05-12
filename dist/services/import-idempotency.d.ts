/**
 * GoCardless import-idempotency helpers.
 *
 * Faithful port of:
 *   - is_gocardless_payout_imported    (api/email/storage.py:1204-1227)
 *   - is_gocardless_reference_imported (api/email/storage.py:1229-1254)
 *   - is_gocardless_imported           (api/email/storage.py:1256-1280)
 *   - get_imported_gocardless_email_ids (api/email/storage.py:1282+)
 *
 * Used by the import flow's idempotency gate, the unposted-payments
 * checker, and the scan-emails dedup logic — never post the same
 * payout twice.
 */
import type { Knex } from 'knex';
export interface IdempotencyOptions {
    /** Optional 'opera_se' | 'opera_3' filter. */
    targetSystem?: string | null;
}
export declare function isPayoutImported(appDb: Knex, payoutId: string, opts?: IdempotencyOptions): Promise<boolean>;
export declare function isReferenceImported(appDb: Knex, bankReference: string, opts?: IdempotencyOptions): Promise<boolean>;
export declare function isEmailImported(appDb: Knex, emailId: number, opts?: IdempotencyOptions): Promise<boolean>;
/**
 * List the email_ids that have been imported. Used by scan-emails to
 * filter out emails already in the import history.
 */
export declare function getImportedEmailIds(appDb: Knex, opts?: IdempotencyOptions): Promise<number[]>;
/**
 * Set of bank references that have been imported, from any source
 * (email or API). Faithful port of
 * `email_storage.get_imported_gocardless_references`.
 */
export declare function getImportedReferences(appDb: Knex, opts?: IdempotencyOptions): Promise<Set<string>>;
//# sourceMappingURL=import-idempotency.d.ts.map