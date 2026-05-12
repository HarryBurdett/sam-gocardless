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

interface LockEntry {
  locker: string;
  acquiredAt: number;
}

const STALE_LOCK_MS = 5 * 60 * 1000; // 5 minutes — matches Python default

const locks = new Map<string, LockEntry>();

export const inMemoryImportLock: ImportLockAdapter = {
  async acquire(key: string, locker: string): Promise<boolean> {
    const existing = locks.get(key);
    if (existing) {
      const age = Date.now() - existing.acquiredAt;
      if (age < STALE_LOCK_MS) return false;
      // Stale — let the new acquirer take over.
    }
    locks.set(key, { locker, acquiredAt: Date.now() });
    return true;
  },
  async release(key: string): Promise<void> {
    locks.delete(key);
  },
};
