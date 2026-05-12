/**
 * GoCardless request-payment service.
 *
 * Faithful port of:
 *   - request_gocardless_payment (apps/gocardless/api/routes.py:8249-8435)
 *   - request_bulk_payments      (apps/gocardless/api/routes.py:8438-8486)
 *
 * Orchestrates: duplicate-invoice guard, mandate lookup, optional
 * Opera invoice-total summing (st_trbal), unallocated-credit safety
 * check, GoCardless POST /payments, then persist a row in
 * `gocardless_payment_requests`.
 *
 * The Opera read + remote create are injected so this module stays
 * unit-testable. Mirrors the existing pattern used by sync-from-opera.
 */
import type { Knex } from 'knex';

export interface MandateRecord {
  mandate_id: string;
  opera_account: string;
  opera_name: string | null;
}

export interface OperaSnapshot {
  /**
   * Sum of `st_trbal` across the requested invoices, in pounds. Null when
   * the invoices could not be located in stran.
   */
  invoiceTotalPounds: number | null;
  /**
   * Sum of unallocated credit on the customer's account
   * (`SUM(st_trbal) WHERE st_trbal < 0`), in pounds (positive number).
   * 0 when none.
   */
  unallocatedCreditPounds: number;
}

export interface RemoteCreatePaymentResult {
  success: boolean;
  payment?: {
    id?: string;
    status?: string;
    charge_date?: string;
    [k: string]: unknown;
  };
  error?: string;
}

export interface RequestPaymentInput {
  operaAccount: string;
  invoices: string[];
  /** When omitted, the Opera invoice total is used. */
  amountPence?: number | null;
  /** ISO date YYYY-MM-DD. Past dates are dropped (per Python). */
  chargeDate?: string | null;
  description?: string | null;
}

export interface RequestPaymentSettings {
  /** Truncated to 10 chars. Prefixed onto descriptions for bank visibility. */
  request_statement_reference?: string | null;
}

export interface RequestPaymentResponse {
  success: boolean;
  message?: string;
  payment_request?: Record<string, unknown> & {
    customer_name?: string;
    estimated_arrival?: string | null;
  };
  error?: string;
}

function trim(s: string | null | undefined): string {
  return (s ?? '').trim();
}

