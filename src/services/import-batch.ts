/**
 * GoCardless batch import — validation + orchestration layer.
 *
 * Faithful port of the route-level guards from
 * `import_gocardless_batch` (apps/gocardless/api/routes.py:622-949)
 * and the validation prelude from
 * `OperaSQLImport.import_gocardless_batch`
 * (sql_rag/opera_sql_import.py:6017-6213).
 *
 * Scope: every deterministic guard before the SQL posting body runs.
 * The actual posting (aentry / atran / stran / ntran / anoml / sname
 * updates) is delegated to a `BatchPostingExecutor` interface — the
 * SAM team plugs in the implementation that uses the unified Knex
 * client to write to either Opera SE (SQL Server) or Opera 3 via the
 * Write Agent.
 *
 * The exported `validateImportRequest` is the single source of truth
 * for "can we post this batch?" — used by the route and (later) by
 * batch-validate dry-run flows.
 */
import type { Knex } from 'knex';
import {
  validateAccountCode,
  validateBankCode,
  validateCbtype,
  SqlInputValidationError,
  validatePostingPeriod,
  getHomeCurrency,
} from '../_shared/index.js';
import { isPayoutImported } from './import-idempotency.js';
import { checkOrphanedImports } from './restore-recovery.js';

export interface IncomingPayment {
  customer_account: string;
  customer_name?: string;
  opera_customer_name?: string;
  amount: number;
  description?: string;
  auto_allocate?: boolean;
  gc_payment_id?: string;
  mandate_id?: string;
}

export interface ValidatedPayment {
  customer_account: string;
  customer_name: string;
  opera_customer_name: string;
  amount: number;
  description: string;
  auto_allocate: boolean;
  gc_payment_id: string;
  mandate_id: string;
}

export interface ImportRequest {
  bankCode: string;
  postDate: string;
  reference?: string;
  completeBatch?: boolean;
  cbtype?: string | null;
  goCardlessFees?: number;
  vatOnFees?: number;
  feesNominalAccount?: string | null;
  feesVatCode?: string;
  feesPaymentType?: string | null;
  currency?: string | null;
  payoutId?: string | null;
  source?: 'api' | 'email';
  destBankAccount?: string | null;
  destBankSortCode?: string | null;
  payments: IncomingPayment[];
  /** Optional email id (set when importing from a scanned email). */
  emailId?: number | null;
}

export interface ImportSettings {
  gocardless_bank_code?: string | null;
  gocardless_transfer_cbtype?: string | null;
}

export interface MandateLink {
  mandate_id: string;
  opera_account: string;
}

export interface ValidatedRequest {
  bankCode: string;
  postDate: Date;
  postDateString: string;
  reference: string;
  completeBatch: boolean;
  cbtype: string | null;
  goCardlessFees: number;
  vatOnFees: number;
  feesNominalAccount: string | null;
  feesVatCode: string;
  feesPaymentType: string | null;
  currency: string | null;
  payoutId: string | null;
  source: 'api' | 'email';
  destBankAccount: string | null;
  destBankSortCode: string | null;
  payments: ValidatedPayment[];
  postingBank: string;
  destinationBank: string | null;
  transferCbtype: string | null;
  emailId: number | null;
  warnings: string[];
}

export interface ValidationFailure {
  success: false;
  error: string;
  errors?: string[];
  duplicate_payout?: boolean;
}

export interface ValidationOk {
  success: true;
  request: ValidatedRequest;
}

export type ValidationResult = ValidationFailure | ValidationOk;

function parseYmd(input: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(input.trim());
  if (!m) return null;
  return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
}

function normaliseSortCode(s: string | null | undefined): string {
  return (s ?? '').replace(/[\s-]/g, '').trim();
}

function normaliseAccountNumber(s: string | null | undefined): string {
  return (s ?? '').replace(/\s/g, '').trim();
}

interface NbankRow {
  nk_acnt: string;
  nk_desc: string | null;
  nk_sort: string | null;
  nk_number: string | null;
}

