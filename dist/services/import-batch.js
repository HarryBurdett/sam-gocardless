import { validateAccountCode, validateBankCode, validateCbtype, SqlInputValidationError, validatePostingPeriod, getHomeCurrency, } from '../_shared/index.js';
import { isPayoutImported } from './import-idempotency.js';
import { checkOrphanedImports } from './restore-recovery.js';
function parseYmd(input) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(input.trim());
    if (!m)
        return null;
    return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
}
function normaliseSortCode(s) {
    return (s ?? '').replace(/[\s-]/g, '').trim();
}
function normaliseAccountNumber(s) {
    return (s ?? '').replace(/\s/g, '').trim();
}
async function bankExists(operaDb, bankCode) {
    try {
        const row = (await operaDb('nbank')
            .whereRaw('RTRIM(nk_acnt) = ?', [bankCode])
            .select('nk_acnt')
            .first());
        return !!row;
    }
    catch {
        return false;
    }
}
async function listBanks(operaDb) {
    try {
        return (await operaDb('nbank')
            .select('nk_acnt', operaDb.raw('RTRIM(nk_desc) as nk_desc'), operaDb.raw('RTRIM(nk_sort) as nk_sort'), operaDb.raw('RTRIM(nk_number) as nk_number')));
    }
    catch {
        return [];
    }
}
export async function resolveDestinationBank(operaDb, bankCode, destBankSortCode, destBankAccount) {
    if (!destBankSortCode && !destBankAccount)
        return bankCode;
    const normSort = normaliseSortCode(destBankSortCode);
    const normAcct = normaliseAccountNumber(destBankAccount);
    if (!normSort && !normAcct)
        return bankCode;
    const banks = await listBanks(operaDb);
    for (const b of banks) {
        const dbSort = normaliseSortCode(b.nk_sort);
        const dbAcct = normaliseAccountNumber(b.nk_number);
        const sortMatch = !!normSort && !!dbSort && normSort === dbSort;
        const acctMatch = !!normAcct &&
            !!dbAcct &&
            (dbAcct.endsWith(normAcct) ||
                normAcct.endsWith(dbAcct) ||
                dbAcct === normAcct);
        if (sortMatch && acctMatch)
            return (b.nk_acnt ?? '').trim();
        if (sortMatch && !normAcct)
            return (b.nk_acnt ?? '').trim();
    }
    return bankCode;
}
export async function validateImportRequest(operaDb, appDb, input, settings, knownMandates) {
    let bankCode;
    let cbtype = null;
    let feesNominalAccount = null;
    try {
        bankCode = validateBankCode(input.bankCode);
        if (input.cbtype) {
            cbtype = validateCbtype(input.cbtype);
        }
        if (input.feesNominalAccount) {
            feesNominalAccount = validateAccountCode(input.feesNominalAccount);
        }
    }
    catch (e) {
        if (e instanceof SqlInputValidationError) {
            return { success: false, error: e.message };
        }
        return { success: false, error: e?.message ?? String(e) };
    }
    if (!input.payments || input.payments.length === 0) {
        return { success: false, error: 'No payments provided' };
    }
    if (input.payoutId) {
        // Scope idempotency to the target Opera system so opera_se imports
        // can't collide with opera_3 imports. Audit HIGH: previously called
        // with no opts → MANUAL-* skipped rows also blocked re-import.
        const alreadyImported = await isPayoutImported(appDb, input.payoutId, {
            targetSystem: 'opera_se',
        });
        if (alreadyImported) {
            // Orphan-aware check: if the gocardless_imports row references Opera
            // entries that no longer exist (Opera SQL restore, manual deletion in
            // Opera Cashbook), the user genuinely needs to re-post — block only
            // when Opera still has the underlying entry.
            let isOrphan = false;
            try {
                const orphanResult = await checkOrphanedImports(operaDb, appDb);
                if (orphanResult.success) {
                    isOrphan = orphanResult.orphans.some((o) => o.payout_id === input.payoutId);
                }
            }
            catch {
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
    const validatedPayments = [];
    for (let idx = 0; idx < input.payments.length; idx++) {
        const p = input.payments[idx];
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
    const mandateToAccount = new Map();
    for (const m of knownMandates) {
        const mid = (m.mandate_id ?? '').trim();
        const acct = (m.opera_account ?? '').trim();
        if (mid && acct && acct !== '__UNLINKED__') {
            mandateToAccount.set(mid, acct);
        }
    }
    for (let idx = 0; idx < validatedPayments.length; idx++) {
        const vp = validatedPayments[idx];
        const postingAccount = vp.customer_account.trim();
        const mid = vp.mandate_id.trim();
        if (mid && mandateToAccount.has(mid)) {
            const expected = mandateToAccount.get(mid);
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
    }
    catch (e) {
        return {
            success: false,
            error: `Period validation failed: ${e?.message ?? String(e)}`,
        };
    }
    const goCardlessFees = Number(input.goCardlessFees ?? 0);
    if (goCardlessFees > 0 && !feesNominalAccount) {
        return {
            success: false,
            error: `GoCardless fees of £${goCardlessFees.toFixed(2)} cannot be posted: Fees Nominal Account not configured. Please configure the Fees Nominal Account in GoCardless Settings before importing.`,
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
        }
        catch {
            // Home currency lookup failure is non-fatal — proceed.
        }
    }
    const gcBank = (settings.gocardless_bank_code ?? '').trim();
    const transferCbtype = (settings.gocardless_transfer_cbtype ?? '').trim();
    const resolvedDest = await resolveDestinationBank(operaDb, bankCode, input.destBankSortCode ?? null, input.destBankAccount ?? null);
    let destinationBank = null;
    if (gcBank && resolvedDest !== gcBank) {
        destinationBank = resolvedDest;
    }
    const postingBank = gcBank || resolvedDest;
    for (const b of [postingBank, destinationBank].filter((b) => !!b)) {
        if (!(await bankExists(operaDb, b))) {
            const label = b === postingBank ? 'GC Control bank' : 'Destination bank';
            return {
                success: false,
                error: `${label} '${b}' does not exist in this company's bank accounts. Please update GoCardless Settings with valid bank codes for this company.`,
            };
        }
    }
    const warnings = [];
    const seen = new Map();
    for (let idx = 0; idx < validatedPayments.length; idx++) {
        const p = validatedPayments[idx];
        const key = `${p.customer_account}:${p.amount.toFixed(2)}`;
        const existing = seen.get(key) ?? [];
        existing.push(idx);
        seen.set(key, existing);
    }
    for (const [key, indices] of seen) {
        if (indices.length > 1) {
            const [acct, amt] = key.split(':');
            warnings.push(`Duplicate: ${acct} appears ${indices.length} times for £${amt} (payments ${indices.map((i) => i + 1).join(', ')}). Please verify each payment is matched to the correct customer.`);
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
            // Operator code: default 'GOCARDLS'; slice to 10 (ntran.nt_inp
            // width) here so downstream INSERTs only need to re-slice for
            // narrower fields. Audit-trail fix per audit HIGH.
            inputBy: (input.inputBy ?? '').trim().slice(0, 10) || 'GOCARDLS',
            warnings,
        },
    };
}
async function recordImportHistory(appDb, args) {
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
    }
    catch (err) {
        // History write failure is non-fatal at the import level (Python
        // logs warning then proceeds), but we DO surface the error so it
        // can be picked up in logs rather than silently dropping every
        // import row like the previous version did.
        // eslint-disable-next-line no-console
        console.warn(`[gocardless] recordImportHistory failed for payout ${args.payoutId}: ${err instanceof Error ? err.message : String(err)}`);
    }
}
export async function importGocardlessBatch(operaDb, appDb, input, settings, knownMandates, executor, importLock) {
    const validation = await validateImportRequest(operaDb, appDb, input, settings, knownMandates);
    if (!validation.success) {
        const failure = validation;
        const out = {
            success: false,
            error: failure.error,
        };
        if (failure.duplicate_payout)
            out.duplicate_payout = true;
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
        const grossAmount = request.payments.reduce((acc, p) => acc + p.amount, 0);
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
            paymentsJson: JSON.stringify(request.payments.map((p) => ({
                customer_account: p.customer_account,
                gc_customer_name: p.customer_name,
                opera_customer_name: p.opera_customer_name,
                amount: p.amount,
                description: p.description,
            }))),
            batchRef: result.batch_ref ?? null,
            // Thread the validated operator code through audit history.
            importedBy: request.inputBy || 'GOCARDLS',
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
    }
    finally {
        try {
            await importLock.release(lockKey);
        }
        catch {
            // best-effort
        }
    }
}
//# sourceMappingURL=import-batch.js.map