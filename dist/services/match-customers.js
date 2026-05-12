// ---------------------------------------------------------------------
// Name normalisation — faithful port of _normalize_company_name
// ---------------------------------------------------------------------
const COMPANY_SUFFIXES = [
    ' limited',
    ' ltd',
    ' ltd.',
    ' plc',
    ' inc',
    ' llp',
    ' lp',
    ' company',
    ' co',
    ' group',
    ' uk',
    ' holdings',
];
export function normalizeCompanyName(name) {
    let n = (name ?? '').toLowerCase().trim();
    // Strip parenthetical content
    n = n.replace(/\s*\([^)]*\)/g, '').trim();
    // Normalise " and " → " & "
    n = n.replace(/ and /g, ' & ');
    // Collapse two single letters separated by a space (I C → IC)
    n = n.replace(/\b([a-z])\s+([a-z])\b/g, '$1$2');
    // Strip common company suffixes
    for (const suffix of COMPANY_SUFFIXES) {
        if (n.endsWith(suffix)) {
            n = n.slice(0, -suffix.length).trim();
            break;
        }
    }
    // Strip trailing punctuation (.,)
    n = n.replace(/[.,]+$/, '');
    return n;
}
export async function matchPaymentsHelper(appDb, operaDb, payments) {
    try {
        // Load all mandates from per-app DB (faithful to payments_db.list_mandates())
        const allMandates = (await appDb('gocardless_mandates').select('opera_account', 'opera_name', 'gocardless_name', 'gocardless_customer_id', 'mandate_id', 'mandate_status'));
        const mandateById = new Map();
        const mandateByCustomer = new Map();
        const mandateByName = new Map();
        for (const m of allMandates) {
            const acct = (m.opera_account ?? '').trim();
            if (!acct || acct === '__UNLINKED__')
                continue;
            const mid = (m.mandate_id ?? '').trim();
            if (mid)
                mandateById.set(mid, m);
            const cid = (m.gocardless_customer_id ?? '').trim();
            if (cid)
                mandateByCustomer.set(cid, m);
            const operaName = (m.opera_name ?? '').trim();
            if (operaName)
                mandateByName.set(normalizeCompanyName(operaName), m);
            const gcName = (m.gocardless_name ?? '').trim();
            if (gcName)
                mandateByName.set(normalizeCompanyName(gcName), m);
        }
        // Load Opera customer name lookup (sname). Dormant + stopped excluded
        // per CLAUDE.md.
        const customers = new Map(); // account → name
        try {
            const rows = (await operaDb.raw(`
        SELECT sn_account, sn_name
        FROM sname WITH (NOLOCK)
        WHERE (sn_stop = 0 OR sn_stop IS NULL)
          AND (sn_dormant = 0 OR sn_dormant IS NULL)
      `));
            if (Array.isArray(rows)) {
                for (const r of rows) {
                    const acct = (r.sn_account ?? '').trim();
                    if (acct)
                        customers.set(acct, (r.sn_name ?? '').trim());
                }
            }
        }
        catch {
            // Ignore — matchers below handle empty customers map
        }
        const matched = [];
        let unmatchedCount = 0;
        const backfillUpdates = [];
        for (const payment of payments) {
            const customerName = (payment.customer_name ?? '').trim();
            const amount = Number(payment.amount ?? 0);
            const description = (payment.description ?? '').trim();
            const mandateId = (payment.mandate_id ?? '').trim();
            const customerId = (payment.customer_id ?? '').trim();
            const metadata = (payment.metadata ?? {});
            let bestMatch = null;
            let bestName = null;
            let matchMethod = null;
            let metadataInvoiceRefs = [];
            // Priority 0: metadata from GoCardless (when payment was created via this app)
            const metaAccount = String(metadata.opera_account ?? '').trim();
            const metaInvoices = String(metadata.invoices ?? '').trim();
            if (metaAccount && customers.has(metaAccount)) {
                bestMatch = metaAccount;
                bestName = customers.get(metaAccount) ?? '';
                matchMethod = `metadata:opera_account=${metaAccount}`;
                if (metaInvoices) {
                    metadataInvoiceRefs = metaInvoices
                        .split(',')
                        .map((r) => r.trim())
                        .filter((r) => r.length > 0);
                }
            }
            // Priority 1: mandate_id lookup
            if (!bestMatch && mandateId && mandateById.has(mandateId)) {
                const m = mandateById.get(mandateId);
                bestMatch = m.opera_account ?? null;
                bestName =
                    (bestMatch && customers.get(bestMatch)) || (m.opera_name ?? '');
                matchMethod = `mandate:${mandateId}`;
            }
            // Priority 2: gocardless_customer_id lookup
            if (!bestMatch && customerId && mandateByCustomer.has(customerId)) {
                const m = mandateByCustomer.get(customerId);
                bestMatch = m.opera_account ?? null;
                bestName =
                    (bestMatch && customers.get(bestMatch)) || (m.opera_name ?? '');
                matchMethod = `customer:${customerId}`;
            }
            // Priority 3: name match against mandate names
            if (!bestMatch &&
                customerName &&
                !['unknown', '', 'not provided'].includes(customerName.toLowerCase())) {
                const norm = normalizeCompanyName(customerName);
                if (mandateByName.has(norm)) {
                    const m = mandateByName.get(norm);
                    bestMatch = m.opera_account ?? null;
                    bestName =
                        (bestMatch && customers.get(bestMatch)) || (m.opera_name ?? '');
                    matchMethod = `name_exact:${norm}`;
                }
                else {
                    // Contains match either direction
                    for (const [storedName, m] of mandateByName.entries()) {
                        if (norm.includes(storedName) || storedName.includes(norm)) {
                            bestMatch = m.opera_account ?? null;
                            bestName =
                                (bestMatch && customers.get(bestMatch)) || (m.opera_name ?? '');
                            matchMethod = `name_contains:${storedName}`;
                            break;
                        }
                    }
                }
            }
            // Priority 4: name match against Opera sname directly
            if (!bestMatch &&
                customerName &&
                !['unknown', '', 'not provided'].includes(customerName.toLowerCase())) {
                const norm = normalizeCompanyName(customerName);
                // Two-pass: exact first, then contains, mirroring Python's
                // for-loop with break (first exact wins, otherwise first contains wins).
                let containsMatch = null;
                for (const [acct, operaName] of customers.entries()) {
                    const normOpera = normalizeCompanyName(operaName);
                    if (norm === normOpera) {
                        bestMatch = acct;
                        bestName = operaName;
                        matchMethod = `opera_exact:${norm}`;
                        break;
                    }
                    if (!containsMatch &&
                        (norm.includes(normOpera) || normOpera.includes(norm))) {
                        containsMatch = { acct, name: operaName, norm: normOpera };
                    }
                }
                if (!bestMatch && containsMatch) {
                    bestMatch = containsMatch.acct;
                    bestName = containsMatch.name;
                    matchMethod = `opera_contains:${containsMatch.norm}`;
                }
            }
            // Backfill candidates: matched by name AND payment carries customer_id
            if (bestMatch &&
                customerId &&
                matchMethod &&
                matchMethod.includes('name')) {
                backfillUpdates.push({ operaAccount: bestMatch, gcCustomerId: customerId });
            }
            // Use metadata invoice_refs when payment.invoice_refs is empty
            let invoiceRefs = Array.isArray(payment.invoice_refs) ? payment.invoice_refs : [];
            if (invoiceRefs.length === 0 && metadataInvoiceRefs.length > 0) {
                invoiceRefs = metadataInvoiceRefs;
            }
            const matchedPayment = {
                customer_name: customerName,
                description,
                amount,
                invoice_refs: invoiceRefs,
                matched_account: bestMatch,
                matched_name: bestName,
                match_score: bestMatch ? 1.0 : 0,
                match_method: matchMethod,
                match_status: bestMatch ? 'matched' : 'unmatched',
                possible_duplicate: false,
                duplicate_warning: null,
                gc_payment_id: String(payment.gc_payment_id ?? ''),
            };
            matched.push(matchedPayment);
            if (!bestMatch)
                unmatchedCount++;
        }
        // Backfill mandate gocardless_customer_id where empty
        if (backfillUpdates.length > 0) {
            try {
                for (const u of backfillUpdates) {
                    await appDb('gocardless_mandates')
                        .where({ opera_account: u.operaAccount })
                        .andWhere((qb) => {
                        qb.whereNull('gocardless_customer_id').orWhere('gocardless_customer_id', '');
                    })
                        .update({
                        gocardless_customer_id: u.gcCustomerId,
                        updated_at: appDb.fn.now(),
                    });
                }
            }
            catch {
                // Backfill is best-effort — don't fail the whole match because of it
            }
        }
        return {
            success: true,
            payments: matched,
            unmatched_count: unmatchedCount,
            total_count: payments.length,
        };
    }
    catch (err) {
        return {
            success: false,
            payments: [],
            unmatched_count: payments.length,
            total_count: payments.length,
            error: err?.message ?? String(err),
        };
    }
}
export async function matchCustomersWithDuplicateCheck(appDb, operaDb, payments, opts = {}) {
    const helperResult = await matchPaymentsHelper(appDb, operaDb, payments);
    if (!helperResult.success) {
        return helperResult;
    }
    const matchedPayments = helperResult.payments;
    // Duplicate check — query all Opera atran receipts (at_type=1, optional
    // cbtype filter), then per-payment match on absolute pence value with
    // 1p tolerance. Mirrors Python's loop.
    try {
        const cbType = (opts.defaultBatchType ?? '').trim();
        const sql = `SELECT at_value, at_pstdate, at_cbtype, ae_entref
       FROM atran WITH (NOLOCK)
       JOIN aentry WITH (NOLOCK)
         ON ae_acnt = at_acnt AND ae_cntr = at_cntr
        AND ae_cbtype = at_cbtype AND ae_entry = at_entry
       WHERE at_type = 1
       ${cbType ? `  AND at_cbtype = ?` : ''}
       ORDER BY at_pstdate DESC`;
        const params = cbType ? [cbType] : [];
        const rows = (await operaDb.raw(sql, params));
        if (Array.isArray(rows) && rows.length > 0) {
            for (const payment of matchedPayments) {
                const amountPence = Math.round(Number(payment.amount) * 100);
                for (const row of rows) {
                    const existing = Math.abs(Math.trunc(Number(row.at_value ?? 0)));
                    if (Math.abs(existing - amountPence) <= 1) {
                        payment.possible_duplicate = true;
                        const txDate = row.at_pstdate;
                        let dateStr = '';
                        if (txDate instanceof Date) {
                            const d = txDate.getUTCDate().toString().padStart(2, '0');
                            const m = (txDate.getUTCMonth() + 1).toString().padStart(2, '0');
                            const y = txDate.getUTCFullYear();
                            dateStr = `${d}/${m}/${y}`;
                        }
                        else if (typeof txDate === 'string') {
                            dateStr = txDate.slice(0, 10);
                        }
                        const ref = (row.ae_entref ?? '').trim() || 'N/A';
                        const cb = (row.at_cbtype ?? '').trim();
                        const formatted = (existing / 100).toFixed(2);
                        payment.duplicate_warning = `Cashbook entry found: £${formatted} on ${dateStr} (type: ${cb}, ref: ${ref})`;
                        break;
                    }
                }
            }
        }
    }
    catch {
        // Duplicate check is best-effort
    }
    const matchedCount = matchedPayments.filter((p) => p.match_status === 'matched').length;
    const reviewCount = matchedPayments.filter((p) => p.match_status === 'review').length;
    const duplicateCount = matchedPayments.filter((p) => p.possible_duplicate).length;
    return {
        ...helperResult,
        total_payments: matchedPayments.length,
        matched_count: matchedCount,
        review_count: reviewCount,
        duplicate_count: duplicateCount,
    };
}
//# sourceMappingURL=match-customers.js.map