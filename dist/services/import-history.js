function parseJsonOrEmpty(raw) {
    if (!raw)
        return null;
    try {
        return JSON.parse(raw);
    }
    catch {
        return null;
    }
}
function dateToYmd(d) {
    if (!d)
        return null;
    if (d instanceof Date) {
        if (Number.isNaN(d.getTime()))
            return null;
        const yr = d.getFullYear();
        const mo = String(d.getMonth() + 1).padStart(2, '0');
        const da = String(d.getDate()).padStart(2, '0');
        return `${yr}-${mo}-${da}`;
    }
    return String(d).slice(0, 10);
}
export async function getImportHistory(appDb, operaDb, opts = {}) {
    const limit = opts.limit ?? 50;
    const targetSystem = opts.targetSystem ?? 'opera_se';
    try {
        let query = appDb('gocardless_imports')
            .where({ target_system: targetSystem })
            .orderBy('payment_date', 'desc')
            .orderBy('imported_at', 'desc')
            .limit(limit);
        if (opts.fromDate)
            query = query.andWhere('payment_date', '>=', opts.fromDate);
        if (opts.toDate)
            query = query.andWhere('payment_date', '<=', opts.toDate);
        const rows = (await query);
        if (!rows.length) {
            return { success: true, imports: [], total: 0 };
        }
        // Collect unique customer accounts for Opera-name enrichment
        const allAccounts = new Set();
        const parsedPaymentsByRow = new Map();
        for (const r of rows) {
            const payments = parseJsonOrEmpty(r.payments_json);
            const list = Array.isArray(payments)
                ? payments
                : [];
            parsedPaymentsByRow.set(r.id, list);
            for (const p of list) {
                const acct = String(p.customer_account ?? '').trim();
                if (acct)
                    allAccounts.add(acct);
            }
        }
        // Enrich with Opera customer names
        const operaNames = new Map();
        if (allAccounts.size > 0 && operaDb) {
            try {
                const codes = [...allAccounts];
                // Use ANY (not parameterised IN since list size varies); safe because
                // codes come from our own DB.
                const placeholders = codes.map(() => '?').join(',');
                const nameRows = (await operaDb.raw(`SELECT sn_account, sn_name FROM sname WITH (NOLOCK) WHERE sn_account IN (${placeholders})`, codes));
                for (const row of Array.isArray(nameRows) ? nameRows : []) {
                    const acct = (row.sn_account ?? '').trim();
                    const name = (row.sn_name ?? '').trim();
                    if (acct && name)
                        operaNames.set(acct, name);
                }
            }
            catch {
                // Enrichment failure is non-fatal — caller still gets the raw
                // history without enriched names.
            }
        }
        // Enrich with GoCardless mandate names (opera_account → customer_name)
        const gcNames = new Map();
        if (allAccounts.size > 0) {
            try {
                const mandateRows = (await appDb('gocardless_mandates')
                    .select('opera_account', 'customer_name')
                    .whereIn('opera_account', [...allAccounts]));
                for (const row of mandateRows) {
                    const acct = (row.opera_account ?? '').trim();
                    const name = (row.customer_name ?? '').trim();
                    if (acct && name)
                        gcNames.set(acct, name);
                }
            }
            catch {
                // Non-fatal
            }
        }
        const history = rows.map((r) => {
            const payments = parsedPaymentsByRow.get(r.id) ?? [];
            // Enrich each payment in-place with opera_customer_name + gc_customer_name
            const enrichedPayments = payments.map((p) => {
                const acct = String(p.customer_account ?? '').trim();
                const out = { ...p };
                if (acct) {
                    if (!out.opera_customer_name && operaNames.has(acct)) {
                        out.opera_customer_name = operaNames.get(acct);
                    }
                    if (!out.gc_customer_name && gcNames.has(acct)) {
                        out.gc_customer_name = gcNames.get(acct);
                    }
                }
                return out;
            });
            const refs = parseJsonOrEmpty(r.opera_entry_refs);
            return {
                id: r.id,
                bank_reference: r.bank_reference ?? '',
                payment_date: dateToYmd(r.payment_date),
                gross_amount: Number(r.gross_amount ?? 0),
                fees_amount: Number(r.fees_amount ?? 0),
                vat_on_fees: Number(r.vat_on_fees ?? 0),
                net_amount: Number(r.net_amount ?? 0),
                currency: r.currency ?? 'GBP',
                bank_code: r.bank_code ?? '',
                cbtype: r.cbtype ?? '',
                imported_by: r.imported_by ?? '',
                imported_at: r.imported_at instanceof Date
                    ? r.imported_at.toISOString()
                    : String(r.imported_at ?? ''),
                target_system: r.target_system ?? '',
                payments: enrichedPayments,
                opera_entry_refs: Array.isArray(refs) ? refs : [],
            };
        });
        return { success: true, imports: history, total: history.length };
    }
    catch (err) {
        return {
            success: false,
            imports: [],
            total: 0,
            error: err?.message ?? String(err),
        };
    }
}
/**
 * Has this payout already been imported (by payout_id)?
 *
 * Faithful port of `is_gocardless_payout_imported`
 * (api/email/storage.py). Optionally restricts to a specific
 * target_system ('opera_se' / 'opera3').
 */
export async function isGocardlessPayoutImported(appDb, payoutId, targetSystem) {
    if (!payoutId)
        return false;
    try {
        let q = appDb('gocardless_imports').where({ payout_id: payoutId });
        if (targetSystem)
            q = q.andWhere({ target_system: targetSystem });
        const row = await q.first();
        return !!row;
    }
    catch {
        return false;
    }
}
/**
 * Has this bank reference already been imported?
 *
 * Matches exact reference, or reference with a currency-suffix
 * (e.g. `INTSYSUKLTD-XYZ (EUR)`), exactly like the Python port.
 */
export async function isGocardlessReferenceImported(appDb, bankReference, targetSystem) {
    if (!bankReference)
        return false;
    const refLike = `${bankReference} (%`;
    try {
        let q = appDb('gocardless_imports').where(function () {
            this.where('bank_reference', bankReference).orWhere('bank_reference', 'like', refLike);
        });
        if (targetSystem)
            q = q.andWhere({ target_system: targetSystem });
        const row = await q.first();
        return !!row;
    }
    catch {
        return false;
    }
}
//# sourceMappingURL=import-history.js.map