async function bankExists(operaDb: Knex, bankCode: string): Promise<boolean> {
  try {
    const row = (await operaDb('nbank')
      .whereRaw('RTRIM(nk_acnt) = ?', [bankCode])
      .select('nk_acnt')
      .first()) as { nk_acnt?: string } | undefined;
    return !!row;
  } catch {
    return false;
  }
}

async function listBanks(operaDb: Knex): Promise<NbankRow[]> {
  try {
    return (await operaDb('nbank')
      .select(
        'nk_acnt',
        operaDb.raw('RTRIM(nk_desc) as nk_desc'),
        operaDb.raw('RTRIM(nk_sort) as nk_sort'),
        operaDb.raw('RTRIM(nk_number) as nk_number'),
      )) as unknown as NbankRow[];
  } catch {
    return [];
  }
}

export async function resolveDestinationBank(
  operaDb: Knex,
  bankCode: string,
  destBankSortCode: string | null,
  destBankAccount: string | null,
): Promise<string> {
  if (!destBankSortCode && !destBankAccount) return bankCode;
  const normSort = normaliseSortCode(destBankSortCode);
  const normAcct = normaliseAccountNumber(destBankAccount);
  if (!normSort && !normAcct) return bankCode;
  const banks = await listBanks(operaDb);
  for (const b of banks) {
    const dbSort = normaliseSortCode(b.nk_sort);
    const dbAcct = normaliseAccountNumber(b.nk_number);
    const sortMatch = !!normSort && !!dbSort && normSort === dbSort;
    const acctMatch =
      !!normAcct &&
      !!dbAcct &&
      (dbAcct.endsWith(normAcct) ||
        normAcct.endsWith(dbAcct) ||
        dbAcct === normAcct);
    if (sortMatch && acctMatch) return (b.nk_acnt ?? '').trim();
    if (sortMatch && !normAcct) return (b.nk_acnt ?? '').trim();
  }
  return bankCode;
}

