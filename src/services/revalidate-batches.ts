/**
 * Revalidate existing GoCardless batches against Opera.
 *
 * Faithful port of `revalidate_gocardless_batches` in
 * `apps/gocardless/api/routes.py:2530-2702`. Used after the operator
 * changes Opera parameters (opens a period, etc.) — refreshes
 * `period_valid` and `possible_duplicate` for previously-seen batches
 * without re-fetching from the GoCardless API.
 *
 * Per batch:
 *   - Parse `payment_date` (first 10 chars, YYYY-MM-DD)
 *   - Detect foreign currency (currency vs Opera home currency)
 *   - validatePostingPeriod(payment_date, 'SL')
 *   - Duplicate scan against Opera atran/aentry:
 *       Foreign currency → reference-only (last segment after '-')
 *       GBP             → reference + amount (1.00 tolerance), THEN
 *                         amount alone within 14 days
 *
 * Returns the batches with revalidation fields merged in. Original
 * fields preserved (like Python's `**batch` spread).
 */
import type { Knex } from 'knex';
import {
  validatePostingPeriod,
  getCurrentPeriodInfo,
  getHomeCurrency,
  type PeriodInfo,
} from '../_shared/index.js';

export interface BatchInput {
  batch?: {
    gross_amount?: number;
    net_amount?: number;
    bank_reference?: string;
    payment_date?: string; // ISO date, may include time suffix
    currency?: string;
  };
  // Original fields preserved through the pipeline
  [key: string]: unknown;
}

export interface RevalidatedBatch extends BatchInput {
  period_valid: boolean;
  period_error: string | null;
  possible_duplicate: boolean;
  bank_tx_warning: string | null;
  is_foreign_currency: boolean;
  home_currency: string;
}

export interface RevalidateBatchesResult {
  success: boolean;
  batches: RevalidatedBatch[];
  current_period: { year: number | null; period: number | null } | null;
  message?: string;
  error?: string;
}

function parsePaymentDate(input: string | undefined): string | null {
  if (!input || typeof input !== 'string') return null;
  const trimmed = input.slice(0, 10);
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return trimmed;
  return null;
}

function refSuffix(bankReference: string): string {
  if (bankReference.includes('-')) {
    const parts = bankReference.split('-');
    return parts[parts.length - 1] ?? '';
  }
  return bankReference.slice(-8);
}

function formatGbp(pence: number): string {
  return (Math.abs(Math.trunc(pence)) / 100).toFixed(2);
}

function formatDate(d: Date | string | null): string {
  if (d instanceof Date) {
    const dd = String(d.getUTCDate()).padStart(2, '0');
    const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
    const yyyy = d.getUTCFullYear();
    return `${dd}/${mm}/${yyyy}`;
  }
  if (typeof d === 'string') return d.slice(0, 10);
  return '';
}

interface DupRow {
  ae_entref?: string | null;
  at_value?: number | null;
  at_date?: Date | string | null;
}

