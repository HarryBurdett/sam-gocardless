/**
 * In-memory bank-level import lock.
 *
 * Faithful port of `acquire_import_lock` / `release_import_lock`
 * (sql_rag/import_lock.py). Per-process Map keyed by lock-name, with
 * a stale-lock timeout so a crashed importer doesn't lock a bank
 * permanently.
 *
 * Single-tenant per-process semantics — adequate for the SAM plugin
 * runtime (one Node worker per tenant). For multi-worker setups the
 * SAM team would substitute a Redis-backed adapter; the route
 * already accepts any `ImportLockAdapter` so swap is non-invasive.
 */
import type { ImportLockAdapter } from './import-batch.js';
export declare const inMemoryImportLock: ImportLockAdapter;
//# sourceMappingURL=import-lock.d.ts.map