export async function validateImportRequest(
  operaDb: Knex,
  appDb: Knex,
  input: ImportRequest,
  settings: ImportSettings,
  knownMandates: MandateLink[],
): Promise<ValidationResult> {
  let bankCode: string;
  let cbtype: string | null = null;
  let feesNominalAccount: string | null = null;

  try {
    bankCode = validateBankCode(input.bankCode);
    if (input.cbtype) {
      cbtype = validateCbtype(input.cbtype);
    }
    if (input.feesNominalAccount) {
      feesNominalAccount = validateAccountCode(input.feesNominalAccount);
    }
  } catch (e) {
    if (e instanceof SqlInputValidationError) {
      return { success: false, error: e.message };
    }
    return { success: false, error: (e as Error)?.message ?? String(e) };
  }

  if (!input.payments || input.payments.length === 0) {
    return { success: false, error: 'No payments provided' };
  }

  if (input.payoutId) {
    const alreadyImported = await isPayoutImported(appDb, input.payoutId);
    if (alreadyImported) {
      // Orphan-aware check: if the gocardless_imports row references Opera
      // entries that no longer exist (Opera SQL restore, manual deletion in
      // Opera Cashbook), the user genuinely needs to re-post — block only
      // when Opera still has the underlying entry.
      let isOrphan = false;
      try {
        const orphanResult = await checkOrphanedImports(operaDb, appDb);
        if (orphanResult.success) {
          isOrphan = orphanResult.orphans.some(
            (o) => o.payout_id === input.payoutId,
          );
        }
      } catch {
        // Best-effort — fall through to the strict refusal if the orphan
        // check fails; safer to block than to risk a double-post.
      }
      if (!isOrphan) {
        return {
          success: false,
          error: `Payout ${input.payoutId} has already been imported. Refusing to post the same payout twice. If you genuinely need to re-post, reverse the original first.`,
          duplicate_payout: true,
        };
      }
      // else: orphaned — allow the re-import. The route layer should also
      // have surfaced the orphan banner so the user knows this is post-restore.
    }
  }

  const validatedPayments: ValidatedPayment[] = [];
  for (let idx = 0; idx < input.payments.length; idx++) {
    const p = input.payments[idx]!;
    if (!p.customer_account) {
      return {
        success: false,
        error: `Payment ${idx + 1}: Missing customer_account`,
      };
    }
    if (!p.amount) {
      return {
        success: false,
        error: `Payment ${idx + 1}: Missing amount`,
      };
    }
    validatedPayments.push({
      customer_account: p.customer_account,
      customer_name: p.customer_name ?? '',
      opera_customer_name: p.opera_customer_name ?? '',
      amount: Number(p.amount),
      description: (p.description ?? '').slice(0, 35),
      auto_allocate: p.auto_allocate ?? true,
      gc_payment_id: p.gc_payment_id ?? '',
      mandate_id: p.mandate_id ?? '',
    });
  }

  // Mandate verification: if mandate is linked to a different account,
  // BLOCK. Mismatched mandate→customer is the no-1 cause of misposted
  // payments (the mandate is the bulletproof signal).
  const mandateToAccount = new Map<string, string>();
  for (const m of knownMandates) {
    const mid = (m.mandate_id ?? '').trim();
    const acct = (m.opera_account ?? '').trim();
    if (mid && acct && acct !== '__UNLINKED__') {
      mandateToAccount.set(mid, acct);
    }
  }
  for (let idx = 0; idx < validatedPayments.length; idx++) {
    const vp = validatedPayments[idx]!;
    const postingAccount = vp.customer_account.trim();
    const mid = vp.mandate_id.trim();
    if (mid && mandateToAccount.has(mid)) {
      const expected = mandateToAccount.get(mid)!;
      if (expected !== postingAccount) {
        return {
          success: false,
          error: `Payment ${idx + 1}: mandate ${mid} belongs to account ${expected}, but is being posted to ${postingAccount} (${vp.customer_name || ''}). Please correct the customer match before importing.`,
        };
      }
    }
  }

  const postDate = parseYmd(input.postDate);
  if (!postDate) {
    return {
      success: false,
      error: `Invalid date format: ${input.postDate}. Use YYYY-MM-DD`,
    };
  }
  const postDateString = postDate.toISOString().slice(0, 10);

  try {
    const period = await validatePostingPeriod(operaDb, postDateString, 'SL');
    if (!period.is_valid) {
      return {
        success: false,
        error: `Cannot post to this date: ${period.error_message ?? 'period closed'}`,
      };
    }
  } catch (e) {
    return {
      success: false,
      error: `Period validation failed: ${(e as Error)?.message ?? String(e)}`,
    };
  }

  const goCardlessFees = Number(input.goCardlessFees ?? 0);
  if (goCardlessFees > 0 && !feesNominalAccount) {
    return {
      success: false,
      error: `GoCardless fees of £${goCardlessFees.toFixed(
        2,
      )} cannot be posted: Fees Nominal Account not configured. Please configure the Fees Nominal Account in GoCardless Settings before importing.`,
    };
  }

  if (input.currency) {
    try {
      const home = await getHomeCurrency(operaDb);
      const homeCode = (home.code ?? 'GBP').toUpperCase();
      if (input.currency.toUpperCase() !== homeCode) {
        return {
          success: false,
          error: `GoCardless batch is in ${input.currency} but home currency is ${homeCode} (${home.description ?? ''}). Foreign currency GoCardless batches are not supported.`,
        };
      }
    } catch {
      // Home currency lookup failure is non-fatal — proceed.
    }
  }

  const gcBank = (settings.gocardless_bank_code ?? '').trim();
  const transferCbtype = (settings.gocardless_transfer_cbtype ?? '').trim();
  const resolvedDest = await resolveDestinationBank(
    operaDb,
    bankCode,
    input.destBankSortCode ?? null,
    input.destBankAccount ?? null,
  );
  let destinationBank: string | null = null;
  if (gcBank && resolvedDest !== gcBank) {
    destinationBank = resolvedDest;
  }
  const postingBank = gcBank || resolvedDest;

  for (const b of [postingBank, destinationBank].filter(
    (b): b is string => !!b,
  )) {
    if (!(await bankExists(operaDb, b))) {
      const label = b === postingBank ? 'GC Control bank' : 'Destination bank';
      return {
        success: false,
        error: `${label} '${b}' does not exist in this company's bank accounts. Please update GoCardless Settings with valid bank codes for this company.`,
      };
    }
  }

  const warnings: string[] = [];
  const seen = new Map<string, number[]>();
  for (let idx = 0; idx < validatedPayments.length; idx++) {
    const p = validatedPayments[idx]!;
    const key = `${p.customer_account}:${p.amount.toFixed(2)}`;
    const existing = seen.get(key) ?? [];
    existing.push(idx);
    seen.set(key, existing);
  }
  for (const [key, indices] of seen) {
    if (indices.length > 1) {
      const [acct, amt] = key.split(':');
      warnings.push(
        `Duplicate: ${acct} appears ${indices.length} times for £${amt} (payments ${indices.map((i) => i + 1).join(', ')}). Please verify each payment is matched to the correct customer.`,
      );
    }
  }

  return {
    success: true,
    request: {
      bankCode,
      postDate,
      postDateString,
      reference: input.reference ?? 'GoCardless',
      completeBatch: !!input.completeBatch,
      cbtype,
      goCardlessFees,
      vatOnFees: Number(input.vatOnFees ?? 0),
      feesNominalAccount,
      feesVatCode: input.feesVatCode ?? '2',
      feesPaymentType: input.feesPaymentType ?? null,
      currency: input.currency ?? null,
      payoutId: input.payoutId ?? null,
      source: input.source ?? 'api',
      destBankAccount: input.destBankAccount ?? null,
      destBankSortCode: input.destBankSortCode ?? null,
      payments: validatedPayments,
      postingBank,
      destinationBank,
      transferCbtype: transferCbtype || null,
      emailId: input.emailId ?? null,
      warnings,
    },
  };
}

