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
import { companyScope } from '../_shared/get-company.js';

export interface IdempotencyOptions {
  /** Optional 'opera_se' | 'opera_3' filter. */
  targetSystem?: string | null;
}

/**
 * Filter that excludes rows representing the operator's manual
 * "don't import" decisions:
 *   - MANUAL-EUR  / MANUAL-SKIP / MANUAL-DUP  (skipped at scan time)
 *   - ARCHIVE                                 (archived email, never an Opera entry)
 *
 * These rows live in gocardless_imports but were never posted to
 * Opera. Treating them as "imported" blocks the operator from
 * changing their mind later — particularly painful after an Opera
 * restore where they want a clean slate. Audit 2026-05-15 CRITICAL.
 */
function excludeNonImported(q: Knex.QueryBuilder): Knex.QueryBuilder {
  return q
    .andWhere(function notManual(this: Knex.QueryBuilder) {
      this.whereNull('imported_by')
        .orWhereRaw("imported_by NOT LIKE 'MANUAL-%'");
    })
    .andWhere(function notArchive(this: Knex.QueryBuilder) {
      this.whereNull('imported_by').orWhereRaw("imported_by <> 'ARCHIVE'");
    });
}

export async function isPayoutImported(
  appDb: Knex,
  companyCode: string,
  payoutId: string,
  opts: IdempotencyOptions = {},
): Promise<boolean> {
  const scope = companyScope(companyCode);
  const id = (payoutId ?? '').trim();
  if (!id) return false;
  try {
    let q = appDb('gocardless_imports').where({ ...scope, payout_id: id });
    if (opts.targetSystem) {
      q = q.andWhere({ target_system: opts.targetSystem });
    }
    q = excludeNonImported(q);
    const row = (await q.first()) as { id: number } | undefined;
    return !!row;
  } catch {
    return false;
  }
}

export async function isReferenceImported(
  appDb: Knex,
  companyCode: string,
  bankReference: string,
  opts: IdempotencyOptions = {},
): Promise<boolean> {
  const scope = companyScope(companyCode);
  const ref = (bankReference ?? '').trim();
  if (!ref) return false;
  try {
    // Match exact OR with currency suffix like "REF (EUR)" — same
    // behaviour as the Python implementation.
    let q = appDb('gocardless_imports').where({ ...scope }).andWhere((qb) => {
      qb.where({ bank_reference: ref }).orWhere(
        'bank_reference',
        'like',
        `${ref} (%`,
      );
    });
    if (opts.targetSystem) {
      q = q.andWhere({ target_system: opts.targetSystem });
    }
    q = excludeNonImported(q);
    const row = (await q.first()) as { id: number } | undefined;
    return !!row;
  } catch {
    return false;
  }
}

export async function isEmailImported(
  appDb: Knex,
  companyCode: string,
  emailId: number,
  opts: IdempotencyOptions = {},
): Promise<boolean> {
  const scope = companyScope(companyCode);
  if (!Number.isFinite(emailId) || emailId <= 0) return false;
  try {
    let q = appDb('gocardless_imports').where({ ...scope, email_id: emailId });
    if (opts.targetSystem) {
      q = q.andWhere({ target_system: opts.targetSystem });
    }
    const row = (await q.first()) as { id: number } | undefined;
    return !!row;
  } catch {
    return false;
  }
}

/**
 * List the email_ids that have been imported. Used by scan-emails to
 * filter out emails already in the import history.
 */
export async function getImportedEmailIds(
  appDb: Knex,
  companyCode: string,
  opts: IdempotencyOptions = {},
): Promise<number[]> {
  const scope = companyScope(companyCode);
  try {
    let q = appDb('gocardless_imports').where({ ...scope }).whereNotNull('email_id');
    if (opts.targetSystem) {
      q = q.andWhere({ target_system: opts.targetSystem });
    }
    const rows = (await q.distinct('email_id').select('email_id')) as Array<{
      email_id: number | null;
    }>;
    return rows
      .map((r) => Number(r.email_id))
      .filter((n) => Number.isFinite(n) && n > 0);
  } catch {
    return [];
  }
}

/**
 * Set of bank references that have been imported, from any source
 * (email or API). Faithful port of
 * `email_storage.get_imported_gocardless_references`.
 */
export async function getImportedReferences(
  appDb: Knex,
  companyCode: string,
  opts: IdempotencyOptions = {},
): Promise<Set<string>> {
  const scope = companyScope(companyCode);
  try {
    let q = appDb('gocardless_imports').where({ ...scope }).whereNotNull('bank_reference');
    if (opts.targetSystem) {
      q = q.andWhere({ target_system: opts.targetSystem });
    }
    const rows = (await q
      .distinct('bank_reference')
      .select('bank_reference')) as Array<{ bank_reference: string | null }>;
    const out = new Set<string>();
    for (const row of rows) {
      const ref = (row.bank_reference ?? '').toString().trim();
      if (ref) out.add(ref);
    }
    return out;
  } catch {
    return new Set();
  }
}
