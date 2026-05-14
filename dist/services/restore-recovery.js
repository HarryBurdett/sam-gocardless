/**
 * Extract the alphanumeric suffix from a GoCardless bank reference,
 * which is what Opera stores in `ae_entref`. Handles:
 *   - "INTSYSUKLTD-XZHS2G"          → "XZHS2G"
 *   - "INTSYSUKLTD-VQHVDY (EUR)"    → "VQHVDY"   (strip FX annotation)
 *   - "CLOUDSIS-6QR3F7JAV"          → "6QR3F7JAV"
 *   - "PO01KR3HTTK8BRNZ0M6VB5C886X1" → "M6VB5C886X1" (last 11 chars)
 */
function referenceSuffix(ref) {
    if (!ref)
        return '';
    // Strip any parenthetical annotation (e.g. " (EUR)") added by the
    // SAM/legacy import flow for foreign-currency payouts.
    const cleaned = ref.replace(/\s*\([^)]*\)\s*/g, '').trim();
    return cleaned.includes('-')
        ? (cleaned.split('-').pop() ?? '').trim()
        : cleaned.slice(-8);
}
function rowToOrphan(r) {
    return {
        id: r.id,
        payout_id: (r.payout_id ?? '').toString().trim(),
        bank_reference: (r.bank_reference ?? '').toString().trim(),
        gross_amount: Number(r.gross_amount ?? 0),
        net_amount: Number(r.net_amount ?? 0),
        imported_at: r.imported_at instanceof Date
            ? r.imported_at.toISOString()
            : String(r.imported_at ?? ''),
        post_date: r.post_date instanceof Date
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
async function detectOrphans(operaDb, appDb) {
    // Only rows that ACTUALLY claim to have posted to Opera are candidates
    // for orphan detection. Skipped payouts (foreign-currency, manual-skip,
    // duplicate-skip) use imported_by markers like 'MANUAL-EUR' / 'MANUAL-SKIP'
    // / 'MANUAL-DUP' — these were never intended to be in Opera and must not
    // be flagged as orphans.
    //
    // NB: real imports populate `batch_ref` (the cashbook entry number, e.g.
    // 'R100001340') but leave `opera_entry_refs` empty. Earlier filter logic
    // that required opera_entry_refs to be populated excluded ALL real
    // imports — including genuine post-restore orphans. The correct claim
    // signal is the `imported_by` marker (real imports use 'GOCARDLS',
    // 'EMAIL', etc.; skips use 'MANUAL-*').
    const imports = (await appDb('gocardless_imports')
        .select('id', 'payout_id', 'bank_reference', 'gross_amount', 'net_amount', 'imported_at', 'post_date')
        .whereNotNull('bank_reference')
        .andWhereRaw("TRIM(bank_reference) <> ''")
        .andWhere(function notManual() {
        this.whereNull('imported_by')
            .orWhereRaw("imported_by NOT LIKE 'MANUAL-%'");
    }));
    if (!imports.length)
        return [];
    // Build unique-suffix set for the Opera batch lookup
    const suffixByImportId = new Map();
    const suffixesNeeded = new Set();
    for (const r of imports) {
        const ref = (r.bank_reference ?? '').toString().trim();
        const suffix = referenceSuffix(ref);
        if (suffix) {
            suffixByImportId.set(r.id, suffix);
            suffixesNeeded.add(suffix);
        }
    }
    if (suffixesNeeded.size === 0)
        return [];
    // Query Opera in batches (avoid > 2100 parameters on MSSQL — a real
    // SAM tenant might have thousands of GC imports historically).
    const suffixesPresent = new Set();
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
        if (cleanBatch.length === 0)
            continue;
        try {
            // Bind suffix as a query parameter rather than string-
            // interpolating into LIKE — audit HIGH. The sanitiser above
            // (/^[A-Za-z0-9]+$/) defends against today's call sites, but
            // any future relaxation of the regex would silently re-open
            // injection. The matching sister fix landed in bank-rec.
            const rows = (await operaDb('aentry')
                .distinct(operaDb.raw('RTRIM(ae_entref) AS entref'))
                .where('ae_value', '>', 0)
                .andWhere(function refMatch() {
                for (const s of cleanBatch) {
                    this.orWhereRaw('RTRIM(ae_entref) LIKE ?', [`%${s}%`]);
                }
            }));
            for (const r of rows ?? []) {
                const entref = (r.entref ?? '').trim();
                // Mark every suffix that appears as a substring of any
                // matched ae_entref as present.
                for (const s of cleanBatch) {
                    if (entref.includes(s))
                        suffixesPresent.add(s);
                }
            }
        }
        catch {
            // Best-effort — Opera read errors fall through; assume
            // present rather than over-report orphans.
            for (const s of cleanBatch)
                suffixesPresent.add(s);
        }
    }
    const orphans = [];
    for (const r of imports) {
        const suffix = suffixByImportId.get(r.id);
        if (!suffix)
            continue;
        if (!suffixesPresent.has(suffix))
            orphans.push(rowToOrphan(r));
    }
    return orphans;
}
/**
 * Read-only orphan check — returns rows the user can review.
 * Surface this via the GoCardless dashboard when the user reports a
 * restore.
 */
export async function checkOrphanedImports(operaDb, appDb) {
    try {
        const orphans = await detectOrphans(operaDb, appDb);
        return { success: true, orphans, count: orphans.length };
    }
    catch (err) {
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
export async function recoverGocardlessFromRestore(operaDb, appDb) {
    try {
        const orphans = await detectOrphans(operaDb, appDb);
        if (orphans.length === 0) {
            return { success: true, cleared: 0, cleared_imports: [] };
        }
        const ids = orphans.map((o) => o.id);
        const cleared = Number(await appDb('gocardless_imports').whereIn('id', ids).del());
        return { success: true, cleared, cleared_imports: orphans };
    }
    catch (err) {
        return {
            success: false,
            cleared: 0,
            error: err?.message ?? String(err),
        };
    }
}
//# sourceMappingURL=restore-recovery.js.map