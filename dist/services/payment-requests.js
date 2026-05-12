function dateToIso(d) {
    if (!d)
        return '';
    if (d instanceof Date) {
        if (Number.isNaN(d.getTime()))
            return '';
        return d.toISOString();
    }
    return String(d);
}
export async function getPaymentRequest(appDb, requestId) {
    if (!Number.isFinite(requestId) || requestId <= 0) {
        return { success: false, error: 'request_id must be a positive number' };
    }
    try {
        const row = (await appDb('gocardless_payment_requests')
            .where({ id: requestId })
            .first());
        if (!row) {
            return { success: false, error: 'Payment request not found' };
        }
        const acct = (row.opera_account ?? '').toString().trim();
        let customerName = acct;
        if (acct) {
            try {
                const mand = (await appDb('gocardless_mandates')
                    .where({ opera_account: acct })
                    .first());
                if (mand?.opera_name)
                    customerName = mand.opera_name.trim() || acct;
            }
            catch {
                // best-effort
            }
        }
        const charge_date = row.charge_date;
        const created_at = row.created_at;
        const updated_at = row.updated_at;
        const pr = {
            id: row.id,
            payment_id: row.payment_id ?? '',
            mandate_id: row.mandate_id ?? '',
            opera_account: acct,
            amount: Number(row.amount ?? 0),
            amount_pence: row.amount_pence != null ? Number(row.amount_pence) : null,
            currency: row.currency ?? 'GBP',
            status: row.status ?? '',
            reference: row.reference ?? '',
            charge_date: dateToIso(charge_date),
            payout_id: row.payout_id ?? '',
            invoice_refs: row.invoice_refs ?? '',
            opera_receipt_ref: row.opera_receipt_ref ?? '',
            error_message: row.error_message ?? '',
            created_at: dateToIso(created_at),
            updated_at: dateToIso(updated_at),
            customer_name: customerName,
        };
        return { success: true, payment_request: pr };
    }
    catch (err) {
        return { success: false, error: err?.message ?? String(err) };
    }
}
// ---------------------------------------------------------------------
// sync — poll GoCardless for status updates on pending requests
// ---------------------------------------------------------------------
const PENDING_SYNC_STATUSES = [
    'pending',
    'pending_submission',
    'pending_customer_approval',
    'submitted',
    'confirmed',
];
export async function syncPaymentStatuses(appDb, syncRemote) {
    try {
        const requestsToSync = (await appDb('gocardless_payment_requests')
            .whereIn('status', PENDING_SYNC_STATUSES)
            .select('id', 'payment_id', 'status'));
        if (!Array.isArray(requestsToSync) || requestsToSync.length === 0) {
            return {
                success: true,
                message: 'No pending payments to sync',
                total_checked: 0,
                updated: 0,
            };
        }
        let updatedCount = 0;
        for (const req of requestsToSync) {
            const paymentId = (req.payment_id ?? '').trim();
            if (!paymentId)
                continue;
            try {
                const r = await syncRemote(paymentId);
                if (!r.success || !r.payment)
                    continue;
                const newStatus = (r.payment.status ?? '').toString().trim();
                const newChargeDate = (r.payment.charge_date ?? '').toString().trim();
                if (newStatus && newStatus !== req.status) {
                    await appDb('gocardless_payment_requests').where({ id: req.id }).update({
                        status: newStatus,
                        charge_date: newChargeDate || null,
                        updated_at: appDb.fn.now(),
                    });
                    updatedCount++;
                }
            }
            catch {
                // Per-payment failure logged + continue (matches Python's
                // try/except wrapping a logger.warning).
            }
        }
        return {
            success: true,
            message: `Synced ${updatedCount} payment statuses`,
            total_checked: requestsToSync.length,
            updated: updatedCount,
        };
    }
    catch (err) {
        return { success: false, error: err?.message ?? String(err) };
    }
}
// ---------------------------------------------------------------------
// cancel
// ---------------------------------------------------------------------
const CANCELLABLE_STATUSES = new Set([
    'pending',
    'pending_submission',
    'pending_customer_approval',
]);
export async function cancelPaymentRequest(appDb, requestId, cancelRemote) {
    if (!Number.isFinite(requestId) || requestId <= 0) {
        return { success: false, error: 'request_id must be a positive number' };
    }
    try {
        const row = (await appDb('gocardless_payment_requests')
            .where({ id: requestId })
            .first());
        if (!row) {
            return { success: false, error: 'Payment request not found' };
        }
        const status = (row.status ?? '').trim();
        if (!CANCELLABLE_STATUSES.has(status)) {
            return {
                success: false,
                error: `Cannot cancel payment with status '${status}'`,
            };
        }
        // Best-effort GoCardless API cancel
        let remoteWarning;
        const paymentId = (row.payment_id ?? '').trim();
        if (paymentId && cancelRemote) {
            try {
                const r = await cancelRemote(paymentId);
                if (!r.success) {
                    remoteWarning = r.error ?? 'Remote cancel failed';
                }
            }
            catch (e) {
                remoteWarning = e?.message ?? String(e);
            }
        }
        // Always mark local as cancelled
        await appDb('gocardless_payment_requests').where({ id: requestId }).update({
            status: 'cancelled',
            error_message: 'Cancelled by user',
            updated_at: appDb.fn.now(),
        });
        const result = {
            success: true,
            message: `Payment request ${requestId} cancelled`,
            local_cancelled: true,
        };
        if (remoteWarning)
            result.remote_warning = remoteWarning;
        return result;
    }
    catch (err) {
        return { success: false, error: err?.message ?? String(err) };
    }
}
export async function listPaymentRequests(appDb, opts = {}) {
    try {
        const limit = opts.limit ?? 100;
        let query = appDb('gocardless_payment_requests')
            .orderBy('created_at', 'desc')
            .limit(limit);
        if (opts.status) {
            query = query.where({ status: opts.status });
        }
        if (opts.operaAccount) {
            query = query.where({ opera_account: opts.operaAccount });
        }
        const rows = (await query);
        // Enrich with customer name from mandates (one-shot lookup)
        const accounts = Array.from(new Set(rows.map((r) => (r.opera_account ?? '').trim()).filter(Boolean)));
        let mandateNames = new Map();
        if (accounts.length > 0) {
            try {
                const mandates = (await appDb('gocardless_mandates')
                    .whereIn('opera_account', accounts)
                    .select('opera_account', 'opera_name'));
                for (const m of mandates ?? []) {
                    const acct = (m.opera_account ?? '').trim();
                    if (acct)
                        mandateNames.set(acct, (m.opera_name ?? '').trim());
                }
            }
            catch {
                // Best-effort enrichment
                mandateNames = new Map();
            }
        }
        const requests = rows.map((r) => {
            const acct = (r.opera_account ?? '').trim();
            const customerName = mandateNames.get(acct) || acct;
            return {
                id: r.id,
                payment_id: r.payment_id ?? '',
                mandate_id: r.mandate_id ?? '',
                opera_account: acct,
                amount: Number(r.amount ?? 0),
                amount_pence: r.amount_pence != null ? Number(r.amount_pence) : null,
                currency: r.currency ?? 'GBP',
                status: r.status ?? '',
                reference: r.reference ?? '',
                charge_date: dateToIso(r.charge_date),
                payout_id: r.payout_id ?? '',
                invoice_refs: r.invoice_refs ?? '',
                opera_receipt_ref: r.opera_receipt_ref ?? '',
                error_message: r.error_message ?? '',
                created_at: dateToIso(r.created_at),
                updated_at: dateToIso(r.updated_at),
                customer_name: customerName,
            };
        });
        return { success: true, requests, count: requests.length };
    }
    catch (err) {
        return {
            success: false,
            requests: [],
            count: 0,
            error: err?.message ?? String(err),
        };
    }
}
//# sourceMappingURL=payment-requests.js.map