import { getCurrentPeriodInfo, getHomeCurrency, validatePostingPeriod, } from '../_shared/index.js';
import { parseGocardlessEmail, } from './parser.js';
import { checkDuplicateBatch } from './duplicate-detection.js';
import { getImportedEmailIds, getImportedReferences, } from './import-idempotency.js';
function parseDateOrNull(input) {
    if (!input)
        return null;
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(input.trim());
    if (!m)
        return null;
    return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
}
function emailHasPayoutKeyword(subject) {
    const lower = subject.toLowerCase();
    return ['payout', 'payment', 'collected', 'paid'].some((kw) => lower.includes(kw));
}
function batchPaymentDateString(batch) {
    if (!batch.payment_date)
        return null;
    return batch.payment_date.toISOString().slice(0, 10);
}
export async function scanGocardlessEmails(operaDb, appDb, mailbox, input) {
    if (mailbox.sync) {
        try {
            await Promise.race([
                mailbox.sync(),
                new Promise((_, reject) => setTimeout(() => reject(new Error('sync timeout')), 30_000)),
            ]);
        }
        catch {
            // continue with cached emails
        }
    }
    const companyRef = (input.companyReferenceOverride ??
        input.companyReference ??
        '')
        .toString()
        .trim();
    const fromDate = parseDateOrNull(input.fromDate ?? null);
    const toDate = parseDateOrNull(input.toDate ?? null);
    let importedEmailIds = new Set();
    let importedReferences = new Set();
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
    const batches = [];
    let processed = 0;
    let errors = 0;
    let skippedWrongCompany = 0;
    let skippedAlreadyImported = 0;
    let skippedDuplicates = 0;
    for (const email of emails) {
        try {
            const emailId = Number(email.id);
            if (!input.includeProcessed &&
                Number.isFinite(emailId) &&
                importedEmailIds.has(emailId)) {
                skippedAlreadyImported += 1;
                continue;
            }
            const content = email.body_text || email.body_html || '';
            if (!content)
                continue;
            const subject = (email.subject ?? '').toString();
            if (!emailHasPayoutKeyword(subject))
                continue;
            const batch = parseGocardlessEmail(content);
            if (batch.payments.length === 0)
                continue;
            if (companyRef) {
                const batchRef = (batch.bank_reference ?? '').toUpperCase();
                const ref = companyRef.toUpperCase();
                const matchesRef = batchRef.includes(ref) || (batchRef.length > 0 && ref.includes(batchRef));
                if (!matchesRef && !content.toUpperCase().includes(ref)) {
                    skippedWrongCompany += 1;
                    continue;
                }
            }
            if (batch.bank_reference &&
                importedReferences.has(batch.bank_reference)) {
                skippedAlreadyImported += 1;
                continue;
            }
            const isForeignCurrency = !!batch.currency &&
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
            let periodError = null;
            if (batch.payment_date) {
                try {
                    const r = await validatePostingPeriod(operaDb, batch.payment_date.toISOString().slice(0, 10), 'SL');
                    periodValid = r.is_valid;
                    if (!periodValid)
                        periodError = r.error_message ?? null;
                }
                catch {
                    // advisory
                }
            }
            const batchData = {
                email_id: Number.isFinite(emailId) ? emailId : null,
                email_subject: email.subject ?? null,
                email_date: email.received_at instanceof Date
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
            if (dup.possible_duplicate)
                skippedDuplicates += 1;
            processed += 1;
        }
        catch {
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
//# sourceMappingURL=scan-emails.js.map