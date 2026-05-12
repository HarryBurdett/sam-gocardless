const ACTIVE_REQUEST_STATUSES = new Set([
    'pending',
    'pending_submission',
    'submitted',
    'confirmed',
    'paid_out',
    'posted',
]);
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
function parseDate(s) {
    if (!s)
        return null;
    const d = new Date(`${s}T00:00:00Z`);
    return Number.isNaN(d.getTime()) ? null : d;
}
function daysBetween(from, to) {
    const a = Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate());
    const b = Date.UTC(to.getUTCFullYear(), to.getUTCMonth(), to.getUTCDate());
    return Math.round((b - a) / (1000 * 60 * 60 * 24));
}
function emptyResponse(advanceDate, today) {
    return {
        success: true,
        customers: [],
        invoices: [],
        summary: {
            total_customers: 0,
            total_invoices: 0,
            total_amount: 0,
            total_amount_formatted: formatPounds(0),
            collectable_amount: 0,
            collectable_formatted: formatPounds(0),
        },
        advance_date: advanceDate,
        today,
    };
}
export async function getDueInvoices(operaDb, appDb, opts = {}, todayDate = new Date()) {
    const todayIso = todayDate.toISOString().slice(0, 10);
    const subTag = opts.subscriptionTag ?? 'SUB';
    const includeFuture = opts.includeFuture !== false;
    // Parse advance date
    let target = todayDate;
    let targetIso = todayIso;
    if (opts.advanceDate) {
        const parsed = parseDate(opts.advanceDate);
        if (!parsed) {
            return {
                ...emptyResponse(opts.advanceDate, todayIso),
                success: false,
                error: 'Invalid date format. Use YYYY-MM-DD',
            };
        }
        target = parsed;
        targetIso = opts.advanceDate;
    }
    try {
        // 1. Active mandates keyed by opera_account
        const mandateRows = (await appDb('gocardless_mandates')
            .where({ mandate_status: 'active' })
            .select('opera_account', 'mandate_id'));
        const mandateLookup = new Map();
        for (const m of mandateRows ?? []) {
            const acct = trim(m.opera_account);
            if (!acct || acct === '__UNLINKED__')
                continue;
            mandateLookup.set(acct, m);
        }
        if (mandateLookup.size === 0) {
            return emptyResponse(targetIso, todayIso);
        }
        const mandatedAccounts = Array.from(mandateLookup.keys());
        // 2. Pending payment-request lookup keyed by invoice_ref
        const requestRows = (await appDb('gocardless_payment_requests').select('id', 'status', 'charge_date', 'amount_pence', 'invoice_refs'));
        const pendingByRef = new Map();
        for (const r of requestRows ?? []) {
            const status = trim(r.status);
            if (!ACTIVE_REQUEST_STATUSES.has(status))
                continue;
            const refs = parseInvoiceRefs(r.invoice_refs);
            for (const ref of refs) {
                pendingByRef.set(ref.trim(), {
                    request_id: r.id ?? null,
                    status,
                    charge_date: r.charge_date ?? null,
                    amount_pence: r.amount_pence === null || r.amount_pence === undefined
                        ? null
                        : Number(r.amount_pence),
                });
            }
        }
        // 3. External-API enrichment (best-effort — Python's "log + continue")
        if (opts.fetchExternalPendingPayments) {
            try {
                const extra = await opts.fetchExternalPendingPayments();
                for (const e of extra ?? []) {
                    const key = e.ref.trim().toUpperCase();
                    if (!pendingByRef.has(key)) {
                        pendingByRef.set(key, e.info);
                    }
                }
            }
            catch {
                // best-effort
            }
        }
        // 4. Subscription source-doc lookup
        const subRows = (await appDb('gocardless_subscriptions').select('opera_account', 'source_doc', 'status'));
        const subDocs = new Map();
        for (const s of subRows ?? []) {
            const acct = trim(s.opera_account);
            const doc = trim(s.source_doc ?? '');
            const status = trim(s.status);
            if (acct && doc && status !== 'cancelled')
                subDocs.set(acct, doc);
        }
        // 5. Unallocated credit per mandated customer (st_trbal < 0 grouped)
        const creditPlaceholders = mandatedAccounts.map(() => '?').join(',');
        const creditRows = (await operaDb('stran')
            .whereRaw(`RTRIM(st_account) IN (${creditPlaceholders})`, mandatedAccounts)
            .andWhere('st_trbal', '<', 0)
            .groupBy('st_account')
            .select('st_account', operaDb.raw('SUM(st_trbal) AS unallocated_credit')));
        const unallocatedCredit = new Map();
        for (const r of creditRows ?? []) {
            const acct = trim(r.st_account);
            const credit = Math.abs(Number(r.unallocated_credit ?? 0));
            if (acct && credit >= 0.01)
                unallocatedCredit.set(acct, credit);
        }
        // 6. Outstanding invoices (joined to is_sub via EXISTS on ihead)
        const isSubExpr = operaDb.raw(`CASE WHEN EXISTS (
         SELECT 1 FROM ihead
         WHERE ih_invoice = st_trref
           AND ih_docstat = 'I'
           AND RTRIM(ih_analsys) = ?
       ) THEN 1 ELSE 0 END AS is_sub`, [subTag]);
        const invoicePlaceholders = mandatedAccounts.map(() => '?').join(',');
        const rows = (await operaDb('stran')
            .innerJoin('sname', 'st_account', 'sn_account')
            .where('st_trbal', '>', 0)
            .andWhere({ st_trtype: 'I' })
            .andWhereRaw(`RTRIM(st_account) IN (${invoicePlaceholders})`, mandatedAccounts)
            .orderBy([
            { column: 'sn_name', order: 'asc' },
            { column: 'st_dueday', order: 'asc' },
            { column: 'st_trref', order: 'asc' },
        ])
            .select('st_account', 'sn_name', 'sn_email', 'st_trref', 'st_trdate', 'st_dueday', 'st_trtype', 'st_trbal', 'st_trvalue', 'st_custref', isSubExpr));
        const invoices = [];
        const customers = new Map();
        let totalAmount = 0;
        let collectable = 0;
        for (const row of rows ?? []) {
            const account = trim(row.st_account);
            const customerName = trim(row.sn_name);
            const invoiceRef = trim(row.st_trref);
            const email = trim(row.sn_email) || null;
            const customerRef = trim(row.st_custref);
            const amount = Number(row.st_trbal ?? 0) || 0;
            const originalAmount = Number(row.st_trvalue ?? amount) || amount;
            const transTypeRaw = row.st_trtype ?? 'I';
            const isSubRaw = row.is_sub;
            const isSub = isSubRaw === 1 || isSubRaw === true || isSubRaw === '1';
            const sourceDoc = isSub ? subDocs.get(account) ?? null : null;
            const invoiceDateIso = dateToIso(row.st_trdate);
            const dueDateIso = dateToIso(row.st_dueday);
            const dueDateObj = parseDate(dueDateIso);
            let daysUntilDue = null;
            let isOverdue = false;
            let isDueByAdvance = false;
            if (dueDateObj) {
                daysUntilDue = daysBetween(todayDate, dueDateObj);
                isOverdue = daysUntilDue < 0;
                isDueByAdvance = dueDateObj <= target;
            }
            // Filter: include_future=false skips not-yet-overdue
            if (!includeFuture && !isOverdue)
                continue;
            // Filter: skip invoices due AFTER the advance window
            if (dueDateObj && dueDateObj > target)
                continue;
            const mandate = mandateLookup.get(account) ?? null;
            const hasMandate = mandate !== null;
            const refUpper = invoiceRef.toUpperCase();
            const paymentInfo = pendingByRef.get(invoiceRef) ?? pendingByRef.get(refUpper) ?? null;
            const invoice = {
                opera_account: account,
                customer_name: customerName,
                invoice_ref: invoiceRef,
                invoice_date: invoiceDateIso,
                due_date: dueDateIso,
                days_until_due: daysUntilDue,
                is_overdue: isOverdue,
                is_due_by_advance: isDueByAdvance,
                amount,
                amount_formatted: formatPounds(amount),
                original_amount: originalAmount,
                has_mandate: hasMandate,
                mandate_id: mandate?.mandate_id ?? null,
                trans_type: transTypeRaw === 1 || transTypeRaw === '1' ? 'Invoice' : 'Invoice',
                trans_type_code: transTypeRaw,
                customer_ref: customerRef,
                payment_requested: paymentInfo !== null,
                payment_request_info: paymentInfo,
                is_subscription: isSub,
                source_doc: sourceDoc,
            };
            invoices.push(invoice);
            totalAmount += amount;
            if (hasMandate && !isSub)
                collectable += amount;
            let cust = customers.get(account);
            if (!cust) {
                const credit = unallocatedCredit.get(account) ?? 0;
                cust = {
                    account,
                    name: customerName,
                    email,
                    has_mandate: hasMandate,
                    mandate_id: mandate?.mandate_id ?? null,
                    invoices: [],
                    total_due: 0,
                    total_due_formatted: formatPounds(0),
                    invoice_count: 0,
                    unallocated_credit: credit,
                    unallocated_credit_formatted: credit >= 0.01 ? formatPounds(credit) : null,
                };
                customers.set(account, cust);
            }
            cust.invoices.push(invoice);
            cust.total_due += amount;
            cust.invoice_count += 1;
        }
        const customerList = [];
        for (const cust of customers.values()) {
            cust.total_due_formatted = formatPounds(cust.total_due);
            customerList.push(cust);
        }
        customerList.sort((a, b) => a.name.localeCompare(b.name));
        return {
            success: true,
            customers: customerList,
            invoices,
            summary: {
                total_customers: customerList.length,
                total_invoices: invoices.length,
                total_amount: totalAmount,
                total_amount_formatted: formatPounds(totalAmount),
                collectable_amount: collectable,
                collectable_formatted: formatPounds(collectable),
                customers_with_mandate: customerList.filter((c) => c.has_mandate).length,
                customers_without_mandate: customerList.filter((c) => !c.has_mandate).length,
            },
            advance_date: targetIso,
            today: todayIso,
        };
    }
    catch (err) {
        return {
            ...emptyResponse(targetIso, todayIso),
            success: false,
            error: err?.message ?? String(err),
        };
    }
}
//# sourceMappingURL=due-invoices.js.map