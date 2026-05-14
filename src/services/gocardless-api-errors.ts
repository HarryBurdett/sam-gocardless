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
export function formatGoCardlessApiError(
  bodyText: string,
  status: number,
  fallbackContext: string = '',
): string {
  const ctx = fallbackContext ? ` (${fallbackContext})` : '';
  if (bodyText) {
    try {
      const parsed = JSON.parse(bodyText) as {
        error?: {
          message?: string;
          type?: string;
          errors?: Array<{ field?: string; message?: string; request_pointer?: string }>;
        };
      };
      const e = parsed.error;
      if (e) {
        const fieldErrs = Array.isArray(e.errors) ? e.errors : [];
        if (fieldErrs.length > 0) {
          const parts = fieldErrs
            .map((fe) => {
              const f = (fe?.field ?? fe?.request_pointer ?? '').trim();
              const m = (fe?.message ?? '').trim();
              if (f && m) return `${f}: ${m}`;
              return m || f || '';
            })
            .filter((s) => s.length > 0);
          if (parts.length > 0) {
            const base = e.message ? `${e.message}: ` : '';
            return `${base}${parts.join('; ')}`;
          }
        }
        if (e.message) return e.message;
        if (e.type) return `GoCardless ${e.type}`;
      }
    } catch {
      // not JSON — fall through to raw-body fallback
    }
  }
  const trimmed = bodyText.slice(0, 200);
  return `GoCardless API returned ${status}${ctx}${trimmed ? `: ${trimmed}` : ''}`;
}
