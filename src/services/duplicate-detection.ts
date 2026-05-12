/**
 * Duplicate-batch detection for GoCardless scan-emails.
 *
 * Faithful port of the four-check duplicate-detection block in
 * `apps/gocardless/api/routes.py:2879-3050`. Runs against Opera's
 * cashbook (atran/aentry) to spot batches that have already been
 * posted by reference, by NET, by GROSS, or by individual payments.
 *
 * Returns flags rather than booleans so the UI can present each
 * warning class separately (the original Python returned three
 * distinct strings).
 */
import type { Knex } from 'knex';

export interface BatchPaymentForDup {
  amount: number;
}

export interface DuplicateInput {
  netAmountPounds: number;
  grossAmountPounds: number;
  goCardlessFeesPounds: number;
  bankReference?: string | null;
  paymentDate?: Date | null;
  payments: BatchPaymentForDup[];
  /** Optional cashbook type filter (e.g. 'BARC'). */
  defaultCbtype?: string | null;
}

export interface DuplicateResult {
  possible_duplicate: boolean;
  duplicate_warning: string | null;
  bank_tx_warning: string | null;
  ref_warning: string | null;
}

interface AtranRow {
  at_value: number | string | null;
  at_pstdate: Date | string | null;
  at_cbtype?: string | null;
  ae_entref?: string | null;
  at_refer?: string | null;
  at_name?: string | null;
}

interface BatchEntryRow {
  at_acnt: string;
  at_cntr: string;
  at_cbtype: string;
  at_entry: string;
  entry_total: number | string;
  entry_date: Date | string | null;
  line_count: number;
}

function formatDateDmy(value: Date | string | null | undefined): string {
  if (!value) return '';
  if (value instanceof Date) {
    const d = value;
    const dd = `${d.getUTCDate()}`.padStart(2, '0');
    const mm = `${d.getUTCMonth() + 1}`.padStart(2, '0');
    return `${dd}/${mm}/${d.getUTCFullYear()}`;
  }
  return String(value).slice(0, 10);
}

function pence(amount: number): number {
  return Math.round(amount * 100);
}

