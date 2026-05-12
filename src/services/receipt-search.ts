/**
 * Receipt search across GoCardless import history.
 *
 * Faithful port of `search_gocardless_receipts` from
 * apps/gocardless/api/routes.py:2423.
 *
 * Reads import history from the per-app DB, flattens payments_json
 * into individual receipt rows, enriches with Opera customer names,
 * and applies customer/date filters.
 */
import type { Knex } from 'knex';

function r2(n: number): number {
  return Math.round(n * 100) / 100;
}

function dateToYmd(d: Date | string | null): string {
  if (!d) return '';
  if (d instanceof Date) {
    if (Number.isNaN(d.getTime())) return '';
    return d.toISOString().slice(0, 10);
  }
  return String(d).slice(0, 10);
}

export interface Receipt {
  import_id: number;
  receipt_date: string;
  payout_id: string;
  bank_reference: string;
  batch_ref: string;
  customer_account: string;
  customer_name: string;
  gc_customer_name: string;
  amount: number;
  currency: string;
  payment_id: string;
  invoice_ref: string;
}

export interface ReceiptSearchOptions {
  customer?: string | null;
  fromDate?: string | null;
  toDate?: string | null;
  limit?: number;
}

export interface ReceiptSearchResponse {
  success: boolean;
  total: number;
  total_amount: number;
  receipts: Receipt[];
  error?: string;
}

export async function searchReceipts(
  appDb: Knex,
  operaDb: Knex | null,
  opts: ReceiptSearchOptions = {},
): Promise<ReceiptSearchResponse> {
  try {
    const limit = opts.limit ?? 200;
    const searchLower = opts.customer ? opts.customer.toLowerCase().trim() : null;

    // Fetch up to 1000 history records in the date range to search within
    let query = appDb('gocardless_imports')
      .where({ target_system: 'opera_se' })
      .orderBy('payment_date', 'desc')
      .orderBy('imported_at', 'desc')
      .limit(1000);
    if (opts.fromDate) query = query.andWhere('payment_date', '>=', opts.fromDate);
    if (opts.toDate) query = query.andWhere('payment_date', '<=', opts.toDate);

    const history = (await query) as unknown as Array<{
      id: number;
      bank_reference: string | null;
      payment_date: Date | string | null;
      payments_json: string | null;
      target_system: string | null;
      imported_at: Date | string;
    }>;

    // Collect unique customer accounts for Opera-name enrichment
    const allAccounts = new Set<string>();
    const parsedByRow = new Map<number, Array<Record<string, unknown>>>();
    for (const r of history) {
      if (!r.payments_json) {
        parsedByRow.set(r.id, []);
        continue;
      }
      try {
        const parsed = JSON.parse(r.payments_json);
        const list = Array.isArray(parsed) ? (parsed as Array<Record<string, unknown>>) : [];
        parsedByRow.set(r.id, list);
        for (const p of list) {
          const acct = String(p.customer_account ?? '').trim();
          if (acct) allAccounts.add(acct);
        }
      } catch {
        parsedByRow.set(r.id, []);
      }
    }

    // Opera customer name lookup (best-effort)
    const operaNames = new Map<string, string>();
    if (allAccounts.size > 0 && operaDb) {
      try {
        const codes = [...allAccounts];
        const placeholders = codes.map(() => '?').join(',');
        const rows = (await operaDb.raw(
          `SELECT sn_account, sn_name FROM sname WITH (NOLOCK) WHERE sn_account IN (${placeholders})`,
          codes,
        )) as unknown as Array<{ sn_account: string | null; sn_name: string | null }>;
        for (const row of Array.isArray(rows) ? rows : []) {
          const a = (row.sn_account ?? '').trim();
          const n = (row.sn_name ?? '').trim();
          if (a && n) operaNames.set(a, n);
        }
      } catch {
        // Non-fatal — caller still gets the raw history without Opera names
      }
    }

    const receipts: Receipt[] = [];
    for (const record of history) {
      const payments = parsedByRow.get(record.id) ?? [];
      for (const p of payments) {
        const acct = String(p.customer_account ?? '').trim();
        const gcName = String(p.gc_customer_name ?? p.customer_name ?? '').trim();
        const operaName =
          String(p.opera_customer_name ?? '').trim() || operaNames.get(acct) || '';
        const amount = Number(p.amount ?? 0);

        if (searchLower) {
          const searchable = `${acct} ${gcName} ${operaName}`.toLowerCase();
          if (!searchable.includes(searchLower)) continue;
        }

        receipts.push({
          import_id: record.id,
          receipt_date: dateToYmd(record.payment_date),
          payout_id: '',
          bank_reference: record.bank_reference ?? '',
          batch_ref: '',
          customer_account: acct,
          customer_name: operaName || gcName,
          gc_customer_name: gcName,
          amount,
          currency: String(p.currency ?? 'GBP'),
          payment_id: String(p.payment_id ?? ''),
          invoice_ref: String(p.invoice_ref ?? p.reference ?? ''),
        });
      }
    }

    // Sort: date descending, then customer name
    receipts.sort((a, b) => {
      if (a.receipt_date < b.receipt_date) return 1;
      if (a.receipt_date > b.receipt_date) return -1;
      return a.customer_name.localeCompare(b.customer_name);
    });
    const trimmed = receipts.slice(0, limit);
    const totalAmount = trimmed.reduce((sum, r) => sum + r.amount, 0);

    return {
      success: true,
      total: trimmed.length,
      total_amount: r2(totalAmount),
      receipts: trimmed,
    };
  } catch (err: any) {
    return {
      success: false,
      total: 0,
      total_amount: 0,
      receipts: [],
      error: err?.message ?? String(err),
    };
  }
}
