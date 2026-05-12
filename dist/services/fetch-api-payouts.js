import { getHomeCurrency, validatePostingPeriod, } from '../_shared/index.js';
import { isGocardlessPayoutImported, isGocardlessReferenceImported, } from './import-history.js';
import { checkOrphanedImports } from './restore-recovery.js';
import { matchPaymentsHelper, } from './match-customers.js';
function refSuffix(ref) {
    if (!ref)
        return '';
    if (ref.includes('-'))
        return ref.split('-').pop();
    return ref.slice(-8);
}
function formatDate(d) {
    if (!d)
        return '';
    if (d instanceof Date) {
        const dd = String(d.getDate()).padStart(2, '0');
        const mm = String(d.getMonth() + 1).padStart(2, '0');
        return `${dd}/${mm}/${d.getFullYear()}`;
    }
    const s = String(d).slice(0, 10); // YYYY-MM-DD
    const [y, m, dy] = s.split('-');
    if (y && m && dy)
        return `${dy}/${m}/${y}`;
    return s;
}
function bankFilterSqlParts(gcBankCode, destBankCode) {
    const codes = [gcBankCode, destBankCode]
        .map((b) => (b ?? '').trim())
        .filter((b) => b.length > 0);
    if (codes.length === 0)
        return { sql: '', params: [] };
    const placeholders = codes.map(() => '?').join(',');
    return {
        sql: `AND ae_acnt IN (${placeholders})`,
        params: codes,
    };
}
/** Reference-match duplicate lookup (for both foreign & GBP paths). */
async function findOperaByReference(operaDb, refSuffixValue, bankFilter) {
    if (!refSuffixValue)
        return null;
    try {
        const rows = (await operaDb.raw(`SELECT TOP 1 ae_entref, ae_value, at_pstdate AS at_date
         FROM aentry WITH (NOLOCK)
         JOIN atran WITH (NOLOCK) ON ae_acnt = at_acnt AND ae_cntr = at_cntr
              AND ae_cbtype = at_cbtype AND ae_entry = at_entry
        WHERE at_type IN (1, 4, 6)
          AND ae_value > 0
          AND RTRIM(ae_entref) LIKE ?
          ${bankFilter.sql}
        ORDER BY at_pstdate DESC`, [`%${refSuffixValue}%`, ...bankFilter.params]));
        return Array.isArray(rows) && rows.length > 0 ? rows[0] : null;
    }
    catch {
        return null;
    }
}
/**
 * Amount + date-proximity duplicate lookup (GBP only). Only flags
 * matches within ±14 days to avoid false positives on round amounts.
 */
