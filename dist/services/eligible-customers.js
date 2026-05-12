export async function getEligibleCustomers(appDb, operaDb) {
    try {
        // 1. Build lookup of all linked mandates from per-app DB
        const mandateRows = (await appDb('gocardless_mandates')
            .where('opera_account', '!=', '__UNLINKED__')
            .select('opera_account', 'mandate_id', 'mandate_status'));
        const mandateLookup = new Map();
        for (const m of mandateRows ?? []) {
            const acct = (m.opera_account ?? '').trim();
            if (!acct)
                continue;
            mandateLookup.set(acct, {
                opera_account: acct,
                mandate_id: (m.mandate_id ?? '').trim(),
                mandate_status: (m.mandate_status ?? '').trim(),
            });
        }
        const mandatedAccounts = Array.from(mandateLookup.keys());
        // 2. Build SQL — sn_analsys='GC' OR sn_account in (mandated)
        let sql;
        let params;
        if (mandatedAccounts.length > 0) {
            const placeholders = mandatedAccounts.map(() => '?').join(',');
            sql = `
        SELECT sn_account, sn_name, sn_analsys, sn_currbal, sn_email
        FROM sname WITH (NOLOCK)
        WHERE (sn_stop = 0 OR sn_stop IS NULL)
          AND (sn_dormant = 0 OR sn_dormant IS NULL)
          AND (
            LTRIM(RTRIM(UPPER(sn_analsys))) = 'GC'
            OR RTRIM(sn_account) IN (${placeholders})
          )
        ORDER BY sn_name
      `;
            params = [...mandatedAccounts];
        }
        else {
            sql = `
        SELECT sn_account, sn_name, sn_analsys, sn_currbal, sn_email
        FROM sname WITH (NOLOCK)
        WHERE (sn_stop = 0 OR sn_stop IS NULL)
          AND (sn_dormant = 0 OR sn_dormant IS NULL)
          AND LTRIM(RTRIM(UPPER(sn_analsys))) = 'GC'
        ORDER BY sn_name
      `;
            params = [];
        }
        const rows = (await operaDb.raw(sql, params));
        const seen = new Set();
        const customers = [];
        for (const r of rows ?? []) {
            const acct = (r.sn_account ?? '').trim();
            if (!acct || seen.has(acct))
                continue;
            seen.add(acct);
            const name = (r.sn_name ?? '').trim();
            const email = (r.sn_email ?? '').trim() || null;
            const m = mandateLookup.get(acct);
            customers.push({
                account: acct,
                name,
                balance: Number(r.sn_currbal ?? 0),
                email,
                has_mandate: !!m,
                mandate_id: m?.mandate_id ?? null,
                mandate_status: m?.mandate_status ?? null,
            });
        }
        const withMandate = customers.reduce((n, c) => n + (c.has_mandate ? 1 : 0), 0);
        const withoutMandate = customers.length - withMandate;
        return {
            success: true,
            customers,
            count: customers.length,
            with_mandate: withMandate,
            without_mandate: withoutMandate,
        };
    }
    catch (err) {
        return {
            success: false,
            customers: [],
            count: 0,
            with_mandate: 0,
            without_mandate: 0,
            error: err?.message ?? String(err),
        };
    }
}
//# sourceMappingURL=eligible-customers.js.map