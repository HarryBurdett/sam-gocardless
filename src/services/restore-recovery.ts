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
 * Extract the alphanumeric suffix from a GoCardless bank reference,
 * which is what Opera stores in `ae_entref`. Handles:
 *   - "INTSYSUKLTD-XZHS2G"          → "XZHS2G"
 *   - "INTSYSUKLTD-VQHVDY (EUR)"    → "VQHVDY"   (strip FX annotation)
 *   - "CLOUDSIS-6QR3F7JAV"          → "6QR3F7JAV"
 *   - "PO01KR3HTTK8BRNZ0M6VB5C886X1" → "M6VB5C886X1" (last 11 chars)
 */
function referenceSuffix(ref: string): string {
  if (!ref) return '';
  // Strip any parenthetical annotation (e.g. " (EUR)") added by the
  // SAM/legacy import flow for foreign-currency payouts.
  const cleaned = ref.replace(/\s*\([^)]*\)\s*/g, '').trim();
  return cleaned.includes('-')
    ? (cleaned.split('-').pop() ?? '').trim()
    : cleaned.slice(-8);
}

interface ImportRow {
  id: number;
  payout_id: string | null;
  bank_reference: string | null;
  gross_amount: number | string | null;
  net_amount: number | string | null;
  imported_at: Date | string | null;
  post_date: Date | string | null;
}

function rowToOrphan(r: ImportRow): OrphanedImport {
  return {
    id: r.id,
    payout_id: (r.payout_id ?? '').toString().trim(),
    bank_reference: (r.bank_reference ?? '').toString().trim(),
    gross_amount: Number(r.gross_amount ?? 0),
    net_amount: Number(r.net_amount ?? 0),
    imported_at:
      r.imported_at instanceof Date
        ? r.imported_at.toISOString()
        : String(r.imported_at ?? ''),
    post_date:
      r.post_date instanceof Date
        ? r.post_date.toISOString().slice(0, 10)
        : r.post_date
          ? String(r.post_date).slice(0, 10)
          : null,
  };
}

/**
 * Scan every `gocardless_imports` row, check each row's bank_reference
 * against Opera. Return rows where Opera has no matching atran/aentry
 * — these are the orphans (likely from a restore).
 *
 * Cost-conscious: instead of N queries (one per row), we build a
 * single query that returns the set of reference suffixes present in
 * Opera, then diff in memory.
 */
async function detectOrphans(
  operaDb: Knex,
  appDb: Knex,
): Promise<OrphanedImport[]> {
  const imports = (await appDb('gocardless_imports')
    .select(
      'id',
      'payout_id',
      'bank_reference',
      'gross_amount',
      'net_amount',
      'imported_at',
      'post_date',
    )
    .whereNotNull('bank_reference')
    .andWhereRaw("TRIM(bank_reference) <> ''")) as unknown as ImportRow[];
  if (!imports.length) return [];

  // Build unique-suffix set for the Opera batch lookup
  const suffixByImportId = new Map<number, string>();
  const suffixesNeeded = new Set<string>();
  for (const r of imports) {
    const ref = (r.bank_reference ?? '').toString().trim();
    const suffix = referenceSuffix(ref);
    if (suffix) {
      suffixByImportId.set(r.id, suffix);
      suffixesNeeded.add(suffix);
    }
  }
  if (suffixesNeeded.size === 0) return [];

  // Query Opera in batches (avoid > 2100 parameters on MSSQL — a real
  // SAM tenant might have thousands of GC imports historically).
  const suffixesPresent = new Set<string>();
  const batchSize = 200;
  const suffixList = Array.from(suffixesNeeded);
  for (let i = 0; i < suffixList.length; i += batchSize) {
    const batch = suffixList.slice(i, i + batchSize);
    // Build a OR list of LIKE clauses — one per suffix. We can't
    // parameterise the LIKE string when concatenating wildcards
    // around it via parameter binding on every dialect, so we
    // sanitise to alphanumerics (GC suffixes are always
    // alphanumeric per their reference format).
    const cleanBatch = batch.filter((s) => /^[A-Za-z0-9]+$/.test(s));
    if (cleanBatch.length === 0) continue;
    try {
      const rows = (await operaDb('aentry')
        .distinct(operaDb.raw('RTRIM(ae_entref) AS entref'))
        .where('ae_value', '>', 0)
        .andWhere(function refMatch(this: Knex.QueryBuilder) {
          for (const s of cleanBatch) {
            this.orWhereRaw(`RTRIM(ae_entref) LIKE '%${s}%'`);
          }
        })) as unknown as Array<{ entref: string | null }>;
      for (const r of rows ?? []) {
        const entref = (r.entref ?? '').trim();
        // Mark every suffix that appears as a substring of any
        // matched ae_entref as present.
        for (const s of cleanBatch) {
          if (entref.includes(s)) suffixesPresent.add(s);
        }
      }
    } catch {
      // Best-effort — Opera read errors fall through; assume
      // present rather than over-report orphans.
      for (const s of cleanBatch) suffixesPresent.add(s);
    }
  }

  const orphans: OrphanedImport[] = [];
  for (const r of imports) {
    const suffix = suffixByImportId.get(r.id);
    if (!suffix) continue;
    if (!suffixesPresent.has(suffix)) orphans.push(rowToOrphan(r));
  }
  return orphans;
}

/**
 * Read-only orphan check — returns rows the user can review.
 * Surface this via the GoCardless dashboard when the user reports a
 * restore.
 */
export async function checkOrphanedImports(
  operaDb: Knex,
  appDb: Knex,
): Promise<OrphanCheckResponse> {
  try {
    const orphans = await detectOrphans(operaDb, appDb);
    return { success: true, orphans, count: orphans.length };
  } catch (err: any) {
    return {
      success: false,
      orphans: [],
      count: 0,
      error: err?.message ?? String(err),
    };
  }
}

/**
 * Clear orphaned `gocardless_imports` rows after explicit user
 * confirmation. The normal API-payouts flow will then surface the
 * underlying payouts as ready to import again.
 */
export async function recoverGocardlessFromRestore(
  operaDb: Knex,
  appDb: Knex,
): Promise<OrphanRecoveryResponse> {
  try {
    const orphans = await detectOrphans(operaDb, appDb);
    if (orphans.length === 0) {
      return { success: true, cleared: 0, cleared_imports: [] };
    }
    const ids = orphans.map((o) => o.id);
    const cleared = Number(
      await appDb('gocardless_imports').whereIn('id', ids).del(),
    );
    return { success: true, cleared, cleared_imports: orphans };
  } catch (err: any) {
    return {
      success: false,
      cleared: 0,
      error: err?.message ?? String(err),
    };
  }
}
