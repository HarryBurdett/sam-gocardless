import { fetchVatCodesWithRates } from '../_shared/index.js';
import { loadSettings } from './settings.js';
export async function getBatchTypes(operaDb) {
    try {
        const rows = (await operaDb.raw(`
      SELECT ay_cbtype, ay_desc, ay_batched
      FROM atype
      WHERE ay_type = 'R' AND ay_batched = 1
      ORDER BY ay_desc
    `));
        if (!Array.isArray(rows) || rows.length === 0) {
            return {
                success: true,
                batch_types: [],
                warning: 'No batched receipt types found. You may need to create a GoCardless type in Opera.',
            };
        }
        const types = rows.map((row) => {
            const desc = row.ay_desc ? String(row.ay_desc).trim() : '';
            return {
                code: row.ay_cbtype ? String(row.ay_cbtype).trim() : '',
                description: desc,
                is_gocardless: desc.toLowerCase().includes('gocardless'),
            };
        });
        const recommended = types.find((t) => t.is_gocardless) ?? types[0] ?? null;
        return { success: true, batch_types: types, recommended };
    }
    catch (err) {
        return { success: false, batch_types: [], error: err?.message ?? String(err) };
    }
}
export async function getNominalAccounts(operaDb) {
    try {
        const rows = (await operaDb.raw(`
      SELECT na_acnt, na_desc,
             ISNULL(na_allwprj, 0) as na_allwprj,
             ISNULL(na_allwjob, 0) as na_allwjob,
             RTRIM(ISNULL(na_project, '')) as na_project,
             RTRIM(ISNULL(na_job, '')) as na_job
      FROM nacnt WITH (NOLOCK)
      WHERE na_acnt NOT LIKE 'Z%'
      ORDER BY na_acnt
    `));
        if (!Array.isArray(rows) || rows.length === 0) {
            return { success: true, accounts: [] };
        }
        const accounts = rows.map((row) => ({
            code: row.na_acnt ? String(row.na_acnt).trim() : '',
            description: row.na_desc ? String(row.na_desc).trim() : '',
            allow_project: Number(row.na_allwprj ?? 0),
            allow_department: Number(row.na_allwjob ?? 0),
            default_project: (row.na_project ?? '').trim(),
            default_department: (row.na_job ?? '').trim(),
        }));
        return { success: true, accounts };
    }
    catch (err) {
        return { success: false, accounts: [], error: err?.message ?? String(err) };
    }
}
export async function getPaymentTypes(operaDb) {
    try {
        const rows = (await operaDb.raw(`
      SELECT ay_cbtype, ay_desc
      FROM atype WITH (NOLOCK)
      WHERE ay_type = 'P' AND (ay_batched = 0 OR ay_batched IS NULL)
      ORDER BY ay_cbtype
    `));
        if (!Array.isArray(rows) || rows.length === 0) {
            return { success: true, types: [] };
        }
        const types = rows.map((row) => ({
            code: row.ay_cbtype ? String(row.ay_cbtype).trim() : '',
            description: row.ay_desc ? String(row.ay_desc).trim() : '',
        }));
        return { success: true, types };
    }
    catch (err) {
        return { success: false, types: [], error: err?.message ?? String(err) };
    }
}
export async function getVatCodes(operaDb, asOfDate = null) {
    try {
        let refDate;
        if (asOfDate) {
            const parsed = new Date(asOfDate);
            refDate = Number.isNaN(parsed.getTime()) ? new Date() : parsed;
        }
        else {
            refDate = new Date();
        }
        const result = await fetchVatCodesWithRates(operaDb, refDate);
        const codes = result.vatCodes.map((c) => ({
            code: c.code,
            description: c.description,
            rate: c.rate,
            type: c.type,
            nominal_account: c.nominal_account,
        }));
        return {
            success: true,
            codes,
            as_of_date: refDate.toISOString().slice(0, 10),
        };
    }
    catch (err) {
        return {
            success: false,
            codes: [],
            as_of_date: new Date().toISOString().slice(0, 10),
            error: err?.message ?? String(err),
        };
    }
}
export async function getBankAccounts(operaDb) {
    try {
        const rows = (await operaDb.raw(`
      SELECT nk_acnt, nk_desc
      FROM nbank WITH (NOLOCK)
      ORDER BY nk_acnt
    `));
        if (!Array.isArray(rows) || rows.length === 0) {
            return { success: true, accounts: [] };
        }
        const accounts = rows.map((row) => ({
            code: row.nk_acnt ? String(row.nk_acnt).trim() : '',
            description: row.nk_desc ? String(row.nk_desc).trim() : '',
        }));
        return { success: true, accounts };
    }
    catch (err) {
        return { success: false, accounts: [], error: err?.message ?? String(err) };
    }
}
/**
 * Consolidated endpoint returning batch_types, nominal_accounts, and
 * vat_codes in a single response to reduce frontend round-trips.
 *
 * Faithful port of `get_gocardless_import_config`
 * (apps/gocardless/api/routes.py:1881). Note the consolidated
 * endpoint renames the per-endpoint `codes` to `vat_codes` (and
 * `as_of_date` to `vat_as_of_date`) to avoid name collisions with
 * batch_types — matches the legacy contract exactly.
 */
export async function getImportConfig(operaDb, asOfDate = null) {
    try {
        const [batches, accounts, vat] = await Promise.all([
            getBatchTypes(operaDb),
            getNominalAccounts(operaDb),
            getVatCodes(operaDb, asOfDate),
        ]);
        return {
            success: true,
            batch_types: batches.batch_types,
            batch_types_recommended: batches.recommended ?? null,
            nominal_accounts: accounts.accounts,
            vat_codes: vat.codes,
            vat_as_of_date: vat.as_of_date,
        };
    }
    catch (err) {
        return {
            success: false,
            batch_types: [],
            batch_types_recommended: null,
            nominal_accounts: [],
            vat_codes: [],
            vat_as_of_date: new Date().toISOString().slice(0, 10),
            error: err?.message ?? String(err),
        };
    }
}
export async function getSetupStatus(appDb) {
    let settings = null;
    if (appDb) {
        try {
            settings = await loadSettings(appDb);
        }
        catch {
            // No settings = not configured
        }
    }
    const apiToken = settings?.api_access_token ?? '';
    const configured = Boolean(apiToken && apiToken.length > 10);
    let pendingSignup = null;
    if (!configured && appDb) {
        try {
            const rows = (await appDb('gocardless_partner_signups')
                .orderBy('created_at', 'desc')
                .first());
            if (rows && rows.status !== 'completed' && rows.status !== 'failed') {
                pendingSignup = rows;
            }
        }
        catch {
            // Table may not exist yet
        }
    }
    return {
        success: true,
        configured,
        pending_signup: pendingSignup,
    };
}
//# sourceMappingURL=lookups.js.map