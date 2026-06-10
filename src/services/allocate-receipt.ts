/**
 * Auto-allocate a sales receipt to outstanding invoices.
 *
 * Faithful port of `OperaSQLImport.auto_allocate_receipt`
 * (sql_rag/opera_sql_import.py:7017-7426). Called per-payment from the
 * GoCardless batch posting executor immediately after each stran
 * receipt INSERT, when `auto_allocate=true` is set on the payment.
 *
 * Allocation rules (priority order, exact legacy parity):
 *   Rule 0 — payment request invoice lookup: if `gc_payment_id` is
 *     supplied AND the payment request was raised with stored
 *     `invoice_refs`, allocate to those still outstanding (skipping
 *     any already paid manually in Opera). Any excess stays on
 *     account. Partial allocation supported.
 *   Rule 1 — invoice reference in description: search description
 *     for /INV\d+/, allocate to matching invoices iff their total
 *     equals the receipt exactly. Otherwise return mismatch error.
 *   Rule 2 — clear-account: if the receipt equals the customer's
 *     total outstanding AND there is ≥1 invoice, allocate to all.
 *
 * Otherwise the receipt is left on account (success=false with
 * a diagnostic message; caller continues — does NOT abort the
 * batch).
 *
 * Side effects (all in the caller's existing trx — no new transaction):
 *   - stran (receipt): st_trbal +allocated, st_paid='A', st_payday,
 *     st_payflag = next payflag
 *   - stran (each allocated invoice): st_trbal -allocated, st_paid='P'
 *     when fully cleared, st_payday, st_payflag, st_lastrec
 *   - salloc: insert one row per allocated invoice + one row for the
 *     receipt itself when fully allocated; al_unique = stran.id
 *     (Opera convention)
 *   - sname.sn_lastrec = allocation date
 *
 * SAM additional safety: every DML uses Knex's `.update()` builder
 * which returns rowsAffected as a real number across mssql/foxpro/
 * sqlite drivers (not `trx.raw('UPDATE...')` which silently returns
 * empty array on mssql/tedious).
 */
import type { Knex } from 'knex';
import { getNextId } from '../_shared/index.js';
import { companyScope } from '../_shared/get-company.js';

/**
 * Look up a payment request by GoCardless payment_id (PM...) to get
 * the originally-requested invoice_refs (CSV string). Returns null if
 * appDb is unavailable, the row doesn't exist, or invoice_refs is
 * empty. Faithful to legacy `payments_db.get_payment_request_by_payment_id`.
 */
async function lookupInvoiceRefsByPaymentId(
  appDb: Knex,
  companyCode: string,
  paymentId: string,
): Promise<string[] | null> {
  const scope = companyScope(companyCode);
  try {
    const row = (await appDb('gocardless_payment_requests')
      .select('invoice_refs')
      .where({ ...scope, payment_id: paymentId })
      .first()) as { invoice_refs?: string | null } | undefined;
    const raw = (row?.invoice_refs ?? '').toString().trim();
    if (!raw) return null;
    return raw
      .split(',')
      .map((r) => r.trim())
      .filter((r) => r.length > 0);
  } catch {
    return null;
  }
}

export interface AllocateReceiptInput {
  customerAccount: string;
  receiptRef: string;
  /** Receipt amount in POUNDS (positive). */
  receiptAmount: number;
  /** YYYY-MM-DD string. */
  allocationDate: string;
  /** Bank account code (for salloc.al_acnt audit). */
  bankAccount: string;
  /** Description to scan for /INV\d+/ references. */
  description?: string | null;
  /** GoCardless payment ID, for Rule 0 lookup. */
  gcPaymentId?: string | null;
  /**
   * ISO timestamp string ('YYYY-MM-DD HH:MM:SS') for datecreated /
   * datemodified columns. Caller passes this so the timestamp is
   * consistent across all rows in the same batch and the SQL is
   * portable across SQL Server (Opera SE) and FoxPro (Opera 3) —
   * neither dialect's "current timestamp" function is the same.
   */
  nowIso: string;
}

export interface AllocatedInvoice {
  ref: string;
  custref: string;
  amount: number;
  full_allocation: boolean;
  unique: string;
  stran_id: number;
}

export interface AllocateReceiptResult {
  success: boolean;
  allocated_amount: number;
  allocations: AllocatedInvoice[];
  receipt_fully_allocated?: boolean;
  allocation_method?:
    | 'payment_request'
    | 'invoice_reference'
    | 'clears_account'
    | 'single_invoice_match';
  message: string;
}

interface ReceiptRow {
  id: number;
  st_trref: string;
  st_trvalue: number;
  st_trbal: number;
  st_paid: string;
  st_custref: string | null;
  st_unique: string | null;
}