/**
 * Posting executor — the part the SAM team writes against the unified
 * Knex client. Receives a fully validated request and performs the
 * actual aentry/atran/stran/ntran/anoml + balance updates.
 *
 * Returns the high-level outcome the route layer surfaces. Tests pass
 * a mock to verify the orchestration without exercising the SQL
 * writes.
 */
export interface BatchPostingExecutor {
  postBatch(
    operaDb: Knex,
    request: ValidatedRequest,
    /**
     * Per-app SQLite — used by auto-allocation to read
     * `gocardless_payment_requests` for invoice_refs (legacy Rule 0,
     * `auto_allocate_receipt`). Optional so the mock in tests can omit
     * it; production callers always supply it.
     */
    appDb?: Knex | null,
  ): Promise<{
    success: boolean;
    records_imported: number;
    batch_ref?: string | null;
    warnings: string[];
    errors: string[];
  }>;
}

export interface RecordImportArgs {
  payoutId: string | null;
  source: 'api' | 'email';
  bankReference: string;
  grossAmount: number;
  netAmount: number;
  goCardlessFees: number;
  vatOnFees: number;
  paymentCount: number;
  paymentsJson: string;
  batchRef: string | null;
  importedBy: string;
  postDate: string;
  emailId?: number | null;
}

async function recordImportHistory(
  appDb: Knex,
  args: RecordImportArgs,
): Promise<void> {
  try {
    await appDb('gocardless_imports').insert({
      target_system: 'opera_se',
      payout_id: args.payoutId,
      source: args.source,
      bank_reference: args.bankReference,
      gross_amount: args.grossAmount,
      net_amount: args.netAmount,
      // SAM schema column is `fees_amount` (per migration 001); the
      // legacy column name was `gocardless_fees`. Use the SAM name —
      // an earlier version of this insert silently failed on every
      // GoCardless import because SQLite/MSSQL rejected the unknown
      // column and the try/catch swallowed it. That left
      // gocardless_imports empty and the idempotency gate inert.
      fees_amount: args.goCardlessFees,
      vat_on_fees: args.vatOnFees,
      payment_count: args.paymentCount,
      payments_json: args.paymentsJson,
      batch_ref: args.batchRef,
      imported_by: args.importedBy,
      post_date: args.postDate,
      // payment_date drives the bank-code + date index used by the
      // history list endpoint; legacy set it from post_date.
      payment_date: args.postDate,
      email_id: args.emailId ?? null,
      imported_at: appDb.fn.now(),
    });
  } catch (err) {
    // History write failure is non-fatal at the import level (Python
    // logs warning then proceeds), but we DO surface the error so it
    // can be picked up in logs rather than silently dropping every
    // import row like the previous version did.
    // eslint-disable-next-line no-console
    console.warn(
      `[gocardless] recordImportHistory failed for payout ${args.payoutId}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}

export interface ImportLockAdapter {
  acquire(key: string, locker: string): Promise<boolean>;
  release(key: string): Promise<void>;
}

export interface ImportBatchResponse {
  success: boolean;
  message?: string;
  payments_imported?: number;
  complete?: boolean;
  details?: string[];
  error?: string;
  duplicate_payout?: boolean;
}

export async function importGocardlessBatch(
  operaDb: Knex,
  appDb: Knex,
  input: ImportRequest,
  settings: ImportSettings,
  knownMandates: MandateLink[],
  executor: BatchPostingExecutor,
  importLock: ImportLockAdapter,
): Promise<ImportBatchResponse> {
  const validation = await validateImportRequest(
    operaDb,
    appDb,
    input,
    settings,
    knownMandates,
  );
  if (!validation.success) {
    const failure = validation as ValidationFailure;
    const out: ImportBatchResponse = {
      success: false,
      error: failure.error,
    };
    if (failure.duplicate_payout) out.duplicate_payout = true;
    return out;
  }
  const request = validation.request;

  const lockKey = `gocardless:${request.postingBank}`;
  const acquired = await importLock.acquire(lockKey, 'gocardless-import');
  if (!acquired) {
    return {
      success: false,
      error: `Bank account ${request.postingBank} is currently being imported by another user. Please wait for the current import to complete.`,
    };
  }

  try {
    const result = await executor.postBatch(operaDb, request, appDb);
    if (!result.success) {
      return {
        success: false,
        error: result.errors.join('; ') || 'Posting failed',
      };
    }

    const grossAmount = request.payments.reduce(
      (acc, p) => acc + p.amount,
      0,
    );
    const netAmount = grossAmount - request.goCardlessFees;
    await recordImportHistory(appDb, {
      payoutId: request.payoutId,
      source: request.source,
      bankReference: request.reference,
      grossAmount,
      netAmount,
      goCardlessFees: request.goCardlessFees,
      vatOnFees: request.vatOnFees,
      paymentCount: request.payments.length,
      paymentsJson: JSON.stringify(
        request.payments.map((p) => ({
          customer_account: p.customer_account,
          gc_customer_name: p.customer_name,
          opera_customer_name: p.opera_customer_name,
          amount: p.amount,
          description: p.description,
        })),
      ),
      batchRef: result.batch_ref ?? null,
      importedBy: 'GOCARDLS',
      postDate: request.postDateString,
      emailId: request.emailId,
    });

    return {
      success: true,
      message: `Successfully imported ${request.payments.length} payments`,
      payments_imported: result.records_imported,
      complete: request.completeBatch,
      details: [...request.warnings, ...result.warnings].filter(Boolean),
    };
  } finally {
    try {
      await importLock.release(lockKey);
    } catch {
      // best-effort
    }
  }
}
