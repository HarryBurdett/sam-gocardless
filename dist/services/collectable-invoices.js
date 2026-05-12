function trim(s) {
    return (s ?? '').trim();
}
function dateToIso(v) {
    if (!v)
        return null;
    if (v instanceof Date) {
        if (Number.isNaN(v.getTime()))
            return null;
        return v.toISOString().slice(0, 10);
    }
    const s = String(v);
    return s.slice(0, 10) || null;
}
function formatPounds(amount) {
    return `£${amount.toLocaleString('en-GB', {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
    })}`;
}
function parseInvoiceRefs(value) {
    if (Array.isArray(value))
        return value.map(String);
    if (typeof value === 'string' && value) {
        try {
            const parsed = JSON.parse(value);
            return Array.isArray(parsed) ? parsed.map(String) : [];
        }
        catch {
            return [];
        }
    }
    return [];
}
function daysBetween(today, due) {
    const a = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
    const b = Date.UTC(due.getUTCFullYear(), due.getUTCMonth(), due.getUTCDate());
    return Math.round((a - b) / (1000 * 60 * 60 * 24));
}
export async function getCollectableInvoices(operaDb, appDb, opts = {}, today = new Date()) {
    const overdueOnly = !!opts.overdueOnly;
    const minAmount = Math.max(0, Number(opts.minAmount ?? 0));
    try {
        // 1. Active mandates keyed by opera_account
        const mandateRows = (await appDb('gocardless_mandates')
            .where({ mandate_status: 'active' })
            .select('opera_account', 'mandate_id', 'mandate_status'));
        const mandateLookup = new Map();
        for (const m of mandateRows ?? []) {
            const acct = trim(m.opera_account);
            if (!acct || acct === '__UNLINKED__')
                continue;
            mandateLookup.set(acct, {
                opera_account: acct,
                mandate_id: trim(m.mandate_id),
                mandate_status: trim(m.mandate_status) || 'active',
            });
        }
        // 2. Already-requested invoices (skip cancelled/failed/charged_back)
        const requestRows = (await appDb('gocardless_payment_requests').select('status', 'invoice_refs'));
        const alreadyRequested = new Set();
        for (const r of requestRows ?? []) {
            const status = trim(r.status);
            if (status === 'cancelled' || status === 'failed' || status === 'charged_back') {
                continue;
            }
            const refs = parseInvoiceRefs(r.invoice_refs);
            for (const ref of refs)
                alreadyRequested.add(ref.trim());
        }
        // 3. Subscription source_doc lookup keyed by opera_account
        const subRows = (await appDb('gocardless_subscriptions').select('opera_account', 'source_doc', 'status'));
        const subSourceDocs = new Map();
        for (const s of subRows ?? []) {
            const acct = trim(s.opera_account);
            const doc = trim(s.source_doc ?? '');
            const status = trim(s.status);
            if (acct && doc && status !== 'cancelled') {
                subSourceDocs.set(acct, doc);
            }
        }
        // 4. Sales-ledger outstanding invoices
        let query = operaDb('stran')
            .innerJoin('sname', 'st_account', 'sn_account')
            .where('st_trbal', '>', 0)
            .andWhere({ st_trtype: 'I' });
        if (minAmount > 0) {
            query = query.andWhere('st_trbal', '>=', minAmount);
        }
        const rows = (await query
            .orderBy([
            { column: 'st_account', order: 'asc' },
            { column: 'st_trdate', order: 'asc' },
        ])
            .select('st_account', operaDb.raw('RTRIM(sn_name) AS sn_name'), operaDb.raw('RTRIM(st_trref) AS st_trref'), 'st_trdate', 'st_dueday', 'st_trtype', 'st_trbal'));
        const invoices = [];
        let totalCollectable = 0;
        let totalWithMandate = 0;
        for (const row of rows ?? []) {
            const account = trim(row.st_account);
            const customerName = trim(row.sn_name);
            const invoiceRef = trim(row.st_trref);
            const amount = Number(row.st_trbal ?? 0) || 0;
            const invoiceDate = dateToIso(row.st_trdate);
            const dueDate = dateToIso(row.st_dueday);
            let daysOverdue = 0;
            if (dueDate) {
                const due = new Date(`${dueDate}T00:00:00Z`);
                if (!Number.isNaN(due.getTime())) {
                    daysOverdue = daysBetween(today, due);
                }
            }
            if (overdueOnly && daysOverdue <= 0)
                continue;
            const mandate = mandateLookup.get(account) ?? null;
            const hasMandate = mandate !== null;
            const isSubscription = false; // Python's query always returns is_sub=0
            const sourceDoc = isSubscription ? subSourceDocs.get(account) ?? null : null;
            const transTypeRaw = row.st_trtype;
            const transType = transTypeRaw === 1 || transTypeRaw === 'I' ? 'Invoice' : 'Credit Note';
            invoices.push({
                opera_account: account,
                customer_name: customerName,
                invoice_ref: invoiceRef,
                invoice_date: invoiceDate,
                due_date: dueDate,
                amount,
                amount_formatted: formatPounds(amount),
                days_overdue: Math.max(0, daysOverdue),
                is_overdue: daysOverdue > 0,
                has_mandate: hasMandate,
                mandate_id: mandate?.mandate_id ?? null,
                mandate_status: mandate?.mandate_status ?? null,
                trans_type: transType,
                is_subscription: isSubscription,
                source_doc: sourceDoc,
                payment_requested: alreadyRequested.has(invoiceRef),
            });
            if (!isSubscription) {
                totalCollectable += amount;
                if (hasMandate)
                    totalWithMandate += amount;
            }
        }
        return {
            success: true,
            invoices,
            count: invoices.length,
            total_collectable: totalCollectable,
            total_collectable_formatted: formatPounds(totalCollectable),
            total_with_mandate: totalWithMandate,
            total_with_mandate_formatted: formatPounds(totalWithMandate),
            mandates_available: mandateLookup.size,
        };
    }
    catch (err) {
        return {
            success: false,
            invoices: [],
            count: 0,
            total_collectable: 0,
            total_collectable_formatted: formatPounds(0),
            total_with_mandate: 0,
            total_with_mandate_formatted: formatPounds(0),
            mandates_available: 0,
            error: err?.message ?? String(err),
        };
    }
}
//# sourceMappingURL=collectable-invoices.js.map