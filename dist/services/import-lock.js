const STALE_LOCK_MS = 5 * 60 * 1000; // 5 minutes — matches Python default
const locks = new Map();
export const inMemoryImportLock = {
    async acquire(key, locker) {
        const existing = locks.get(key);
        if (existing) {
            const age = Date.now() - existing.acquiredAt;
            if (age < STALE_LOCK_MS)
                return false;
            // Stale — let the new acquirer take over.
        }
        locks.set(key, { locker, acquiredAt: Date.now() });
        return true;
    },
    async release(key) {
        locks.delete(key);
    },
};
//# sourceMappingURL=import-lock.js.map