function normaliseChargeDate(
  raw: string | null | undefined,
  today = new Date(),
): string | null {
  if (!raw) return null;
  const m = /^\d{4}-\d{2}-\d{2}$/.exec(raw);
  if (!m) return raw; // malformed input — pass through unchanged
  const d = new Date(`${raw}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return raw;
  const todayUtc = new Date(
    Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()),
  );
  return d < todayUtc ? null : raw;
}

function buildDescription(
  description: string | null | undefined,
  invoices: string[],
  stmtRefRaw: string | null | undefined,
): string {
  const stmtRef = trim(stmtRefRaw).slice(0, 10);
  const desc = trim(description);
  if (!desc) {
    const invPart =
      invoices.length === 1
        ? invoices[0]!
        : `${invoices[0] ?? ''} +${invoices.length - 1}`;
    return stmtRef ? `${stmtRef} ${invPart}` : invPart;
  }
  if (stmtRef && !desc.startsWith(stmtRef)) {
    return `${stmtRef} ${desc}`;
  }
  return desc;
}

function parseInvoiceRefs(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String);
  if (typeof value === 'string' && value) {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed.map(String) : [];
    } catch {
      return [];
    }
  }
  return [];
}

function formatPounds(pounds: number): string {
  return pounds.toLocaleString('en-GB', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

async function findActiveMandate(
  appDb: Knex,
  operaAccount: string,
): Promise<MandateRecord | null> {
  const row = (await appDb('gocardless_mandates')
    .where({ opera_account: operaAccount, mandate_status: 'active' })
    .orderBy('created_at', 'desc')
    .first()) as unknown as
    | {
        mandate_id: string | null;
        opera_account: string | null;
        opera_name: string | null;
      }
    | undefined;
  if (!row || !row.mandate_id) return null;
  return {
    mandate_id: row.mandate_id,
    opera_account: row.opera_account ?? operaAccount,
    opera_name: row.opera_name ?? null,
  };
}

async function findDuplicateInvoiceClash(
  appDb: Knex,
  operaAccount: string,
  invoices: string[],
): Promise<{ status: string; refs: string[] } | null> {
  if (invoices.length === 0) return null;
  const rows = (await appDb('gocardless_payment_requests')
    .where({ opera_account: operaAccount })
    .select('status', 'invoice_refs')) as unknown as Array<{
    status: string | null;
    invoice_refs: string | null;
  }>;
  const requested = new Set(invoices);
  for (const r of rows ?? []) {
    const status = trim(r.status);
    if (status === 'cancelled' || status === 'failed' || status === 'charged_back') continue;
    const refs = parseInvoiceRefs(r.invoice_refs);
    const overlap = refs.filter((ref) => requested.has(ref));
    if (overlap.length > 0) {
      return { status, refs: overlap };
    }
  }
  return null;
}

async function persistPaymentRequest(
  appDb: Knex,
  row: {
    mandate_id: string;
    opera_account: string;
    amount_pence: number;
    invoice_refs: string[];
    payment_id: string | null;
    charge_date: string | null;
    description: string | null;
    status: string;
    currency: string;
  },
): Promise<Record<string, unknown>> {
  const ids = (await appDb('gocardless_payment_requests')
    .insert({
      mandate_id: row.mandate_id,
      opera_account: row.opera_account,
      amount_pence: row.amount_pence,
      invoice_refs: JSON.stringify(row.invoice_refs),
      payment_id: row.payment_id,
      charge_date: row.charge_date,
      description: row.description,
      status: row.status,
      currency: row.currency,
    })
    .returning('id')) as unknown as Array<{ id: number } | number>;
  // Knex returning shape varies by driver
  const inserted = Array.isArray(ids) && ids.length > 0 ? ids[0] : null;
  const newId =
    typeof inserted === 'number'
      ? inserted
      : typeof (inserted as any)?.id === 'number'
        ? (inserted as any).id
        : null;
  const persisted = (await appDb('gocardless_payment_requests')
    .where(newId ? { id: newId } : { payment_id: row.payment_id ?? '' })
    .first()) as Record<string, unknown> | undefined;
  return persisted ?? {};
}

export async function requestPayment(
  appDb: Knex,
  input: RequestPaymentInput,
  settings: RequestPaymentSettings,
  readOpera: (
    operaAccount: string,
    invoices: string[],
  ) => Promise<OperaSnapshot>,
  createRemote: (input: {
    amountPence: number;
    mandateId: string;
    description: string;
    chargeDate: string | null;
    metadata: Record<string, string>;
  }) => Promise<RemoteCreatePaymentResult>,
  today: Date = new Date(),
): Promise<RequestPaymentResponse> {
  const operaAccount = trim(input.operaAccount);
  const invoices = (input.invoices ?? [])
    .map((s) => trim(String(s)))
    .filter(Boolean);
  if (!operaAccount) {
    return { success: false, error: 'opera_account is required' };
  }

  // 1. Duplicate-invoice guard
  if (invoices.length > 0) {
    try {
      const clash = await findDuplicateInvoiceClash(appDb, operaAccount, invoices);
      if (clash) {
        return {
          success: false,
          error:
            `Payment already requested for invoice(s): ${clash.refs.join(', ')}. ` +
            `Existing request status: ${clash.status}. ` +
            `Cancel the existing request first to avoid duplicate collection.`,
        };
      }
    } catch {
      // Mirrors Python's "log + continue" — duplicate check failures
      // shouldn't block the operator. The remote API will still
      // surface conflicts via its own response.
    }
  }

  // 2. Mandate lookup
  const mandate = await findActiveMandate(appDb, operaAccount);
  if (!mandate) {
    return {
      success: false,
      error: `No active mandate found for customer ${operaAccount}. Please set up a mandate first.`,
    };
  }

  // 3. Opera read — invoice total + unallocated-credit safety check
  let opera: OperaSnapshot;
  try {
    opera = await readOpera(operaAccount, invoices);
  } catch (err: any) {
    return { success: false, error: err?.message ?? String(err) };
  }

  // 4. Resolve amount
  let amountPence = input.amountPence ?? null;
  if (amountPence === null || amountPence === undefined) {
    if (opera.invoiceTotalPounds === null) {
      return { success: false, error: 'Could not find specified invoices' };
    }
    amountPence = Math.round(opera.invoiceTotalPounds * 100);
  }
  amountPence = Math.round(Number(amountPence));
  if (!Number.isFinite(amountPence) || amountPence <= 0) {
    return { success: false, error: 'Amount must be greater than zero' };
  }

  // 5. Unallocated-credit safety check (only when mandate found)
  if (opera.unallocatedCreditPounds >= 0.01) {
    return {
      success: false,
      error:
        `Customer ${operaAccount} has £${formatPounds(opera.unallocatedCreditPounds)} ` +
        `unallocated credit on their account. This may be a previous GoCardless payment ` +
        `not yet allocated to invoices. Please allocate existing receipts before ` +
        `requesting a new payment to avoid duplicate collection.`,
    };
  }

  // 6. Build description + sanitised charge_date
  const description = buildDescription(
    input.description,
    invoices,
    settings.request_statement_reference,
  );
  const chargeDate = normaliseChargeDate(input.chargeDate ?? null, today);

  // 7. Remote create
  const remote = await createRemote({
    amountPence,
    mandateId: mandate.mandate_id,
    description,
    chargeDate,
    metadata: {
      opera_account: operaAccount,
      invoices: invoices.join(','),
    },
  });
  if (!remote.success) {
    return {
      success: false,
      error: `GoCardless API error: ${remote.error ?? 'unknown'}`,
    };
  }
  const gcStatus = (remote.payment?.status as string | undefined) ?? 'pending';
  const gcChargeDate = (remote.payment?.charge_date as string | undefined) ?? null;
  const gcPaymentId = (remote.payment?.id as string | undefined) ?? null;

  // 8. Persist locally
  const persisted = await persistPaymentRequest(appDb, {
    mandate_id: mandate.mandate_id,
    opera_account: operaAccount,
    amount_pence: amountPence,
    invoice_refs: invoices,
    payment_id: gcPaymentId,
    charge_date: gcChargeDate,
    description,
    status: gcStatus,
    currency: 'GBP',
  });

  // 9. Estimate arrival = charge_date + 5 days (matches Python's rough estimate)
  let estimatedArrival: string | null = null;
  if (gcChargeDate) {
    const cd = new Date(`${gcChargeDate}T00:00:00Z`);
    if (!Number.isNaN(cd.getTime())) {
      cd.setUTCDate(cd.getUTCDate() + 5);
      estimatedArrival = cd.toISOString().slice(0, 10);
    }
  }

  return {
    success: true,
    message: `Payment of £${formatPounds(amountPence / 100)} requested for customer ${operaAccount}`,
    payment_request: {
      ...persisted,
      customer_name: mandate.opera_name ?? operaAccount,
      estimated_arrival: estimatedArrival,
    },
  };
}

// ---------------------------------------------------------------------
// Bulk wrapper
// ---------------------------------------------------------------------

export interface BulkRequestPaymentResponse {
  success: boolean;
  results: Array<{ opera_account: string | null } & RequestPaymentResponse>;
  summary: { total: number; succeeded: number; failed: number };
}

export async function requestBulkPayments(
  appDb: Knex,
  inputs: RequestPaymentInput[],
  settings: RequestPaymentSettings,
  readOpera: (
    operaAccount: string,
    invoices: string[],
  ) => Promise<OperaSnapshot>,
  createRemote: (input: {
    amountPence: number;
    mandateId: string;
    description: string;
    chargeDate: string | null;
    metadata: Record<string, string>;
  }) => Promise<RemoteCreatePaymentResult>,
  today?: Date,
): Promise<BulkRequestPaymentResponse> {
  const results: BulkRequestPaymentResponse['results'] = [];
  let succeeded = 0;
  let failed = 0;
  for (const input of inputs ?? []) {
    try {
      const r = await requestPayment(
        appDb,
        input,
        settings,
        readOpera,
        createRemote,
        today,
      );
      results.push({ opera_account: input.operaAccount ?? null, ...r });
      if (r.success) succeeded += 1;
      else failed += 1;
    } catch (err: any) {
      results.push({
        opera_account: input.operaAccount ?? null,
        success: false,
        error: err?.message ?? String(err),
      });
      failed += 1;
    }
  }
  return {
    success: failed === 0,
    results,
    summary: { total: inputs?.length ?? 0, succeeded, failed },
  };
}

// Exported helpers for tests / re-use
export const __test__ = {
  buildDescription,
  normaliseChargeDate,
  parseInvoiceRefs,
};
