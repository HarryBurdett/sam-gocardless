/**
 * Translate raw pyodbc / MSSQL / network error strings into operator-
 * friendly text. Faithful port of `friendly_db_error()` (legacy Python
 * helper used throughout apps/gocardless/api/routes.py — commit
 * ad2a534). Server-side wrapping so raw stack strings never leave
 * the API.
 *
 * Idempotent: if no pattern matches, the original message comes back
 * unchanged. Always returns a non-empty string.
 */
export declare function friendlyDbError(raw: unknown): string;
//# sourceMappingURL=friendly-db-error.d.ts.map