/**
 * Post-write verification helpers for the GoCardless batch posting.
 *
 * Two-phase verification analogous to the bank-reconcile executor:
 *
 *   (A) `assert*` helpers run INSIDE the trx that just did the
 *       INSERTs. They use `WITH (NOLOCK)` so they take no shared
 *       locks. Mismatch throws `PostingVerificationError`, the
 *       caller rethrows, and Knex rolls the whole batch back. No
 *       half-posted batch ever lands.
 *
 *   (C) `verifyAentryCommitted` runs AFTER the trx commits, from a
 *       fresh pool connection. Confirms the COMMIT is visible
 *       outside our session. Mismatch surfaces a hard
 *       operator-action error rather than silently retrying.
 *
 * Lock surface: zero new locks. NOLOCK throughout so concurrent
 * Opera UI users are never blocked by our verification step.
 *
 * Differs from the bank-rec verifier in that the GC batch has
 * structural shapes that need set-based assertions:
 *   - one aentry header with `ae_value = SUM(payments)`
 *   - N atran lines under the same entry, summing to the header
 *   - N stran lines on the sales ledger, summing to -totalPounds
 *   - completeBatch optionally adds N ntran pairs + N anoml pairs
 *   - optional fees entry: separate aentry + 1-2 atran + 2-3 ntran
 *   - optional destination transfer: paired aentry+atran+ntran+anoml
 */
import type { Knex } from 'knex';

export class PostingVerificationError extends Error {
  readonly batchRef: string | null;
  readonly phase: 'in-trx' | 'post-commit';
  constructor(
    message: string,
    opts: { batchRef: string | null; phase: 'in-trx' | 'post-commit' },
  ) {
    super(message);
    this.name = 'PostingVerificationError';
    this.batchRef = opts.batchRef;
    this.phase = opts.phase;
  }
}

