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
    current_period?: {
        year: number | null;
        period: number | null;
    };
    batches?: ScannedBatch[];
    error?: string;
}
export declare function scanGocardlessEmails(operaDb: Knex, appDb: Knex, mailbox: EmailMailboxAdapter, input: ScanEmailsInput): Promise<ScanEmailsResponse>;
//# sourceMappingURL=scan-emails.d.ts.map