interface InvoiceRow {
  id: number;
  st_trref: string;
  st_trvalue: number;
  st_trbal: number;
  st_custref: string | null;
  st_trdate: string;
  st_unique: string | null;
}

const INVOICE_REF_RE = /INV\d+/g;

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export async function autoAllocateReceipt(
  trx: Knex,
  appDb: Knex | null,
  companyCode: string | null,
  input: AllocateReceiptInput,
): Promise<AllocateReceiptResult> {
  const customer = input.customerAccount.trim();
  const ref = input.receiptRef.trim();
  const result: AllocateReceiptResult = {
    success: false,
    allocated_amount: 0,
    allocations: [],
    message: '',
  };

  try {
    // 1. Locate the receipt row in stran. Filter by amount-proximity
    // so we pick the right receipt when multiple share the same
    // ref (legacy line 7080-7087).
    const receiptRows = (await trx('stran')
      .select(
        'id',
        'st_trref',
        'st_trvalue',
        'st_trbal',
        'st_paid',
        'st_custref',
        'st_unique',
      )
      .where('st_account', customer)
      .whereRaw('RTRIM(st_trref) = ?', [ref])
      .andWhere('st_trtype', 'R')
      .andWhere('st_trbal', '<', 0)
      .orderByRaw('ABS(ABS(st_trbal) - ?) ASC', [input.receiptAmount])) as unknown as ReceiptRow[];

    if (!receiptRows.length) {
      result.message = `Receipt ${ref} not found or already allocated`;
      return result;
    }
    const receipt = receiptRows[0]!;
    const receiptBalance = Math.abs(Number(receipt.st_trbal));
    const receiptUnique = (receipt.st_unique ?? '').trim();
    const receiptStranId = Number(receipt.id);

    if (receiptBalance <= 0) {
      result.message = 'Receipt already fully allocated';
      return result;
    }

    // 2. Load outstanding invoices for the customer (legacy 7099-7106).
    const invoiceRows = (await trx('stran')
      .select(
        'id',
        'st_trref',
        'st_trvalue',
        'st_trbal',
        'st_custref',
        'st_trdate',
        'st_unique',
      )
      .where('st_account', customer)
      .andWhere('st_trtype', 'I')
      .andWhere('st_trbal', '>', 0)
      .orderBy([
        { column: 'st_trdate', order: 'asc' },
        { column: 'st_trref', order: 'asc' },
      ])) as unknown as InvoiceRow[];

    if (!invoiceRows.length) {
      result.message = 'No outstanding invoices found for customer';
      return result;
    }

    const totalOutstanding = round2(
      invoiceRows.reduce((sum, inv) => sum + Number(inv.st_trbal), 0),
    );
    const receiptRounded = round2(input.receiptAmount);

    let invoicesToAllocate: AllocatedInvoice[] = [];
    let allocationMethod: AllocateReceiptResult['allocation_method'] | null =
      null;

    // === RULE 0 — payment request lookup ===
    // Match against legacy lines 7124-7188. Only attempts if appDb is
    // wired and gc_payment_id supplied.
    if (input.gcPaymentId && appDb && companyCode) {
      try {
        const refs = await lookupInvoiceRefsByPaymentId(
          appDb,
          companyCode,
          input.gcPaymentId,
        );
        if (refs) {
          const prRefs = refs
            .map((r) => r.toUpperCase())
            .filter((r) => r.length > 0);
          if (prRefs.length > 0) {
            const prToAllocate: AllocatedInvoice[] = [];
            for (const invRef of prRefs) {
              const inv = invoiceRows.find(
                (i) => (i.st_trref ?? '').trim().toUpperCase() === invRef,
              );
              if (!inv) continue;
              const invBalance = Number(inv.st_trbal);
              if (invBalance > 0.005) {
                prToAllocate.push({
                  ref: (inv.st_trref ?? '').trim(),
                  custref: (inv.st_custref ?? '').trim(),
                  amount: invBalance,
                  full_allocation: true,
                  unique: (inv.st_unique ?? '').trim(),
                  stran_id: Number(inv.id),
                });
              }
            }
            if (prToAllocate.length > 0) {
              const totalPrBalance = round2(
                prToAllocate.reduce((s, a) => s + a.amount, 0),
              );
              if (receiptRounded >= totalPrBalance) {
                invoicesToAllocate = prToAllocate;
                allocationMethod = 'payment_request';
              } else {
                // Partial — allocate oldest first up to receipt
                // amount (legacy lines 7170-7182).
                let remaining = receiptRounded;
                for (const a of prToAllocate) {
                  if (remaining <= 0.005) break;
                  const allocAmt = Math.min(a.amount, remaining);
                  a.amount = allocAmt;
                  a.full_allocation = Math.abs(allocAmt - a.amount) < 0.01;
                  remaining -= allocAmt;
                }
                invoicesToAllocate = prToAllocate.filter(
                  (a) => a.amount > 0.005,
                );
                allocationMethod = 'payment_request';
              }
            }
          }
        }
      } catch {
        // Fall through — payment request lookup is best-effort
      }
    }

    // === RULE 1 — invoice reference in description ===
    if (!allocationMethod) {
      const invMatches: string[] = [];
      if (input.description) {
        const upper = input.description.toUpperCase();
        let m: RegExpExecArray | null;
        const re = new RegExp(INVOICE_REF_RE.source, 'g');
        while ((m = re.exec(upper))) invMatches.push(m[0]);
      }
      if (invMatches.length > 0) {
        const matched: AllocatedInvoice[] = [];
        for (const invRef of invMatches) {
          const inv = invoiceRows.find(
            (i) => (i.st_trref ?? '').trim().toUpperCase() === invRef,
          );
          if (!inv) continue;
          const balance = Number(inv.st_trbal);
          if (balance > 0) {
            matched.push({
              ref: (inv.st_trref ?? '').trim(),
              custref: (inv.st_custref ?? '').trim(),
              amount: balance,
              full_allocation: true,
              unique: (inv.st_unique ?? '').trim(),
              stran_id: Number(inv.id),
            });
          }
        }
        if (matched.length > 0) {
          const totalInvoiceBalance = round2(
            matched.reduce((s, a) => s + a.amount, 0),
          );
          if (Math.abs(receiptRounded - totalInvoiceBalance) < 0.005) {
            invoicesToAllocate = matched;
            allocationMethod = 'invoice_reference';
          } else {
            const details = matched
              .map((a) => `${a.ref} (£${a.amount.toFixed(2)})`)
              .join(', ');
            result.message =
              `Invoice reference(s) found but amounts do not match: ` +
              `receipt £${receiptRounded.toFixed(2)} vs invoice total ` +
              `£${totalInvoiceBalance.toFixed(2)}. Found: ${details}`;
            return result;
          }
        } else {
          result.message = `Invoice reference(s) ${invMatches.join(',')} not found in outstanding invoices`;
          return result;
        }
      }
    }

    // === RULE 2 — clears account ===
    if (!allocationMethod) {
      if (
        Math.abs(receiptRounded - totalOutstanding) < 0.005 &&
        invoiceRows.length >= 1
      ) {
        invoicesToAllocate = invoiceRows
          .filter((inv) => Number(inv.st_trbal) > 0)
          .map((inv) => ({
            ref: (inv.st_trref ?? '').trim(),
            custref: (inv.st_custref ?? '').trim(),
            amount: Number(inv.st_trbal),
            full_allocation: true,
            unique: (inv.st_unique ?? '').trim(),
            stran_id: Number(inv.id),
          }));
        allocationMethod =
          invoiceRows.length >= 2 ? 'clears_account' : 'single_invoice_match';
      } else {
        result.message =
          `Cannot auto-allocate: no invoice reference in description and ` +
          `receipt £${receiptRounded.toFixed(2)} does not clear account total ` +
          `£${totalOutstanding.toFixed(2)}`;
        return result;
      }
    }

    // === Allocation phase ===
    const totalInvoiceAmount = round2(
      invoicesToAllocate.reduce((s, a) => s + a.amount, 0),
    );
    let totalToAllocate: number;
    let receiptFullyAllocated: boolean;
    if (
      allocationMethod === 'payment_request' &&
      receiptRounded > totalInvoiceAmount
    ) {
      totalToAllocate = totalInvoiceAmount;
      receiptFullyAllocated = false;
    } else {
      totalToAllocate = input.receiptAmount;
      receiptFullyAllocated = true;
    }

    // Next payflag (sequential per customer) — legacy 7286-7290
    const payflagRow = (await trx('salloc')
      .max({ max: 'al_payflag' })
      .where('al_account', customer)
      .first()) as { max: number | null } | undefined;
    const nextPayflag = Number(payflagRow?.max ?? 0) + 1;

    const newReceiptBal = receiptBalance - totalToAllocate;
    const receiptPaidFlag = receiptFullyAllocated ? 'A' : ' ';
    const receiptPayday = receiptFullyAllocated ? input.allocationDate : null;

    // Update receipt row (legacy 7297-7308)
    {
      const updated = Number(
        await trx('stran')
          .where('st_account', customer)
          .whereRaw('RTRIM(st_trref) = ?', [ref])
          .andWhere('st_trtype', 'R')
          .andWhereRaw('RTRIM(st_unique) = ?', [receiptUnique])
          .update({
            st_trbal: -newReceiptBal,
            st_paid: receiptPaidFlag,
            st_payday: receiptPayday,
            st_payflag: nextPayflag,
            datemodified: input.nowIso,
          }),
      );
      if (updated === 0) {
        result.message = `Receipt update affected 0 rows (ref=${ref}, customer=${customer})`;
        return result;
      }
    }

    // salloc insert for receipt (only when fully allocated) — legacy 7313-7336
    if (receiptFullyAllocated) {
      const allocRef2 =
        allocationMethod === 'payment_request'
          ? 'AUTO:GC_REQ'
          : allocationMethod === 'invoice_reference'
            ? 'AUTO:INV_REF'
            : 'AUTO:CLR_ACCT';
      const sallocId = await getNextId(trx, 'salloc');
      await trx('salloc').insert({
        id: sallocId,
        al_account: customer,
        al_date: input.allocationDate,
        al_ref1: ref,
        al_ref2: allocRef2,
        al_type: 'R',
        al_val: -receiptBalance,
        al_payind: 'A',
        al_payflag: nextPayflag,
        al_payday: input.allocationDate,
        al_fcurr: '   ',
        al_fval: 0,
        al_fdec: 0,
        al_advind: 0,
        al_acnt: input.bankAccount,
        al_cntr: '    ',
        al_preprd: 0,
        al_unique: receiptStranId,
        al_adjsv: 0,
        datecreated: input.nowIso,
        datemodified: input.nowIso,
        state: 1,
      });
    }

    // Update each invoice + insert salloc rows — legacy 7338-7395
    for (const alloc of invoicesToAllocate) {
      const invRef = alloc.ref;
      const allocAmount = alloc.amount;
      const invStranId = alloc.stran_id;

      const invRow = (await trx('stran')
        .select('st_trbal', 'st_trdate')
        .where('st_account', customer)
        .whereRaw('RTRIM(st_trref) = ?', [invRef])
        .andWhere('st_trtype', 'I')
        .first()) as
        | { st_trbal: number; st_trdate: string | Date }
        | undefined;
      if (!invRow) continue;

      const newInvBal = Number(invRow.st_trbal) - allocAmount;
      const fullyPaid = newInvBal < 0.01;
      const invPaidFlag = fullyPaid ? 'P' : ' ';
      const invPayday = fullyPaid ? input.allocationDate : null;
      const invDate =
        invRow.st_trdate instanceof Date
          ? invRow.st_trdate.toISOString().slice(0, 10)
          : String(invRow.st_trdate).slice(0, 10);

      const updateBody: Record<string, unknown> = {
        st_trbal: newInvBal,
        st_paid: invPaidFlag,
        st_payday: invPayday,
        st_payflag: nextPayflag,
        datemodified: input.nowIso,
      };
      if (fullyPaid) updateBody.st_lastrec = invDate;

      await trx('stran')
        .where('st_account', customer)
        .whereRaw('RTRIM(st_trref) = ?', [invRef])
        .andWhere('st_trtype', 'I')
        .update(updateBody);

      if (fullyPaid) {
        const sallocInvId = await getNextId(trx, 'salloc');
        await trx('salloc').insert({
          id: sallocInvId,
          al_account: customer,
          al_date: invDate,
          al_ref1: invRef,
          al_ref2: alloc.custref.slice(0, 20),
          al_type: 'I',
          al_val: allocAmount,
          al_payind: 'A',
          al_payflag: nextPayflag,
          al_payday: input.allocationDate,
          al_fcurr: '   ',
          al_fval: 0,
          al_fdec: 0,
          al_advind: 0,
          al_acnt: input.bankAccount,
          al_cntr: '    ',
          al_preprd: 0,
          al_unique: invStranId,
          al_adjsv: 0,
          datecreated: input.nowIso,
          datemodified: input.nowIso,
          state: 1,
        });
      }
    }

    // sname.sn_lastrec — legacy 7398-7403
    await trx('sname')
      .whereRaw('RTRIM(sn_account) = ?', [customer])
      .update({
        sn_lastrec: input.allocationDate,
        datemodified: input.nowIso,
      });

    result.success = true;
    result.allocated_amount = totalToAllocate;
    result.allocations = invoicesToAllocate;
    result.receipt_fully_allocated = receiptFullyAllocated;
    result.allocation_method = allocationMethod;
    if (allocationMethod === 'payment_request') {
      result.message = `Allocated £${totalToAllocate.toFixed(2)} to ${invoicesToAllocate.length} invoice(s) from payment request`;
    } else if (allocationMethod === 'invoice_reference') {
      result.message = `Allocated £${totalToAllocate.toFixed(2)} to ${invoicesToAllocate.length} invoice(s) by reference`;
    } else {
      result.message = `Allocated £${totalToAllocate.toFixed(2)} to ${invoicesToAllocate.length} invoice(s) - clears account`;
    }
    return result;
  } catch (err) {
    result.message = `Allocation failed: ${err instanceof Error ? err.message : String(err)}`;
    return result;
  }
}
