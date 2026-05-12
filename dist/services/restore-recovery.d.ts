/**
 * GoCardless restore-recovery — detect and clear orphaned import
 * history rows after Opera SE has been restored from a backup.
 *
 * Same pattern as bank-reconcile's `recoverFromOperaDivergence`:
 *   - Detection (read-only): list every `gocardless_imports` row
 *     whose `bank_reference` no longer matches any Opera aentry/atran
 *     row. These are the orphans — SAM thinks they're imported, but
 *     Opera no longer has the underlying receipt.
 *   - Recovery (explicit POST): user has confirmed an Opera restore,
 *     delete the orphan rows so the normal API-payouts flow can
 *     re-import them. Never auto-runs without user confirmation.
 *
 * Detection method: legacy `find_opera_by_reference` uses
 * `RTRIM(ae_entref) LIKE '%<suffix>%'` to find the matching Opera
 * entry. We batch this — build a single Opera query that returns the
 * set of reference suffixes present in atran/aentry, then diff
 * against the SAM history.
 *
 * Bank reference format: `INTSYSUKLTD-XZHS2G` → suffix `XZHS2G` (the
 * last part after the hyphen). Suffix is what's typically present in
 * Opera's ae_entref since the company prefix may be truncated.
 */
import type { Knex } from 'knex';
export interface OrphanedImport {
    id: number;
    payout_id: string;
    bank_reference: string;
    gross_amount: number;
    net_amount: number;
    imported_at: string;
    post_date: string | null;
}
export interface OrphanCheckResponse {
    success: boolean;
    orphans: OrphanedImport[];
    count: number;
    error?: string;
}
export interface OrphanRecoveryResponse {
    success: boolean;
    cleared: number;
    cleared_imports?: OrphanedImport[];
    error?: string;
}
/**
 * Read-only orphan check — returns rows the user can review.
 * Surface this via the GoCardless dashboard when the user reports a
 * restore.
 */
export declare function checkOrphanedImports(operaDb: Knex, appDb: Knex): Promise<OrphanCheckResponse>;
/**
 * Clear orphaned `gocardless_imports` rows after explicit user
 * confirmation. The normal API-payouts flow will then surface the
 * underlying payouts as ready to import again.
 */
export declare function recoverGocardlessFromRestore(operaDb: Knex, appDb: Knex): Promise<OrphanRecoveryResponse>;
//# sourceMappingURL=restore-recovery.d.ts.map