export async function revalidateBatches(
  operaDb: Knex,
  batches: BatchInput[],
): Promise<RevalidateBatchesResult> {
  try {
    const currentPeriodInfo: PeriodInfo = await getCurrentPeriodInfo(operaDb);
    const homeCurrency = await getHomeCurrency(operaDb);

    const out: RevalidatedBatch[] = [];

    for (const batch of batches) {
      const data = batch.batch ?? {};
      const grossAmount = Number(data.gross_amount ?? 0);
      const bankReference = String(data.bank_reference ?? '');
      const paymentDate = parsePaymentDate(data.payment_date);
      const currency = String(data.currency ?? 'GBP');
      const isForeign = currency.toUpperCase() !== homeCurrency.code.toUpperCase();

      // Period validation
      let periodValid = true;
      let periodError: string | null = null;
      if (paymentDate) {
        try {
          const result = await validatePostingPeriod(operaDb, paymentDate, 'SL');
          periodValid = result.is_valid;
          if (!periodValid) periodError = result.error_message ?? null;
        } catch (e: any) {
          // Period validation failures shouldn't fail the whole revalidation
          periodValid = true;
          periodError = null;
        }
      }

      // Duplicate detection
      let possibleDuplicate = false;
      let bankWarning: string | null = null;

      try {
        const grossPence = Math.round(grossAmount * 100);

        if (isForeign) {
          // Foreign currency — reference-only check (no amount comparison
          // because amount fields are GBP equivalents)
          if (bankReference) {
            const suffix = refSuffix(bankReference);
            const rows = (await operaDb.raw(
              `SELECT TOP 1 ae_entref, at_value, at_pstdate as at_date
               FROM aentry WITH (NOLOCK)
               JOIN atran WITH (NOLOCK) ON ae_acnt = at_acnt AND ae_cntr = at_cntr
                 AND ae_cbtype = at_cbtype AND ae_entry = at_entry
               WHERE at_type IN (1, 4, 6)
                 AND at_value > 0
                 AND RTRIM(ae_entref) LIKE ?
               ORDER BY at_pstdate DESC`,
              [`%${suffix}%`],
            )) as unknown as DupRow[];
            if (Array.isArray(rows) && rows.length > 0 && rows[0]) {
              possibleDuplicate = true;
              bankWarning =
                `Already posted - ref '${suffix}' found: £${formatGbp(Number(rows[0].at_value ?? 0))}` +
                ` on ${formatDate(rows[0].at_date ?? null)} (note: foreign currency, GBP equivalent)`;
            }
          }
        } else {
          // GBP — reference + amount (within £1.00 = 100p)
          if (bankReference) {
            const suffix = refSuffix(bankReference);
            const rows = (await operaDb.raw(
              `SELECT TOP 1 ae_entref, at_value, at_pstdate as at_date
               FROM aentry WITH (NOLOCK)
               JOIN atran WITH (NOLOCK) ON ae_acnt = at_acnt AND ae_cntr = at_cntr
                 AND ae_cbtype = at_cbtype AND ae_entry = at_entry
               WHERE at_type IN (1, 4, 6)
                 AND RTRIM(ae_entref) LIKE ?
                 AND ABS(at_value - ?) <= 100
               ORDER BY at_pstdate DESC`,
              [`%${suffix}%`, grossPence],
            )) as unknown as DupRow[];
            if (Array.isArray(rows) && rows.length > 0 && rows[0]) {
              possibleDuplicate = true;
              bankWarning =
                `Already posted - ref '${suffix}': £${formatGbp(Number(rows[0].at_value ?? 0))}` +
                ` on ${formatDate(rows[0].at_date ?? null)}`;
            }
          }

          // Fallback: amount alone within 14 days, 1p tolerance
          if (!possibleDuplicate && grossPence > 0 && paymentDate) {
            const rows = (await operaDb.raw(
              `SELECT TOP 1 at_value, at_pstdate as at_date, ae_entref
               FROM atran WITH (NOLOCK)
               JOIN aentry WITH (NOLOCK) ON ae_acnt = at_acnt AND ae_cntr = at_cntr
                 AND ae_cbtype = at_cbtype AND ae_entry = at_entry
               WHERE at_type IN (1, 4, 6)
                 AND at_value > 0
                 AND ABS(at_value - ?) <= 1
                 AND ABS(DATEDIFF(day, at_pstdate, ?)) <= 14
               ORDER BY at_pstdate DESC`,
              [grossPence, paymentDate],
            )) as unknown as DupRow[];
            if (Array.isArray(rows) && rows.length > 0 && rows[0]) {
              possibleDuplicate = true;
              const ref = (rows[0].ae_entref ?? '').toString().trim() || 'N/A';
              bankWarning =
                `Already posted - gross amount: £${formatGbp(Number(rows[0].at_value ?? 0))}` +
                ` on ${formatDate(rows[0].at_date ?? null)} (ref: ${ref})`;
            }
          }
        }
      } catch {
        // Duplicate check is best-effort
      }

      out.push({
        ...batch,
        period_valid: periodValid,
        period_error: periodError,
        possible_duplicate: possibleDuplicate,
        bank_tx_warning: bankWarning,
        is_foreign_currency: isForeign,
        home_currency: homeCurrency.code,
      });
    }

    return {
      success: true,
      batches: out,
      current_period: {
        year: currentPeriodInfo.np_year,
        period: currentPeriodInfo.np_perno,
      },
      message: `Revalidated ${out.length} batch(es) against Opera`,
    };
  } catch (err: any) {
    return {
      success: false,
      batches: [],
      current_period: null,
      error: err?.message ?? String(err),
    };
  }
}