function isPlainErr(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

// ---------------------------------------------------------------------
// Phase A — in-trx assertions
// ---------------------------------------------------------------------

/**
 * Confirm a single aentry header row exists with the expected
 * signed pence. Identified by (ae_entry, ae_acnt).
 */
export async function assertAentryHeader(
  trx: Knex,
  opts: {
    entryNumber: string;
    bankAccount: string;
    expectedValuePence: number;
    label?: string; // for error messages e.g. "batch", "fees", "transfer-out"
  },
): Promise<void> {
  let rows: Array<{ ae_value: number | null }>;
  try {
    rows = (await trx.raw(
      `SELECT ae_value FROM aentry WITH (NOLOCK)
       WHERE RTRIM(ae_entry) = ?
         AND RTRIM(ae_acnt) = ?`,
      [opts.entryNumber, opts.bankAccount],
    )) as unknown as Array<{ ae_value: number | null }>;
  } catch (err) {
    throw new PostingVerificationError(
      `aentry in-trx verify failed (${opts.label ?? 'header'} entry=${opts.entryNumber}): ${isPlainErr(err)}`,
      { batchRef: opts.entryNumber, phase: 'in-trx' },
    );
  }
  if (!Array.isArray(rows) || rows.length !== 1) {
    throw new PostingVerificationError(
      `aentry ${opts.label ?? 'header'} missing or duplicate (entry=${opts.entryNumber}, bank=${opts.bankAccount}): got ${rows?.length ?? 0} rows`,
      { batchRef: opts.entryNumber, phase: 'in-trx' },
    );
  }
  const stored = Number(rows[0]!.ae_value ?? NaN);
  if (!Number.isFinite(stored) || stored !== opts.expectedValuePence) {
    throw new PostingVerificationError(
      `aentry ${opts.label ?? 'header'}.ae_value mismatch for ${opts.entryNumber}: stored=${stored} expected=${opts.expectedValuePence}`,
      { batchRef: opts.entryNumber, phase: 'in-trx' },
    );
  }
}

/**
 * Confirm atran row count and signed pence sum for an entry under
 * a given bank account. Used to verify the N customer lines under
 * the batch aentry, AND the 1-2 fees lines under the fees aentry,
 * AND the single line under each transfer-leg aentry.
 */
export async function assertAtranCountAndSum(
  trx: Knex,
  opts: {
    entryNumber: string;
    bankAccount: string;
    expectedCount: number;
    expectedSumPence: number;
    label?: string;
  },
): Promise<void> {
  let rows: Array<{ cnt: number | null; total: number | null }>;
  try {
    rows = (await trx.raw(
      `SELECT COUNT(*) AS cnt, SUM(at_value) AS total
       FROM atran WITH (NOLOCK)
       WHERE RTRIM(at_entry) = ?
         AND RTRIM(at_acnt) = ?`,
      [opts.entryNumber, opts.bankAccount],
    )) as unknown as Array<{ cnt: number | null; total: number | null }>;
  } catch (err) {
    throw new PostingVerificationError(
      `atran in-trx verify failed (${opts.label ?? 'lines'} entry=${opts.entryNumber}): ${isPlainErr(err)}`,
      { batchRef: opts.entryNumber, phase: 'in-trx' },
    );
  }
  const cnt = Number(rows?.[0]?.cnt ?? 0);
  const total = Number(rows?.[0]?.total ?? NaN);
  if (cnt !== opts.expectedCount) {
    throw new PostingVerificationError(
      `atran ${opts.label ?? 'lines'} count mismatch for ${opts.entryNumber}: got ${cnt}, expected ${opts.expectedCount}`,
      { batchRef: opts.entryNumber, phase: 'in-trx' },
    );
  }
  if (!Number.isFinite(total) || total !== opts.expectedSumPence) {
    throw new PostingVerificationError(
      `atran ${opts.label ?? 'lines'} sum mismatch for ${opts.entryNumber}: got ${total}p, expected ${opts.expectedSumPence}p`,
      { batchRef: opts.entryNumber, phase: 'in-trx' },
    );
  }
}

/**
 * Confirm stran row count and pounds sum for an entry. stran stores
 * receipts as negative values (reducing customer balance), so for a
 * GC batch of N receipts summing to `totalPounds`, the sum here is
 * `-totalPounds` ±0.5p (float tolerance).
 */
export async function assertStranCountAndSum(
  trx: Knex,
  opts: {
    entryNumber: string;
    cbtype: string;
    expectedCount: number;
    expectedSumPounds: number;
  },
): Promise<void> {
  let rows: Array<{ cnt: number | null; total: number | null }>;
  try {
    rows = (await trx.raw(
      `SELECT COUNT(*) AS cnt, SUM(st_trvalue) AS total
       FROM stran WITH (NOLOCK)
       WHERE RTRIM(st_entry) = ?
         AND RTRIM(st_cbtype) = ?`,
      [opts.entryNumber, opts.cbtype],
    )) as unknown as Array<{ cnt: number | null; total: number | null }>;
  } catch (err) {
    throw new PostingVerificationError(
      `stran in-trx verify failed (entry=${opts.entryNumber}): ${isPlainErr(err)}`,
      { batchRef: opts.entryNumber, phase: 'in-trx' },
    );
  }
  const cnt = Number(rows?.[0]?.cnt ?? 0);
  const total = Number(rows?.[0]?.total ?? NaN);
  if (cnt !== opts.expectedCount) {
    throw new PostingVerificationError(
      `stran count mismatch for ${opts.entryNumber}: got ${cnt}, expected ${opts.expectedCount}`,
      { batchRef: opts.entryNumber, phase: 'in-trx' },
    );
  }
  if (!Number.isFinite(total) || Math.abs(total - opts.expectedSumPounds) > 0.005) {
    throw new PostingVerificationError(
      `stran sum mismatch for ${opts.entryNumber}: got ${total}, expected ${opts.expectedSumPounds}`,
      { batchRef: opts.entryNumber, phase: 'in-trx' },
    );
  }
}

/**
 * Confirm a balanced pair (or set of N rows summing to zero) by a
 * shared unique id. Works for ntran (`nt_pstid`) and anoml
 * (`ax_unique`). One call per unique — caller loops if there are
 * multiple uniques to check.
 */
export async function assertBalancedPair(
  trx: Knex,
  opts: {
    table: 'ntran' | 'anoml';
    sharedUnique: string;
    expectedCount: number;
    batchRef: string;
    label?: string;
  },
): Promise<void> {
  const uniqueCol = opts.table === 'ntran' ? 'nt_pstid' : 'ax_unique';
  const valueCol = opts.table === 'ntran' ? 'nt_value' : 'ax_value';
  let rows: Array<{ cnt: number | null; total: number | null }>;
  try {
    rows = (await trx.raw(
      `SELECT COUNT(*) AS cnt, SUM(${valueCol}) AS total
       FROM ${opts.table} WITH (NOLOCK)
       WHERE RTRIM(${uniqueCol}) = ?`,
      [opts.sharedUnique],
    )) as unknown as Array<{ cnt: number | null; total: number | null }>;
  } catch (err) {
    throw new PostingVerificationError(
      `${opts.table} in-trx verify failed (${opts.label ?? 'pair'} unique=${opts.sharedUnique}): ${isPlainErr(err)}`,
      { batchRef: opts.batchRef, phase: 'in-trx' },
    );
  }
  const cnt = Number(rows?.[0]?.cnt ?? 0);
  const total = Number(rows?.[0]?.total ?? NaN);
  if (cnt !== opts.expectedCount) {
    throw new PostingVerificationError(
      `${opts.table} ${opts.label ?? 'pair'} count mismatch (unique=${opts.sharedUnique}): got ${cnt}, expected ${opts.expectedCount}`,
      { batchRef: opts.batchRef, phase: 'in-trx' },
    );
  }
  if (!Number.isFinite(total) || Math.abs(total) > 0.005) {
    throw new PostingVerificationError(
      `${opts.table} ${opts.label ?? 'pair'} does not balance (unique=${opts.sharedUnique}): sum=${total}`,
      { batchRef: opts.batchRef, phase: 'in-trx' },
    );
  }
}

/**
 * Bulk variant — verify a set of balanced pairs (or balanced N-tuples)
 * in a single round-trip. For N payments, instead of N separate
 * `assertBalancedPair` calls we send one SELECT with an IN-list and
 * a GROUP BY, validate per-group count + per-group sum locally.
 *
 * Use when you have many uniques to check (e.g. a 50-payment batch).
 */
export async function assertBalancedPairsBulk(
  trx: Knex,
  opts: {
    table: 'ntran' | 'anoml';
    sharedUniques: ReadonlyArray<string>;
    expectedRowsPerUnique: number;
    batchRef: string;
    label?: string;
  },
): Promise<void> {
  if (opts.sharedUniques.length === 0) return;
  const uniqueCol = opts.table === 'ntran' ? 'nt_pstid' : 'ax_unique';
  const valueCol = opts.table === 'ntran' ? 'nt_value' : 'ax_value';
  const placeholders = opts.sharedUniques.map(() => '?').join(',');
  let rows: Array<{ u: string | null; cnt: number | null; total: number | null }>;
  try {
    rows = (await trx.raw(
      `SELECT RTRIM(${uniqueCol}) AS u, COUNT(*) AS cnt, SUM(${valueCol}) AS total
       FROM ${opts.table} WITH (NOLOCK)
       WHERE RTRIM(${uniqueCol}) IN (${placeholders})
       GROUP BY ${uniqueCol}`,
      [...opts.sharedUniques],
    )) as unknown as Array<{ u: string | null; cnt: number | null; total: number | null }>;
  } catch (err) {
    throw new PostingVerificationError(
      `${opts.table} bulk in-trx verify failed (${opts.label ?? 'pairs'}): ${isPlainErr(err)}`,
      { batchRef: opts.batchRef, phase: 'in-trx' },
    );
  }
  const seen = new Map<string, { cnt: number; total: number }>();
  for (const r of rows ?? []) {
    const key = (r.u ?? '').trim();
    seen.set(key, {
      cnt: Number(r.cnt ?? 0),
      total: Number(r.total ?? NaN),
    });
  }
  for (const u of opts.sharedUniques) {
    const got = seen.get(u);
    if (!got) {
      throw new PostingVerificationError(
        `${opts.table} ${opts.label ?? 'pair'} missing for unique=${u}`,
        { batchRef: opts.batchRef, phase: 'in-trx' },
      );
    }
    if (got.cnt !== opts.expectedRowsPerUnique) {
      throw new PostingVerificationError(
        `${opts.table} ${opts.label ?? 'pair'} count mismatch for unique=${u}: got ${got.cnt}, expected ${opts.expectedRowsPerUnique}`,
        { batchRef: opts.batchRef, phase: 'in-trx' },
      );
    }
    if (!Number.isFinite(got.total) || Math.abs(got.total) > 0.005) {
      throw new PostingVerificationError(
        `${opts.table} ${opts.label ?? 'pair'} does not balance for unique=${u}: sum=${got.total}`,
        { batchRef: opts.batchRef, phase: 'in-trx' },
      );
    }
  }
}

// ---------------------------------------------------------------------
// Phase C — post-commit visibility check
// ---------------------------------------------------------------------

/**
 * After the trx commits, re-read the named aentry header from a
 * fresh pool connection (separate session) to confirm the COMMIT
 * is visible outside our trx. Returns `{ verified, reason? }`.
 *
 * NOLOCK + SET LOCK_TIMEOUT 1000 — belt-and-braces; the read
 * shouldn't acquire locks anyway.
 */
export async function verifyAentryCommitted(
  operaDb: Knex,
  opts: {
    entryNumber: string;
    bankAccount: string;
    expectedValuePence: number;
    label?: string;
  },
): Promise<{ verified: true } | { verified: false; reason: string }> {
  try {
    await operaDb.raw('SET LOCK_TIMEOUT 1000');
    const rows = (await operaDb.raw(
      `SELECT TOP 1 ae_value FROM aentry WITH (NOLOCK)
       WHERE RTRIM(ae_entry) = ?
         AND RTRIM(ae_acnt) = ?`,
      [opts.entryNumber, opts.bankAccount],
    )) as unknown as Array<{ ae_value: number | null }>;
    if (!Array.isArray(rows) || rows.length === 0) {
      return {
        verified: false,
        reason: `${opts.label ?? 'aentry'} not visible from fresh session (entry=${opts.entryNumber}, bank=${opts.bankAccount})`,
      };
    }
    const stored = Number(rows[0]!.ae_value ?? NaN);
    if (!Number.isFinite(stored) || stored !== opts.expectedValuePence) {
      return {
        verified: false,
        reason: `${opts.label ?? 'aentry'}.ae_value mismatch in post-commit read for ${opts.entryNumber}: stored=${stored} expected=${opts.expectedValuePence}`,
      };
    }
    return { verified: true };
  } catch (err) {
    return {
      verified: false,
      reason: `post-commit verify query failed for ${opts.entryNumber}: ${isPlainErr(err)}`,
    };
  }
}
