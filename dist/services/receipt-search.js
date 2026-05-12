function r2(n) {
    return Math.round(n * 100) / 100;
}
function dateToYmd(d) {
    if (!d)
        return '';
    if (d instanceof Date) {
        if (Number.isNaN(d.getTime()))
            return '';
        return d.toISOString().slice(0, 10);
    }
    return String(d).slice(0, 10);
}
export async function searchReceipts(appDb, operaDb, opts = {}) {
    try {
        const limit = opts.limit ?? 200;
        const searchLower = opts.customer ? opts.customer.toLowerCase().trim() : null;
        // Fetch up to 1000 history records in the date range to search within
        let query = appDb('gocardless_imports')
            .where({ target_system: 'opera_se' })
            .orderBy('payment_date', 'desc')
            .orderBy('imported_at', 'desc')
            .limit(1000);
        if (opts.fromDate)
            query = query.andWhere('payment_date', '>=', opts.fromDate);
        if (opts.toDate)
            query = query.andWhere('payment_date', '<=', opts.toDate);
        const history = (await query);
        // Collect unique customer accounts for Opera-name enrichment
        const allAccounts = new Set();
        const parsedByRow = new Map();
        for (const r of history) {
            if (!r.payments_json) {
                parsedByRow.set(r.id, []);
                continue;
            }
            try {
                const parsed = JSON.parse(r.payments_json);
                const list = Array.isArray(parsed) ? parsed : [];
                parsedByRow.set(r.id, list);
                for (const p of list) {
                    const acct = String(p.customer_account ?? '').trim();
                    if (acct)
                        allAccounts.add(acct);
                }
            }
            catch {
                parsedByRow.set(r.id, []);
            }
        }
        // Opera customer name lookup (best-effort)
        const operaNames = new Map();
        if (allAccounts.size > 0 && operaDb) {
            try {
                const codes = [...allAccounts];
                const placeholders = codes.map(() => '?').join(',');
                const rows = (await operaDb.raw(`SELECT sn_account, sn_name FROM sname WITH (NOLOCK) WHERE sn_account IN (${placeholders})`, codes));
                for (const row of Array.isArray(rows) ? rows : []) {
                    const a = (row.sn_account ?? '').trim();
                    const n = (row.sn_name ?? '').trim();
                    if (a && n)
                        operaNames.set(a, n);
                }
            }
            catch {
                // Non-fatal — caller still gets the raw history without Opera names
            }
        }
        const receipts = [];
        for (const record of history) {
            const payments = parsedByRow.get(record.id) ?? [];
            for (const p of payments) {
                const acct = String(p.customer_account ?? '').trim();
                const gcName = String(p.gc_customer_name ?? p.customer_name ?? '').trim();
                const operaName = String(p.opera_customer_name ?? '').trim() || operaNames.get(acct) || '';
                const amount = Number(p.amount ?? 0);
                if (searchLower) {
                    const searchable = `${acct} ${gcName} ${operaName}`.toLowerCase();
                    if (!searchable.includes(searchLower))
                        continue;
                }
                receipts.push({
                    import_id: record.id,
                    receipt_date: dateToYmd(record.payment_date),
                    payout_id: '',
                    bank_reference: record.bank_reference ?? '',
                    batch_ref: '',
                    customer_account: acct,
                    customer_name: operaName || gcName,
                    gc_customer_name: gcName,
                    amount,
                    currency: String(p.currency ?? 'GBP'),
                    payment_id: String(p.payment_id ?? ''),
                    invoice_ref: String(p.invoice_ref ?? p.reference ?? ''),
                });
            }
        }
        // Sort: date descending, then customer name
        receipts.sort((a, b) => {
            if (a.receipt_date < b.receipt_date)
                return 1;
            if (a.receipt_date > b.receipt_date)
                return -1;
            return a.customer_name.localeCompare(b.customer_name);
        });
        const trimmed = receipts.slice(0, limit);
        const totalAmount = trimmed.reduce((sum, r) => sum + r.amount, 0);
        return {
            success: true,
            total: trimmed.length,
            total_amount: r2(totalAmount),
            receipts: trimmed,
        };
    }
    catch (err) {
        return {
            success: false,
            total: 0,
            total_amount: 0,
            receipts: [],
            error: err?.message ?? String(err),
        };
    }
}
//# sourceMappingURL=receipt-search.js.map