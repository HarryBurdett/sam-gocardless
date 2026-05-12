import { validatePostingPeriod, getCurrentPeriodInfo, getHomeCurrency, } from '../_shared/index.js';
function parsePaymentDate(input) {
    if (!input || typeof input !== 'string')
        return null;
    const trimmed = input.slice(0, 10);
    if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed))
        return trimmed;
    return null;
}
function refSuffix(bankReference) {
    if (bankReference.includes('-')) {
        const parts = bankReference.split('-');
        return parts[parts.length - 1] ?? '';
    }
    return bankReference.slice(-8);
}
function formatGbp(pence) {
    return (Math.abs(Math.trunc(pence)) / 100).toFixed(2);
}
function formatDate(d) {
    if (d instanceof Date) {
        const dd = String(d.getUTCDate()).padStart(2, '0');
        const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
        const yyyy = d.getUTCFullYear();
        return `${dd}/${mm}/${yyyy}`;
    }
    if (typeof d === 'string')
        return d.slice(0, 10);
    return '';
}
export async function revalidateBatches(operaDb, batches) {
    try {
        const currentPeriodInfo = await getCurrentPeriodInfo(operaDb);
        const homeCurrency = await getHomeCurrency(operaDb);
        const out = [];
        for (const batch of batches) {
            const data = batch.batch ?? {};
            const grossAmount = Number(data.gross_amount ?? 0);
            const bankReference = String(data.bank_reference ?? '');
            const paymentDate = parsePaymentDate(data.payment_date);
            const currency = String(data.currency ?? 'GBP');
            const isForeign = currency.toUpperCase() !== homeCurrency.code.toUpperCase();
            // Period validation
            let periodValid = true;
            let periodError = null;
            if (paymentDate) {
                try {
                    const result = await validatePostingPeriod(operaDb, paymentDate, 'SL');
                    periodValid = result.is_valid;
                    if (!periodValid)
                        periodError = result.error_message ?? null;
                }
                catch (e) {
                    // Period validation failures shouldn't fail the whole revalidation
                    periodValid = true;
                    periodError = null;
                }
            }
            // Duplicate detection
            let possibleDuplicate = false;
            let bankWarning = null;
            try {
                const grossPence = Math.round(grossAmount * 100);
                if (isForeign) {
                    // Foreign currency — reference-only check (no amount comparison
                    // because amount fields are GBP equivalents)
                    if (bankReference) {
                        const suffix = refSuffix(bankReference);
                        const rows = (await operaDb.raw(`SELECT TOP 1 ae_entref, at_value, at_pstdate as at_date
               FROM aentry WITH (NOLOCK)
               JOIN atran WITH (NOLOCK) ON ae_acnt = at_acnt AND ae_cntr = at_cntr
                 AND ae_cbtype = at_cbtype AND ae_entry = at_entry
               WHERE at_type IN (1, 4, 6)
                 AND at_value > 0
                 AND RTRIM(ae_entref) LIKE ?
               ORDER BY at_pstdate DESC`, [`%${suffix}%`]));
                        if (Array.isArray(rows) && rows.length > 0 && rows[0]) {
                            possibleDuplicate = true;
                            bankWarning =
                                `Already posted - ref '${suffix}' found: £${formatGbp(Number(rows[0].at_value ?? 0))}` +
                                    ` on ${formatDate(rows[0].at_date ?? null)} (note: foreign currency, GBP equivalent)`;
                        }
                    }
                }
                else {
                    // GBP — reference + amount (within £1.00 = 100p)
                    if (bankReference) {
                        const suffix = refSuffix(bankReference);
                        const rows = (await operaDb.raw(`SELECT TOP 1 ae_entref, at_value, at_pstdate as at_date
               FROM aentry WITH (NOLOCK)
               JOIN atran WITH (NOLOCK) ON ae_acnt = at_acnt AND ae_cntr = at_cntr
                 AND ae_cbtype = at_cbtype AND ae_entry = at_entry
               WHERE at_type IN (1, 4, 6)
                 AND RTRIM(ae_entref) LIKE ?
                 AND ABS(at_value - ?) <= 100
               ORDER BY at_pstdate DESC`, [`%${suffix}%`, grossPence]));
                        if (Array.isArray(rows) && rows.length > 0 && rows[0]) {
                            possibleDuplicate = true;
                            bankWarning =
                                `Already posted - ref '${suffix}': £${formatGbp(Number(rows[0].at_value ?? 0))}` +
                                    ` on ${formatDate(rows[0].at_date ?? null)}`;
                        }
                    }
                    // Fallback: amount alone within 14 days, 1p tolerance
                    if (!possibleDuplicate && grossPence > 0 && paymentDate) {
                        const rows = (await operaDb.raw(`SELECT TOP 1 at_value, at_pstdate as at_date, ae_entref
               FROM atran WITH (NOLOCK)
               JOIN aentry WITH (NOLOCK) ON ae_acnt = at_acnt AND ae_cntr = at_cntr
                 AND ae_cbtype = at_cbtype AND ae_entry = at_entry
               WHERE at_type IN (1, 4, 6)
                 AND at_value > 0
                 AND ABS(at_value - ?) <= 1
                 AND ABS(DATEDIFF(day, at_pstdate, ?)) <= 14
               ORDER BY at_pstdate DESC`, [grossPence, paymentDate]));
                        if (Array.isArray(rows) && rows.length > 0 && rows[0]) {
                            possibleDuplicate = true;
                            const ref = (rows[0].ae_entref ?? '').toString().trim() || 'N/A';
                            bankWarning =
                                `Already posted - gross amount: £${formatGbp(Number(rows[0].at_value ?? 0))}` +
                                    ` on ${formatDate(rows[0].at_date ?? null)} (ref: ${ref})`;
                        }
                    }
                }
            }
            catch {
                // Duplicate check is best-effort
            }
            out.push({
                ...batch,
                period_valid: periodValid,
                period_error: periodError,
                possible_duplicate: possibleDuplicate,
                bank_tx_warning: bankWarning,
                is_foreign_currency: isForeign,
                home_currency: homeCurrency.code,
            });
        }
        return {
            success: true,
            batches: out,
            current_period: {
                year: currentPeriodInfo.np_year,
                period: currentPeriodInfo.np_perno,
            },
            message: `Revalidated ${out.length} batch(es) against Opera`,
        };
    }
    catch (err) {
        return {
            success: false,
            batches: [],
            current_period: null,
            error: err?.message ?? String(err),
        };
    }
}
//# sourceMappingURL=revalidate-batches.js.map