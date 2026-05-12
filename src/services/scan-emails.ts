/**
 * GoCardless scan-emails — scan the connected mailbox for payout
 * notifications and return parsed batches ready for review.
 *
 * Faithful port of:
 *   - scan_gocardless_emails (apps/gocardless/api/routes.py:2731-3130)
 *
 * Behaviour:
 *   1. Sync inbox (best-effort, time-bounded)
 *   2. Search emails for keyword "gocardless" within optional date range
 *   3. Skip already-imported (by email_id and bank_reference)
 *   4. Filter by company_reference from settings
 *   5. Parse with `parseGocardlessEmail`
 *   6. Run duplicate-batch detection against the cashbook
 *   7. Validate posting period for the payment date
 *   8. Detect foreign currency vs Opera home currency
 *
 * Email and idempotency surfaces are abstracted via the
 * `ScanEmailDeps` shape so the service stays testable without
 * Microsoft Graph / SAM email-ingest in the loop.
 */
import type { Knex } from 'knex';
import {
  getCurrentPeriodInfo,
  getHomeCurrency,
  validatePostingPeriod,
  type LedgerType,
} from '../_shared/index.js';
import {
  parseGocardlessEmail,
  type GoCardlessBatch,
} from './parser.js';
import { checkDuplicateBatch } from './duplicate-detection.js';
import {
  getImportedEmailIds,
  getImportedReferences,
} from './import-idempotency.js';

export interface ScannedEmail {
  id: number;
  subject?: string | null;
  body_text?: string | null;
  body_html?: string | null;
  received_at?: string | Date | null;
  from_address?: string | null;
}

export interface ScanEmailsListResult {
  emails: ScannedEmail[];
}

export interface EmailMailboxAdapter {
  /** Optional best-effort sync; if it throws or times out we fall back to cached emails. */
  sync?: () => Promise<void>;
  list: (opts: {
    search: string;
    fromDate?: Date | null;
    toDate?: Date | null;
    pageSize: number;
  }) => Promise<ScanEmailsListResult>;
}

export interface ScanEmailsInput {
  fromDate?: string | null;
  toDate?: string | null;
  includeProcessed?: boolean;
  companyReferenceOverride?: string | null;
  /** From settings (settings.company_reference). */
  companyReference?: string | null;
  /** Cashbook type filter for duplicate detection (settings.default_batch_type). */
  defaultCbtype?: string | null;
}

export interface ScannedBatch {
  email_id: number | null;
  email_subject: string | null;
  email_date: string | null;
  email_from: string | null;
  possible_duplicate: boolean;
  duplicate_warning: string | null;
  bank_tx_warning: string | null;
  ref_warning: string | null;
  period_valid: boolean;
  period_error: string | null;
  is_foreign_currency: boolean;
  home_currency: string;
  batch: {
    gross_amount: number;
    gocardless_fees: number;
    vat_on_fees: number;
    net_amount: number;
    bank_reference: string | null;
    currency: string;
    payment_date: string | null;
    payment_count: number;
    payments: Array<{
      customer_name: string;
      description: string;
      amount: number;
      invoice_refs: string[];
    }>;
  };
}

export interface ScanEmailsResponse {
  success: boolean;
  message?: string;
  total_emails?: number;
  parsed_count?: number;
  error_count?: number;
  skipped_wrong_company?: number;
  skipped_already_imported?: number;
  skipped_duplicates?: number;
  company_reference?: string;
  current_period?: { year: number | null; period: number | null };
  batches?: ScannedBatch[];
  error?: string;
}

function parseDateOrNull(input: string | null | undefined): Date | null {
  if (!input) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(input.trim());
  if (!m) return null;
  return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
}

function emailHasPayoutKeyword(subject: string): boolean {
  const lower = subject.toLowerCase();
  return ['payout', 'payment', 'collected', 'paid'].some((kw) =>
    lower.includes(kw),
  );
}

function batchPaymentDateString(batch: GoCardlessBatch): string | null {
  if (!batch.payment_date) return null;
  return batch.payment_date.toISOString().slice(0, 10);
}