async function findOperaByGrossDate(operaDb, grossPence, payoutDate, bankFilter) {
    if (!grossPence || !payoutDate)
        return null;
    try {
        const rows = (await operaDb.raw(`SELECT TOP 1 ae_value, at_pstdate AS at_date, ae_entref
         FROM aentry WITH (NOLOCK)
         JOIN atran WITH (NOLOCK) ON ae_acnt = at_acnt AND ae_cntr = at_cntr
              AND ae_cbtype = at_cbtype AND ae_entry = at_entry
        WHERE at_type IN (1, 4, 6)
          AND ae_value > 0
          AND ABS(ae_value - ?) <= 1
          AND ABS(DATEDIFF(day, at_pstdate, ?)) <= 14
          ${bankFilter.sql}
        ORDER BY at_pstdate DESC`, [grossPence, payoutDate, ...bankFilter.params]));
        return Array.isArray(rows) && rows.length > 0 ? rows[0] : null;
    }
    catch {
        return null;
    }
}
async function runPool(concurrency, items, worker) {
    if (items.length === 0)
        return;
    const queue = items.slice();
    const inflight = [];
    while (queue.length > 0 || inflight.length > 0) {
        while (inflight.length < concurrency && queue.length > 0) {
            const it = queue.shift();
            const p = worker(it).finally(() => {
                const idx = inflight.indexOf(p);
                if (idx >= 0)
                    inflight.splice(idx, 1);
            });
            inflight.push(p);
        }
        if (inflight.length > 0)
            await Promise.race(inflight);
    }
}
/** Wrap getPayouts() raw response to the slim shape this service uses. */
function pickRawPayouts(payouts) {
    return payouts.map((p) => ({
        id: String(p.id ?? ''),
        reference: typeof p.reference === 'string' ? p.reference : '',
        currency: typeof p.currency === 'string' ? p.currency : 'GBP',
        amount: typeof p.amount === 'number' ? p.amount : Number(p.amount ?? 0),
        arrival_date: typeof p.arrival_date === 'string' ? p.arrival_date : undefined,
    }));
}
export async function fetchGocardlessApiPayouts(appDb, operaDb, client, environment, input) {
    const status = input.status ?? 'paid';
    const limit = input.limit ?? 20;
    const daysBack = input.daysBack ?? 30;
    const targetSystem = input.targetSystem ?? 'opera_se';
    const companyRef = (input.companyReference ?? '').trim();
    // Date window — full ISO datetime (bare YYYY-MM-DD is rejected by GoCardless)
    const since = new Date();
    since.setUTCDate(since.getUTCDate() - daysBack);
    const createdAtGte = `${since.toISOString().slice(0, 10)}T00:00:00Z`;
    const listResult = await client.getPayouts({ status, limit, createdAtGte });
    if (!listResult.success) {
        return { success: false, error: listResult.error };
    }
    const homeCurrency = (await getHomeCurrency(operaDb).catch(() => ({
        code: 'GBP',
    }))).code;
    const rawPayouts = pickRawPayouts(listResult.payouts);
    const filterStats = {
        total_from_api: rawPayouts.length,
        filtered_duplicate_in_opera: 0,
        filtered_already_in_history: 0,
        filtered_period_closed: 0,
        filtered_all_payments_excluded: 0,
        filtered_error: 0,
        error_details: [],
        included: 0,
    };
    // === EARLY FILTERING ===
    // History dedup + company-reference prefix check, before any
    // expensive get_payout_with_payments() calls.
    const payoutsToFetch = [];
    for (const payout of rawPayouts) {
        // History dedup — by payout_id or by reference
        try {
            if (await isGocardlessPayoutImported(appDb, payout.id, targetSystem)) {
                filterStats.filtered_already_in_history += 1;
                continue;
            }
            if (payout.reference &&
                (await isGocardlessReferenceImported(appDb, payout.reference, targetSystem))) {
                filterStats.filtered_already_in_history += 1;
                continue;
            }
        }
        catch {
            // advisory — proceed
        }
        // Company-reference prefix gate
        if (companyRef && payout.reference) {
            const payoutCompany = payout.reference.split('-')[0].toUpperCase();
            const ref = companyRef.toUpperCase();
            if (!payoutCompany.includes(ref) && !ref.includes(payoutCompany)) {
                filterStats.filtered_all_payments_excluded += 1;
                continue;
            }
        }
        payoutsToFetch.push(payout);
    }
    // === PARALLEL FETCH ===
    const fullPayouts = new Map();
    await runPool(5, payoutsToFetch, async (p) => {
        try {
            const fp = await client.getPayoutWithPayments(p.id);
            if (fp)
                fullPayouts.set(p.id, fp);
        }
        catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            if (!msg.toLowerCase().includes('archived')) {
                filterStats.error_details.push(`${p.id}: ${msg.slice(0, 200)}`);
            }
            filterStats.filtered_error += 1;
        }
    });
    const bankFilter = bankFilterSqlParts(input.gcBankCode, input.destBankCode);
    const batches = [];
    // Iterate in original date order
    for (const payout of payoutsToFetch) {
        const fullPayout = fullPayouts.get(payout.id);
        if (!fullPayout)
            continue;
        try {
            const isForeignCurrency = fullPayout.currency.toUpperCase() !== homeCurrency.toUpperCase();
            let possibleDuplicate = false;
            let isDefiniteDuplicate = false;
            let isValueMismatch = false;
            let bankTxWarning = null;
            const grossPence = Math.round(fullPayout.gross_amount * 100);
            const refSuffixValue = refSuffix(fullPayout.reference);
            try {
                if (isForeignCurrency) {
                    // FX path: reference-only match (amounts won't agree)
                    const row = await findOperaByReference(operaDb, refSuffixValue, bankFilter);
                    if (row) {
                        isDefiniteDuplicate = true;
                        possibleDuplicate = true;
                        const dateStr = formatDate(row.at_date);
                        bankTxWarning = `Already posted - ref '${refSuffixValue}' found: £${(Number(row.ae_value) / 100).toFixed(2)} on ${dateStr} (note: foreign currency, GBP equivalent)`;
                    }
                }
                else {
                    // GBP path
                    const row = await findOperaByReference(operaDb, refSuffixValue, bankFilter);
                    if (row) {
                        const operaValuePence = Number(row.ae_value);
                        const dateStr = formatDate(row.at_date);
                        if (Math.abs(operaValuePence - grossPence) <= 100) {
                            isDefiniteDuplicate = true;
                            possibleDuplicate = true;
                            bankTxWarning = `Already posted - ref '${refSuffixValue}': £${(operaValuePence / 100).toFixed(2)} on ${dateStr}`;
                        }
                        else {
                            isValueMismatch = true;
                            bankTxWarning = `Value mismatch - ref '${refSuffixValue}' in Opera: £${(operaValuePence / 100).toFixed(2)} on ${dateStr}, GC gross: £${(grossPence / 100).toFixed(2)}`;
                        }
                    }
                    if (!possibleDuplicate && grossPence > 0 && fullPayout.arrival_date) {
                        const gross = await findOperaByGrossDate(operaDb, grossPence, fullPayout.arrival_date, bankFilter);
                        if (gross) {
                            possibleDuplicate = true;
                            const dateStr = formatDate(gross.at_date);
                            const ref = (gross.ae_entref ?? '').toString().trim() || 'N/A';
                            bankTxWarning = `Already posted - gross amount: £${(Number(gross.ae_value) / 100).toFixed(2)} on ${dateStr} (ref: ${ref})`;
                        }
                    }
                }
            }
            catch {
                // advisory: skip duplicate check if it errors, but include payout
            }
            if (isDefiniteDuplicate) {
                filterStats.filtered_duplicate_in_opera += 1;
                continue;
            }
            // Period gate
            let periodValid = true;
            let periodError = null;
            if (fullPayout.arrival_date) {
                try {
                    const r = await validatePostingPeriod(operaDb, fullPayout.arrival_date, 'SL');
                    periodValid = r.is_valid;
                    if (!periodValid)
                        periodError = r.error_message ?? null;
                }
                catch {
                    // advisory
                }
            }
            if (!periodValid) {
                filterStats.filtered_period_closed += 1;
                continue;
            }
            // Build payments + match to Opera customers
            const allPayments = fullPayout.payments.map((p) => ({
                customer_name: p.customer_name || 'Not provided',
                description: p.description || p.reference || '',
                amount: p.amount,
                customer_id: p.customer_id ?? '',
                mandate_id: p.mandate_id ?? '',
                gc_payment_id: p.id ?? '',
                metadata: p.metadata ?? {},
            }));
            let matchedPayments = allPayments.map((p) => ({ ...p }));
            if (allPayments.length > 0) {
                const matchResult = await matchPaymentsHelper(appDb, operaDb, allPayments);
                if (matchResult.success) {
                    matchedPayments = matchResult.payments.map((p) => ({ ...p }));
                }
            }
            if (matchedPayments.length === 0) {
                filterStats.filtered_all_payments_excluded += 1;
                continue;
            }
            const payoutGross = fullPayout.gross_amount;
            const payoutFees = fullPayout.deducted_fees;
            const payoutVat = fullPayout.fees_vat ?? 0;
            const payoutNet = payoutGross - payoutFees;
            let importStatus = 'ready';
            let importStatusMessage = null;
            if (isForeignCurrency) {
                importStatus = 'needs_manual_posting';
                importStatusMessage = `Foreign currency (${fullPayout.currency}) - cannot auto-import, needs manual posting in Opera`;
            }
            else if (!periodValid) {
                importStatus = 'period_closed';
                importStatusMessage = periodError;
            }
            else if (isValueMismatch) {
                importStatus = 'value_mismatch';
                importStatusMessage = bankTxWarning;
            }
            else if (possibleDuplicate) {
                importStatus = 'review_duplicate';
                importStatusMessage = bankTxWarning;
            }
            batches.push({
                payout_id: fullPayout.id,
                source: 'api',
                possible_duplicate: possibleDuplicate,
                is_value_mismatch: isValueMismatch,
                bank_tx_warning: bankTxWarning,
                period_valid: periodValid,
                period_error: periodError,
                is_foreign_currency: isForeignCurrency,
                home_currency: homeCurrency,
                import_status: importStatus,
                import_status_message: importStatusMessage,
                batch: {
                    gross_amount: payoutGross,
                    gocardless_fees: payoutFees,
                    vat_on_fees: payoutVat,
                    net_amount: payoutNet,
                    bank_reference: fullPayout.reference,
                    currency: fullPayout.currency,
                    payment_date: fullPayout.arrival_date,
                    payment_count: matchedPayments.length,
                    payments: matchedPayments,
                    fx_amount: fullPayout.fx_amount,
                    fx_currency: fullPayout.fx_currency,
                    exchange_rate: fullPayout.exchange_rate,
                    dest_bank_account: fullPayout.bank_account_number,
                    dest_bank_sort_code: fullPayout.bank_sort_code,
                },
            });
            filterStats.included += 1;
        }
        catch (err) {
            filterStats.filtered_error += 1;
            const msg = err instanceof Error ? err.message : String(err);
            filterStats.error_details.push(`${payout.id}: ${msg.slice(0, 200)}`);
        }
    }
    // Surface any orphaned `gocardless_imports` rows so the UI can show
    // a restore-detected banner without needing a separate call.
    let orphanCheck = {
        detected: false,
        count: 0,
        summary: [],
    };
    try {
        const result = await checkOrphanedImports(operaDb, appDb);
        if (result.success && result.orphans.length > 0) {
            orphanCheck = {
                detected: true,
                count: result.orphans.length,
                summary: result.orphans.slice(0, 10).map((o) => ({
                    bank_reference: o.bank_reference,
                    gross_amount: o.gross_amount,
                })),
            };
        }
    }
    catch {
        // best-effort — never block the payouts response on orphan check
    }
    return {
        success: true,
        source: 'api',
        environment,
        total_payouts: batches.length,
        filter_stats: filterStats,
        batches,
        orphan_check: orphanCheck,
    };
}
//# sourceMappingURL=fetch-api-payouts.js.map