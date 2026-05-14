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
export declare class PostingVerificationError extends Error {
    readonly batchRef: string | null;
    readonly phase: 'in-trx' | 'post-commit';
    constructor(message: string, opts: {
        batchRef: string | null;
        phase: 'in-trx' | 'post-commit';
    });
}
/**
 * Confirm a single aentry header row exists with the expected
 * signed pence. Identified by (ae_entry, ae_acnt).
 */
export declare function assertAentryHeader(trx: Knex, opts: {
    entryNumber: string;
    bankAccount: string;
    expectedValuePence: number;
    label?: string;
}): Promise<void>;
/**
 * Confirm atran row count and signed pence sum for an entry under
 * a given bank account. Used to verify the N customer lines under
 * the batch aentry, AND the 1-2 fees lines under the fees aentry,
 * AND the single line under each transfer-leg aentry.
 */
export declare function assertAtranCountAndSum(trx: Knex, opts: {
    entryNumber: string;
    bankAccount: string;
    expectedCount: number;
    expectedSumPence: number;
    label?: string;
}): Promise<void>;
/**
 * Confirm stran row count and pounds sum for an entry. stran stores
 * receipts as negative values (reducing customer balance), so for a
 * GC batch of N receipts summing to `totalPounds`, the sum here is
 * `-totalPounds` ±0.5p (float tolerance).
 */
export declare function assertStranCountAndSum(trx: Knex, opts: {
    entryNumber: string;
    cbtype: string;
    expectedCount: number;
    expectedSumPounds: number;
}): Promise<void>;
/**
 * Confirm a balanced pair (or set of N rows summing to zero) by a
 * shared unique id. Works for ntran (`nt_pstid`) and anoml
 * (`ax_unique`). One call per unique — caller loops if there are
 * multiple uniques to check.
 */
export declare function assertBalancedPair(trx: Knex, opts: {
    table: 'ntran' | 'anoml';
    sharedUnique: string;
    expectedCount: number;
    batchRef: string;
    label?: string;
}): Promise<void>;
/**
 * Bulk variant — verify a set of balanced pairs (or balanced N-tuples)
 * in a single round-trip. For N payments, instead of N separate
 * `assertBalancedPair` calls we send one SELECT with an IN-list and
 * a GROUP BY, validate per-group count + per-group sum locally.
 *
 * Use when you have many uniques to check (e.g. a 50-payment batch).
 */
export declare function assertBalancedPairsBulk(trx: Knex, opts: {
    table: 'ntran' | 'anoml';
    sharedUniques: ReadonlyArray<string>;
    expectedRowsPerUnique: number;
    batchRef: string;
    label?: string;
}): Promise<void>;
/**
 * After the trx commits, re-read the named aentry header from a
 * fresh pool connection (separate session) to confirm the COMMIT
 * is visible outside our trx. Returns `{ verified, reason? }`.
 *
 * NOLOCK + SET LOCK_TIMEOUT 1000 — belt-and-braces; the read
 * shouldn't acquire locks anyway.
 */
export declare function verifyAentryCommitted(operaDb: Knex, opts: {
    entryNumber: string;
    bankAccount: string;
    expectedValuePence: number;
    label?: string;
}): Promise<{
    verified: true;
} | {
    verified: false;
    reason: string;
}>;
//# sourceMappingURL=post-write-verify.d.ts.map