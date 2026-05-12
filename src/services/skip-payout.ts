/**
 * Skip a GoCardless payout — record to history without importing.
 *
 * Faithful port of `skip_gocardless_payout` from
 * apps/gocardless/api/routes.py:3187.
 *
 * Used for:
 *   - Foreign currency payouts that need manual posting in Opera
 *   - Payouts already manually entered
 *   - Duplicate payouts
 *
 * The payout appears in import history with imported_by="MANUAL-*"
 * and won't show in the available-payouts list.
 */
import type { Knex } from 'knex';

const REASON_TO_IMPORTED_BY: Record<string, string> = {
  foreign_currency: 'MANUAL', // suffix added with currency below
  manual: 'MANUAL-SKIP',
  duplicate: 'MANUAL-DUP',
};

export interface SkipPayoutInput {
  payoutId: string;
  bankReference: string;
  grossAmount: number;
  currency?: string;
  paymentCount?: number;
  reason?: string;
  fxAmount?: number | null;
  payments?: Array<{
    matched_account?: string;
    customer_account?: string;
    customer_name?: string;
    amount?: number;
    description?: string;
  }>;
  targetSystem?: 'opera_se' | 'opera_3';
}

export interface SkipPayoutResponse {
  success: boolean;
  message?: string;
  record_id?: number;
  reason?: string;
  error?: string;
}

export async function skipPayout(
  appDb: Knex,
  input: SkipPayoutInput,
): Promise<SkipPayoutResponse> {
  try {
    const reason = input.reason ?? 'manual';
    const currency = (input.currency ?? 'GBP').toUpperCase();
    const targetSystem = input.targetSystem ?? 'opera_se';

    // Compose imported_by tag
    let importedBy: string;
    if (reason === 'foreign_currency') {
      importedBy = `MANUAL-${currency}`;
    } else {
      importedBy = REASON_TO_IMPORTED_BY[reason] ?? 'MANUAL-SKIP';
    }

    // Include currency in display reference for non-GBP
    const displayReference =
      currency && currency !== 'GBP'
        ? `${input.bankReference} (${currency})`
        : input.bankReference;

    // Serialise payment details if provided
    let paymentsJson: string | null = null;
    if (Array.isArray(input.payments) && input.payments.length > 0) {
      paymentsJson = JSON.stringify(
        input.payments.map((p) => ({
          customer_account: p.matched_account ?? p.customer_account ?? '',
          gc_customer_name: p.customer_name ?? '',
          amount: p.amount ?? 0,
          description: p.description ?? '',
        })),
      );
    }

    const inserted = await appDb('gocardless_imports')
      .insert({
        bank_reference: displayReference,
        payment_date: null, // skipped — no payout_date stored
        gross_amount: input.grossAmount,
        fees_amount: 0,
        vat_on_fees: 0,
        net_amount: input.grossAmount, // unknown for skipped — use gross
        currency: currency,
        bank_code: null,
        cbtype: null,
        payments_json: paymentsJson,
        opera_entry_refs: null,
        target_system: targetSystem,
        imported_by: importedBy,
      })
      .returning('id');

    const recordId = Array.isArray(inserted) && inserted.length > 0
      ? typeof inserted[0] === 'object'
        ? (inserted[0] as { id: number }).id
        : Number(inserted[0])
      : 0;

    return {
      success: true,
      message: `Payout ${input.bankReference} sent to history (needs manual posting)`,
      record_id: recordId,
      reason,
    };
  } catch (err: any) {
    return { success: false, error: err?.message ?? String(err) };
  }
}
