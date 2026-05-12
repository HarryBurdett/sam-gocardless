const COLLECTED_STATUSES = new Set(['confirmed', 'paid_out']);
function trim(s) {
    return (s ?? '').trim();
}
function parseInvoiceRefs(value) {
    if (Array.isArray(value))
        return value.map((v) => trim(String(v)));
    if (typeof value === 'string' && value) {
        try {
            const parsed = JSON.parse(value);
            if (Array.isArray(parsed))
                return parsed.map((v) => trim(String(v)));
        }
        catch {
            // fall through
        }
        return [trim(value)];
    }
    return [];
}
async function isInvoiceFullyPaid(operaDb, invoiceRefs) {
    // Check first 3 refs only (matches Python's `refs[:3]`)
    const slice = invoiceRefs.slice(0, 3).filter(Boolean);
    for (const ref of slice) {
        try {
            const row = await operaDb('stran')
                .where({ st_trref: ref, st_trtype: 'I' })
                .andWhereRaw('ABS(st_trbal) < 0.01')
                .first();
            if (row)
                return true;
        }
        catch {
            // best-effort
        }
    }
    return false;
}
async function hasMatchingCashbookReceipt(operaDb, account, amountPence) {
    try {
        const row = await operaDb('aentry')
            .innerJoin('atran', function () {
            this.on('ae_acnt', '=', 'at_acnt')
                .andOn('ae_cntr', '=', 'at_cntr')
                .andOn('ae_cbtype', '=', 'at_cbtype')
                .andOn('ae_entry', '=', 'at_entry');
        })
            .where({ at_type: 4, at_inputby: 'GOCARDLS' })
            .andWhereRaw('RTRIM(ae_comment) LIKE ?', [`%${account}%`])
            .andWhereRaw('ABS(ae_value - ?) <= 1', [amountPence])
            .first();
        return !!row;
    }
    catch {
        return false;
    }
}
async function markPosted(appDb, requestId) {
    try {
        await appDb('gocardless_payment_requests')
            .where({ id: requestId })
            .update({ status: 'posted', updated_at: appDb.fn.now() });
    }
    catch {
        // best-effort — Python ignores failures here
    }
}
export async function getUnpostedPayments(operaDb, appDb, opts = {}) {
    try {
        const requests = (await appDb('gocardless_payment_requests')
            .orderBy('id', 'desc')
            .limit(10000));
        const unposted = [];
        let totalAmount = 0;
        for (const req of requests ?? []) {
            const status = trim(req.status);
            if (!COLLECTED_STATUSES.has(status))
                continue;
            let alreadyPosted = false;
            // Check 1: payout already imported
            const payoutId = trim(req.payout_id);
            if (!alreadyPosted && payoutId && opts.isPayoutImported) {
                try {
                    if (await opts.isPayoutImported(payoutId)) {
                        alreadyPosted = true;
                        await markPosted(appDb, req.id);
                    }
                }
                catch {
                    // best-effort
                }
            }
            // Check 2: invoice fully paid in Opera
            const invoiceRefs = parseInvoiceRefs(req.invoice_refs);
            if (!alreadyPosted && invoiceRefs.length > 0) {
                if (await isInvoiceFullyPaid(operaDb, invoiceRefs)) {
                    alreadyPosted = true;
                    await markPosted(appDb, req.id);
                }
            }
            // Check 3: matching cashbook receipt
            const account = trim(req.opera_account);
            const amountPence = Math.round(Number(req.amount_pence ?? 0));
            if (!alreadyPosted && account && Number.isFinite(amountPence) && amountPence > 0) {
                if (await hasMatchingCashbookReceipt(operaDb, account, amountPence)) {
                    alreadyPosted = true;
                    await markPosted(appDb, req.id);
                }
            }
            if (!alreadyPosted) {
                const amount = amountPence / 100;
                const customerName = opts.customerNamesByAccount?.get(account) ?? '';
                unposted.push({
                    id: req.id,
                    opera_account: account || null,
                    customer_name: customerName,
                    amount,
                    status,
                    charge_date: req.charge_date ?? null,
                    invoice_refs: req.invoice_refs ?? null,
                });
                totalAmount += amount;
            }
        }
        let unprocessedBatches = 0;
        if (opts.getUnprocessedBatchCount) {
            try {
                unprocessedBatches = await opts.getUnprocessedBatchCount();
            }
            catch {
                // best-effort
            }
        }
        return {
            success: true,
            has_unposted: unposted.length > 0 || unprocessedBatches > 0,
            unposted_count: unposted.length,
            unposted_total: Math.round(totalAmount * 100) / 100,
            unprocessed_batches: unprocessedBatches,
            unposted,
        };
    }
    catch (err) {
        // Python wraps ALL failures in a soft success. Mirror that behaviour
        // so the dashboard renders even when the underlying read fails.
        return {
            success: true,
            has_unposted: false,
            unposted_count: 0,
            unposted_total: 0,
            unprocessed_batches: 0,
            unposted: [],
            error: err?.message ?? String(err),
        };
    }
}
//# sourceMappingURL=unposted-payments.js.map