/**
 * GoCardless unposted-payments check.
 *
 * Faithful port of get_unposted_gocardless_payments
 * (apps/gocardless/api/routes.py:6283-6401). Used by the dashboard
 * to warn the operator before they request new payments — surfaces
 * any GoCardless payment_requests whose money has been collected
 * (status='confirmed' or 'paid_out') but the receipt hasn't been
 * posted to Opera yet.
 *
 * Three "already posted" checks per payment, in order:
 *   1. Has the payout been imported? (callback — depends on the
 *      email_storage layer SAM provides)
 *   2. Are the invoice_refs fully paid in Opera? (stran.st_trbal
 *      ≈ 0 for any of the first 3 invoice refs)
 *   3. Is there a matching cashbook receipt? (aentry/atran with
 *      at_type=4, at_inputby='GOCARDLS', amount within 1p,
 *      ae_comment contains opera_account)
 *
 * On any check matching, the local payment_request row is updated
 * to status='posted' (best-effort — failures swallowed).
 */
import type { Knex } from 'knex';

export interface UnpostedPayment {
  id: number | string | null;
  opera_account: string | null;
  customer_name: string;
  amount: number;
  status: string;
  charge_date: string | null;
  invoice_refs: string | string[] | null;
}

export interface UnpostedPaymentsResponse {
  success: boolean;
  has_unposted: boolean;
  unposted_count: number;
  unposted_total: number;
  unprocessed_batches: number;
  unposted: UnpostedPayment[];
  error?: string;
}

export interface PaymentRequestRow {
  id: number;
  status: string | null;
  payout_id: string | null;
  invoice_refs: string | null;
  opera_account: string | null;
  amount_pence: number | string | null;
  charge_date: string | null;
}

export interface UnpostedOptions {
  /**
   * Optional check that returns true when the payout's already been
   * imported. Mirrors Python's `email_storage.is_gocardless_payout_imported`.
   */
  isPayoutImported?: (payoutId: string) => Promise<boolean>;
  /**
   * Optional getter for unprocessed payout email count
   * (Python's `email_storage.get_gocardless_imports`). Returns the
   * number of payout emails that haven't been imported yet.
   */
  getUnprocessedBatchCount?: () => Promise<number>;
  /**
   * Customer-name lookup for response enrichment. The local
   * payment_requests table doesn't carry the name, so callers can
   * inject a map keyed by opera_account.
   */
  customerNamesByAccount?: Map<string, string>;
}

const COLLECTED_STATUSES = new Set(['confirmed', 'paid_out']);

function trim(s: string | null | undefined): string {
  return (s ?? '').trim();
}

function parseInvoiceRefs(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((v) => trim(String(v)));
  if (typeof value === 'string' && value) {
    try {
      const parsed = JSON.parse(value);
      if (Array.isArray(parsed)) return parsed.map((v) => trim(String(v)));
    } catch {
      // fall through
    }
    return [trim(value)];
  }
  return [];
}

async function isInvoiceFullyPaid(
  operaDb: Knex,
  invoiceRefs: string[],
): Promise<boolean> {
  // Check first 3 refs only (matches Python's `refs[:3]`)
  const slice = invoiceRefs.slice(0, 3).filter(Boolean);
  for (const ref of slice) {
    try {
      const row = await operaDb('stran')
        .where({ st_trref: ref, st_trtype: 'I' })
        .andWhereRaw('ABS(st_trbal) < 0.01')
        .first<{ st_trbal: number | string | null }>();
      if (row) return true;
    } catch {
      // best-effort
    }
  }
  return false;
}

async function hasMatchingCashbookReceipt(
  operaDb: Knex,
  account: string,
  amountPence: number,
): Promise<boolean> {
  try {
    const row = await operaDb('aentry')
      .innerJoin('atran', function () {
        this.on('ae_acnt', '=', 'at_acnt')
          .andOn('ae_cntr', '=', 'at_cntr')
          .andOn('ae_cbtype', '=', 'at_cbtype')
          .andOn('ae_entry', '=', 'at_entry');
      })
      .where({ at_type: 4, at_inputby: 'GOCARDLS' })
      .andWhereRaw('RTRIM(ae_comment) LIKE ?', [`%${account}%`])
      .andWhereRaw('ABS(ae_value - ?) <= 1', [amountPence])
      .first<{ ae_entry: string | null }>();
    return !!row;
  } catch {
    return false;
  }
}

async function markPosted(
  appDb: Knex,
  requestId: number,
): Promise<void> {
  try {
    await appDb('gocardless_payment_requests')
      .where({ id: requestId })
      .update({ status: 'posted', updated_at: appDb.fn.now() });
  } catch {
    // best-effort — Python ignores failures here
  }
}

export async function getUnpostedPayments(
  operaDb: Knex,
  appDb: Knex,
  opts: UnpostedOptions = {},
): Promise<UnpostedPaymentsResponse> {
  try {
    const requests = (await appDb('gocardless_payment_requests')
      .orderBy('id', 'desc')
      .limit(10000)) as unknown as PaymentRequestRow[];

    const unposted: UnpostedPayment[] = [];
    let totalAmount = 0;

    for (const req of requests ?? []) {
      const status = trim(req.status);
      if (!COLLECTED_STATUSES.has(status)) continue;

      let alreadyPosted = false;

      // Check 1: payout already imported
      const payoutId = trim(req.payout_id);
      if (!alreadyPosted && payoutId && opts.isPayoutImported) {
        try {
          if (await opts.isPayoutImported(payoutId)) {
            alreadyPosted = true;
            await markPosted(appDb, req.id);
          }
        } catch {
          // best-effort
        }
      }

      // Check 2: invoice fully paid in Opera
      const invoiceRefs = parseInvoiceRefs(req.invoice_refs);
      if (!alreadyPosted && invoiceRefs.length > 0) {
        if (await isInvoiceFullyPaid(operaDb, invoiceRefs)) {
          alreadyPosted = true;
          await markPosted(appDb, req.id);
        }
      }

      // Check 3: matching cashbook receipt
      const account = trim(req.opera_account);
      const amountPence = Math.round(Number(req.amount_pence ?? 0));
      if (!alreadyPosted && account && Number.isFinite(amountPence) && amountPence > 0) {
        if (await hasMatchingCashbookReceipt(operaDb, account, amountPence)) {
          alreadyPosted = true;
          await markPosted(appDb, req.id);
        }
      }

      if (!alreadyPosted) {
        const amount = amountPence / 100;
        const customerName = opts.customerNamesByAccount?.get(account) ?? '';
        unposted.push({
          id: req.id,
          opera_account: account || null,
          customer_name: customerName,
          amount,
          status,
          charge_date: req.charge_date ?? null,
          invoice_refs: req.invoice_refs ?? null,
        });
        totalAmount += amount;
      }
    }

    let unprocessedBatches = 0;
    if (opts.getUnprocessedBatchCount) {
      try {
        unprocessedBatches = await opts.getUnprocessedBatchCount();
      } catch {
        // best-effort
      }
    }

    return {
      success: true,
      has_unposted: unposted.length > 0 || unprocessedBatches > 0,
      unposted_count: unposted.length,
      unposted_total: Math.round(totalAmount * 100) / 100,
      unprocessed_batches: unprocessedBatches,
      unposted,
    };
  } catch (err: any) {
    // Python wraps ALL failures in a soft success. Mirror that behaviour
    // so the dashboard renders even when the underlying read fails.
    return {
      success: true,
      has_unposted: false,
      unposted_count: 0,
      unposted_total: 0,
      unprocessed_batches: 0,
      unposted: [],
      error: err?.message ?? String(err),
    };
  }
}