export async function scanGocardlessEmails(
  operaDb: Knex,
  appDb: Knex,
  mailbox: EmailMailboxAdapter,
  input: ScanEmailsInput,
): Promise<ScanEmailsResponse> {
  if (mailbox.sync) {
    try {
      await Promise.race([
        mailbox.sync(),
        new Promise<void>((_, reject) =>
          setTimeout(() => reject(new Error('sync timeout')), 30_000),
        ),
      ]);
    } catch {
      // continue with cached emails
    }
  }

  const companyRef = (
    input.companyReferenceOverride ??
    input.companyReference ??
    ''
  )
    .toString()
    .trim();

  const fromDate = parseDateOrNull(input.fromDate ?? null);
  const toDate = parseDateOrNull(input.toDate ?? null);

  let importedEmailIds = new Set<number>();
  let importedReferences = new Set<string>();
  if (!input.includeProcessed) {
    importedEmailIds = new Set(await getImportedEmailIds(appDb));
    importedReferences = await getImportedReferences(appDb);
  }

  const list = await mailbox.list({
    search: 'gocardless',
    fromDate,
    toDate,
    pageSize: 100,
  });
  const emails = list.emails ?? [];
  if (emails.length === 0) {
    return {
      success: true,
      message: 'No GoCardless emails found',
      batches: [],
      total_emails: 0,
      company_reference: companyRef,
    };
  }

  const home = await getHomeCurrency(operaDb);
  const homeCurrency = home.code ?? 'GBP';

  const batches: ScannedBatch[] = [];
  let processed = 0;
  let errors = 0;
  let skippedWrongCompany = 0;
  let skippedAlreadyImported = 0;
  let skippedDuplicates = 0;

  for (const email of emails) {
    try {
      const emailId = Number(email.id);
      if (
        !input.includeProcessed &&
        Number.isFinite(emailId) &&
        importedEmailIds.has(emailId)
      ) {
        skippedAlreadyImported += 1;
        continue;
      }

      const content = email.body_text || email.body_html || '';
      if (!content) continue;

      const subject = (email.subject ?? '').toString();
      if (!emailHasPayoutKeyword(subject)) continue;

      const batch = parseGocardlessEmail(content);
      if (batch.payments.length === 0) continue;

      if (companyRef) {
        const batchRef = (batch.bank_reference ?? '').toUpperCase();
        const ref = companyRef.toUpperCase();
        const matchesRef =
          batchRef.includes(ref) || (batchRef.length > 0 && ref.includes(batchRef));
        if (!matchesRef && !content.toUpperCase().includes(ref)) {
          skippedWrongCompany += 1;
          continue;
        }
      }

      if (
        batch.bank_reference &&
        importedReferences.has(batch.bank_reference)
      ) {
        skippedAlreadyImported += 1;
        continue;
      }

      const isForeignCurrency =
        !!batch.currency &&
        batch.currency.toUpperCase() !== homeCurrency.toUpperCase();

      const dup = await checkDuplicateBatch(operaDb, {
        netAmountPounds: batch.net_amount,
        grossAmountPounds: batch.gross_amount,
        goCardlessFeesPounds: batch.gocardless_fees,
        bankReference: batch.bank_reference,
        paymentDate: batch.payment_date ?? null,
        payments: batch.payments.map((p) => ({ amount: p.amount })),
        defaultCbtype: input.defaultCbtype ?? null,
      });

      let periodValid = true;
      let periodError: string | null = null;
      if (batch.payment_date) {
        try {
          const r = await validatePostingPeriod(
            operaDb,
            batch.payment_date.toISOString().slice(0, 10),
            'SL' as LedgerType,
          );
          periodValid = r.is_valid;
          if (!periodValid) periodError = r.error_message ?? null;
        } catch {
          // advisory
        }
      }

      const batchData: ScannedBatch = {
        email_id: Number.isFinite(emailId) ? emailId : null,
        email_subject: email.subject ?? null,
        email_date:
          email.received_at instanceof Date
            ? email.received_at.toISOString()
            : email.received_at
            ? String(email.received_at)
            : null,
        email_from: email.from_address ?? null,
        possible_duplicate: dup.possible_duplicate,
        duplicate_warning: dup.duplicate_warning,
        bank_tx_warning: dup.bank_tx_warning,
        ref_warning: dup.ref_warning,
        period_valid: periodValid,
        period_error: periodError,
        is_foreign_currency: isForeignCurrency,
        home_currency: homeCurrency,
        batch: {
          gross_amount: batch.gross_amount,
          gocardless_fees: batch.gocardless_fees,
          vat_on_fees: batch.vat_on_fees,
          net_amount: batch.net_amount,
          bank_reference: batch.bank_reference,
          currency: batch.currency,
          payment_date: batchPaymentDateString(batch),
          payment_count: batch.payments.length,
          payments: batch.payments.map((p) => ({
            customer_name: p.customer_name,
            description: p.description,
            amount: p.amount,
            invoice_refs: p.invoice_refs,
          })),
        },
      };

      batches.push(batchData);
      if (dup.possible_duplicate) skippedDuplicates += 1;
      processed += 1;
    } catch {
      errors += 1;
    }
  }

  const period = await getCurrentPeriodInfo(operaDb);

  return {
    success: true,
    total_emails: emails.length,
    parsed_count: processed,
    error_count: errors,
    skipped_wrong_company: skippedWrongCompany,
    skipped_already_imported: skippedAlreadyImported,
    skipped_duplicates: skippedDuplicates,
    company_reference: companyRef,
    current_period: {
      year: period.np_year,
      period: period.np_perno,
    },
    batches,
  };
}
