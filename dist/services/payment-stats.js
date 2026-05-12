const PENDING_STATUSES = [
    'pending',
    'pending_submission',
    'submitted',
    'confirmed',
];
function formatGbp(amount) {
    // Mirrors Python f"£{amount:,.2f}" — comma thousands sep, 2dp, GBP symbol
    const sign = amount < 0 ? '-' : '';
    const abs = Math.abs(amount);
    const fixed = abs.toFixed(2);
    const [whole = '0', frac = '00'] = fixed.split('.');
    // Insert comma every three digits
    const withCommas = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    return `${sign}£${withCommas}.${frac}`;
}
function firstOfMonthIso(now = new Date()) {
    const y = now.getUTCFullYear();
    const m = String(now.getUTCMonth() + 1).padStart(2, '0');
    return `${y}-${m}-01`;
}
function thirtyDaysAgoIso(now = new Date()) {
    const t = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    return t.toISOString().slice(0, 10);
}
export async function getPaymentStats(appDb, now = new Date()) {
    try {
        // Active mandates count
        const mandRow = (await appDb('gocardless_mandates')
            .where({ mandate_status: 'active' })
            .count('* as count'));
        const activeMandates = Number(mandRow[0]?.count ?? 0);
        // Pending payments — count + sum
        const pendingRow = (await appDb('gocardless_payment_requests')
            .whereIn('status', PENDING_STATUSES)
            .select(appDb.raw('COUNT(*) as count'), appDb.raw('COALESCE(SUM(amount), 0) as total')));
        const pendingCount = Number(pendingRow[0]?.count ?? 0);
        const pendingAmount = Number(pendingRow[0]?.total ?? 0);
        // This month collected
        const monthStart = firstOfMonthIso(now);
        const monthRow = (await appDb('gocardless_payment_requests')
            .where({ status: 'paid_out' })
            .andWhere('created_at', '>=', monthStart)
            .select(appDb.raw('COUNT(*) as count'), appDb.raw('COALESCE(SUM(amount), 0) as total')));
        const monthCount = Number(monthRow[0]?.count ?? 0);
        const monthAmount = Number(monthRow[0]?.total ?? 0);
        // Failed payments (last 30 days)
        const thirtyAgo = thirtyDaysAgoIso(now);
        const failedRow = (await appDb('gocardless_payment_requests')
            .where({ status: 'failed' })
            .andWhere('created_at', '>=', thirtyAgo)
            .count('* as count'));
        const failedCount = Number(failedRow[0]?.count ?? 0);
        return {
            success: true,
            active_mandates: activeMandates,
            pending_count: pendingCount,
            pending_amount: pendingAmount,
            pending_amount_formatted: formatGbp(pendingAmount),
            month_collected_count: monthCount,
            month_collected_amount: monthAmount,
            month_collected_formatted: formatGbp(monthAmount),
            failed_count_30d: failedCount,
        };
    }
    catch (err) {
        return { success: false, error: err?.message ?? String(err) };
    }
}
//# sourceMappingURL=payment-stats.js.map