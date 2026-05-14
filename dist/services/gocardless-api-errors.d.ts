/**
 * Parse a GoCardless API non-2xx body into an operator-friendly
 * message. Faithful port of legacy 9068085 — extracts the per-field
 * error entries GoCardless returns so support sees exactly which
 * field failed instead of a raw JSON dump.
 *
 * GoCardless 4xx/5xx body shape:
 *
 *   {
 *     "error": {
 *       "message": "Validation failed",
 *       "type": "validation_failed",
 *       "documentation_url": "...",
 *       "errors": [
 *         { "field": "charge_date", "message": "must be on or after ..." },
 *         { "field": "amount",      "message": "must be greater than 0" }
 *       ]
 *     }
 *   }
 *
 * Caller has already done `await res.text()` so the call site keeps
 * its existing `text` variable — easier drop-in than a Response-
 * based helper. Returns a single human-readable string. Never
 * throws.
 */
export declare function formatGoCardlessApiError(bodyText: string, status: number, fallbackContext?: string): string;
//# sourceMappingURL=gocardless-api-errors.d.ts.map