export async function checkDuplicateBatch(
  operaDb: Knex,
  input: DuplicateInput,
): Promise<DuplicateResult> {
  const result: DuplicateResult = {
    possible_duplicate: false,
    duplicate_warning: null,
    bank_tx_warning: null,
    ref_warning: null,
  };

  const netPence = pence(input.netAmountPounds);
  const grossPence = pence(input.grossAmountPounds);
  const bankRef = (input.bankReference ?? '').trim();
  const cbtype = (input.defaultCbtype ?? '').trim();

  // Check 1: by GoCardless reference (most reliable)
  if (bankRef) {
    try {
      const refRow = (await operaDb('aentry')
        .join('atran', function joinAtran(this: Knex.JoinClause) {
          this.on('ae_acnt', '=', 'at_acnt')
            .andOn('ae_cntr', '=', 'at_cntr')
            .andOn('ae_cbtype', '=', 'at_cbtype')
            .andOn('ae_entry', '=', 'at_entry');
        })
        .where('at_type', 4)
        .andWhereRaw('RTRIM(ae_entref) = ?', [bankRef.slice(0, 20)])
        .orderBy('at_pstdate', 'desc')
        .select('ae_entref', 'at_value', 'at_pstdate')
        .first()) as AtranRow | undefined;
      if (refRow) {
        result.possible_duplicate = true;
        result.ref_warning = `Already imported: ref '${bankRef}' on ${formatDateDmy(
          refRow.at_pstdate ?? null,
        )}`;
      }
    } catch {
      // ignore — duplicate detection is advisory
    }
  }

  // Check 2: NET amount in cashbook (only if no ref match)
  if (!result.ref_warning) {
    try {
      let q = operaDb('atran')
        .join('aentry', function joinAentry(this: Knex.JoinClause) {
          this.on('ae_acnt', '=', 'at_acnt')
            .andOn('ae_cntr', '=', 'at_cntr')
            .andOn('ae_cbtype', '=', 'at_cbtype')
            .andOn('ae_entry', '=', 'at_entry');
        })
        .where('at_type', 4)
        .andWhereRaw('ABS(at_value - ?) <= 1', [netPence]);
      if (cbtype) q = q.andWhere('at_cbtype', cbtype);
      const dupRow = (await q
        .orderBy('at_pstdate', 'desc')
        .select('at_value', 'at_pstdate', 'at_cbtype', 'ae_entref')
        .first()) as AtranRow | undefined;
      if (dupRow) {
        result.possible_duplicate = true;
        const ref = (dupRow.ae_entref ?? '').toString().trim() || 'N/A';
        const value = Number(dupRow.at_value ?? 0) / 100;
        result.duplicate_warning = `Cashbook entry found: £${value.toFixed(
          2,
        )} on ${formatDateDmy(dupRow.at_pstdate ?? null)} (ref: ${ref})`;
      }
    } catch {
      // advisory
    }
  }

  // Check 3: GROSS amount in cashbook (within 14 days of payout date)
  if (input.paymentDate) {
    try {
      const payoutDateStr = input.paymentDate.toISOString().slice(0, 10);
      const grossRow = (await operaDb('atran')
        .join('aentry', function joinAentry(this: Knex.JoinClause) {
          this.on('ae_acnt', '=', 'at_acnt')
            .andOn('ae_cntr', '=', 'at_cntr')
            .andOn('ae_cbtype', '=', 'at_cbtype')
            .andOn('ae_entry', '=', 'at_entry');
        })
        .whereIn('at_type', [1, 4, 6])
        .andWhere('at_value', '>', 0)
        .andWhereRaw('ABS(at_value - ?) <= 1', [grossPence])
        .andWhereRaw('ABS(DATEDIFF(day, at_pstdate, ?)) <= 14', [payoutDateStr])
        .orderBy('at_pstdate', 'desc')
        .select('at_value', 'at_pstdate', 'at_cbtype', 'ae_entref', 'at_refer')
        .first()) as AtranRow | undefined;
      if (grossRow) {
        const dateStr = formatDateDmy(grossRow.at_pstdate ?? null);
        const existingRef =
          (grossRow.ae_entref ?? '').toString().trim() ||
          (grossRow.at_refer ?? '').toString().trim() ||
          'N/A';
        const value = Number(grossRow.at_value ?? 0) / 100;
        if (
          bankRef &&
          existingRef
            .toUpperCase()
            .startsWith(bankRef.slice(0, 10).toUpperCase())
        ) {
          result.bank_tx_warning = `Already posted - gross amount: £${value.toFixed(
            2,
          )} on ${dateStr} (ref: ${existingRef})`;
          result.possible_duplicate = true;
        } else {
          result.bank_tx_warning = `Similar amount found: £${value.toFixed(
            2,
          )} on ${dateStr} (ref: ${existingRef}) - verify before importing`;
        }
      }
    } catch {
      // advisory
    }
  }

  // Check 3b: batched entries totalling gross with matching individual payments
  if (
    !result.ref_warning &&
    !result.bank_tx_warning &&
    input.payments.length > 1
  ) {
    try {
      const rows = (await operaDb('atran')
        .whereIn('at_type', [1, 4, 6])
        .andWhere('at_value', '>', 0)
        .groupBy('at_acnt', 'at_cntr', 'at_cbtype', 'at_entry')
        .havingRaw('ABS(SUM(at_value) - ?) <= 10', [grossPence])
        .havingRaw('COUNT(*) >= ?', [input.payments.length])
        .orderByRaw('MIN(at_pstdate) DESC')
        .select(
          'at_acnt',
          'at_cntr',
          'at_cbtype',
          'at_entry',
          operaDb.raw('SUM(at_value) as entry_total'),
          operaDb.raw('MIN(at_pstdate) as entry_date'),
          operaDb.raw('COUNT(*) as line_count'),
        )) as BatchEntryRow[];
      const sortedGcAmounts: number[] = input.payments
        .map((p) => pence(p.amount))
        .sort((a, b) => a - b);
      for (const entry of rows) {
        const lines = (await operaDb('atran')
          .where({
            at_acnt: (entry.at_acnt ?? '').trim(),
            at_cntr: (entry.at_cntr ?? '').trim(),
            at_cbtype: (entry.at_cbtype ?? '').trim(),
            at_entry: (entry.at_entry ?? '').trim(),
          })
          .whereIn('at_type', [1, 4, 6])
          .andWhere('at_value', '>', 0)
          .select('at_value', 'at_name')) as AtranRow[];
        if (lines.length === 0) continue;
        const entryAmounts = lines
          .map((l) => Number(l.at_value ?? 0))
          .sort((a, b) => a - b);
        if (entryAmounts.length !== sortedGcAmounts.length) continue;
        const allMatch = entryAmounts.every(
          (v, i) => Math.abs(v - (sortedGcAmounts[i] ?? 0)) <= 1,
        );
        if (allMatch) {
          const total = Number(entry.entry_total ?? 0) / 100;
          const dateStr = formatDateDmy(entry.entry_date);
          result.bank_tx_warning = `Already posted - batch: ${entryAmounts.length} payments totaling £${total.toFixed(
            2,
          )} on ${dateStr}`;
          result.possible_duplicate = true;
          break;
        }
      }
    } catch {
      // advisory
    }
  }

  // Check 3c: individual payment amounts with GC reference
  if (!result.bank_tx_warning && input.payments.length > 0) {
    try {
      for (const payment of input.payments.slice(0, 5)) {
        const paymentPence = pence(payment.amount);
        const row = (await operaDb('atran')
          .whereIn('at_type', [1, 4])
          .andWhere('at_value', '>', 0)
          .andWhereRaw('ABS(at_value - ?) <= 1', [paymentPence])
          .andWhere(function gcRefFilter(this: Knex.QueryBuilder) {
            this.where('at_refer', 'like', '%GC%').orWhere(
              'at_refer',
              'like',
              '%GoCardless%',
            );
          })
          .orderBy('at_pstdate', 'desc')
          .select('at_value', 'at_pstdate', 'at_name', 'at_refer')
          .first()) as AtranRow | undefined;
        if (row) {
          const value = Number(row.at_value ?? 0) / 100;
          const dateStr = formatDateDmy(row.at_pstdate ?? null);
          const name = (row.at_name ?? '').toString().trim().slice(0, 20);
          result.bank_tx_warning = `Already posted - payment: £${value.toFixed(
            2,
          )} (${name}) on ${dateStr} with GC ref`;
          result.possible_duplicate = true;
          break;
        }
      }
    } catch {
      // advisory
    }
  }

  // Check 4: fees amount in cashbook
  const feesPence = pence(Math.abs(input.goCardlessFeesPounds));
  if (feesPence > 0) {
    try {
      const feesRow = (await operaDb('atran')
        .join('aentry', function joinAentry(this: Knex.JoinClause) {
          this.on('ae_acnt', '=', 'at_acnt')
            .andOn('ae_cntr', '=', 'at_cntr')
            .andOn('ae_cbtype', '=', 'at_cbtype')
            .andOn('ae_entry', '=', 'at_entry');
        })
        .whereIn('at_type', [2, 4])
        .andWhereRaw('ABS(ABS(at_value) - ?) <= 1', [feesPence])
        .orderBy('at_pstdate', 'desc')
        .select('at_value', 'at_pstdate', 'at_cbtype', 'ae_entref')
        .first()) as AtranRow | undefined;
      if (feesRow) {
        const value = Math.abs(Number(feesRow.at_value ?? 0)) / 100;
        const dateStr = formatDateDmy(feesRow.at_pstdate ?? null);
        const ref = (feesRow.ae_entref ?? '').toString().trim() || 'N/A';
        if (!result.bank_tx_warning) {
          result.bank_tx_warning = `Already posted - fees: £${value.toFixed(
            2,
          )} on ${dateStr} (ref: ${ref})`;
        } else {
          result.bank_tx_warning += ` | Fees also posted: £${value.toFixed(
            2,
          )} on ${dateStr}`;
        }
        result.possible_duplicate = true;
      }
    } catch {
      // advisory
    }
  }

  return result;
}
