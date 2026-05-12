import { randomBytes } from 'node:crypto';
import { loadSettings, saveSettings, } from './settings.js';
import { createPartnerClientFromSettings, } from './gocardless-api.js';
function toIso(d) {
    if (!d)
        return null;
    if (d instanceof Date)
        return d.toISOString();
    return String(d);
}
function rowToSignup(row) {
    return {
        id: row.id,
        company_name: row.company_name ?? null,
        company_email: row.company_email ?? null,
        billing_request_id: row.billing_request_id ?? null,
        billing_request_flow_id: row.billing_request_flow_id ?? null,
        authorisation_url: row.authorisation_url ?? null,
        status: row.status ?? 'pending',
        status_detail: row.status_detail ?? null,
        access_token_obtained: !!row.access_token_obtained,
        merchant_organisation_id: row.merchant_organisation_id ?? null,
        merchant_creditor_name: row.merchant_creditor_name ?? null,
        merchant_app_url: row.merchant_app_url ?? null,
        partner_referral_id: row.partner_referral_id ?? null,
        created_at: toIso(row.created_at) ?? '',
        completed_at: toIso(row.completed_at),
        updated_at: toIso(row.updated_at),
        has_token: !!(row.merchant_access_token && row.merchant_access_token.length > 0),
    };
}
export async function getPartnerConfig(appDb, opts = {}) {
    try {
        const settings = await loadSettings(appDb);
        const hasPartner = !!(settings.partner_client_id && settings.partner_client_secret);
        let redirectUri = (settings.partner_redirect_uri ?? '').trim();
        if (!redirectUri) {
            const base = (opts.baseUrl ?? '').replace(/\/+$/, '');
            redirectUri = `${base}/api/gocardless/partner/callback`;
        }
        return {
            success: true,
            partner_configured: hasPartner,
            partner_sandbox: !!settings.api_sandbox,
            redirect_uri: redirectUri,
        };
    }
    catch (err) {
        return {
            success: false,
            partner_configured: false,
            partner_sandbox: false,
            redirect_uri: '',
            error: err?.message ?? String(err),
        };
    }
}
// ---------------------------------------------------------------------
// GET /api/gocardless/partner/signup-status
// ---------------------------------------------------------------------
export async function getLatestPartnerSignup(appDb) {
    try {
        const row = (await appDb('gocardless_partner_signups')
            .orderBy('id', 'desc')
            .first());
        if (!row) {
            return { success: true, signup: null };
        }
        return { success: true, signup: rowToSignup(row) };
    }
    catch (err) {
        return { success: false, signup: null, error: err?.message ?? String(err) };
    }
}
// ---------------------------------------------------------------------
// GET /api/gocardless/partner/merchants
// ---------------------------------------------------------------------
export async function getAllMerchantSignups(appDb, opts = {}) {
    try {
        let query = appDb('gocardless_partner_signups').orderBy('id', 'desc');
        if (opts.status) {
            query = query.where({ status: opts.status });
        }
        const rows = (await query);
        return { success: true, merchants: rows.map(rowToSignup) };
    }
    catch (err) {
        return { success: false, merchants: [], error: err?.message ?? String(err) };
    }
}
// ---------------------------------------------------------------------
// POST /api/gocardless/partner/admin-auth
// ---------------------------------------------------------------------
export async function partnerAdminAuth(appDb, password) {
    try {
        const settings = await loadSettings(appDb);
        const stored = (settings
            .partner_admin_password ?? '').trim();
        if (!stored) {
            // First-time access — allow so the operator can set a password
            return { success: true, first_time: true };
        }
        if ((password ?? '').trim() === stored) {
            return { success: true };
        }
        return { success: false, error: 'Incorrect password' };
    }
    catch (err) {
        return { success: false, error: err?.message ?? String(err) };
    }
}
export async function updateMerchantAppUrl(appDb, input) {
    if (!input.signupId) {
        return { success: false, error: 'No signup ID provided' };
    }
    // Match Python's strip + trailing-slash strip
    const appUrl = (input.appUrl ?? '').trim().replace(/\/+$/, '');
    try {
        const updated = await appDb('gocardless_partner_signups')
            .where({ id: input.signupId })
            .update({
            merchant_app_url: appUrl,
            updated_at: appDb.fn.now(),
        });
        if (!Number(updated)) {
            return { success: false, error: 'Signup record not found' };
        }
        return { success: true };
    }
    catch (err) {
        return { success: false, error: err?.message ?? String(err) };
    }
}
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '0.0.0.0']);
export async function activateMerchant(appDb, input, fetchImpl = fetch) {
    if (!input.signupId) {
        return { success: false, error: 'No signup ID provided' };
    }
    try {
        const signupRow = (await appDb('gocardless_partner_signups')
            .where({ id: input.signupId })
            .first());
        if (!signupRow) {
            return { success: false, error: 'Signup record not found' };
        }
        const token = (signupRow.merchant_access_token ?? '').trim();
        if (!token) {
            return {
                success: false,
                error: 'No access token for this merchant — signup may not be complete',
            };
        }
        const appUrl = (signupRow.merchant_app_url ?? '').trim().replace(/\/+$/, '');
        if (!appUrl) {
            return {
                success: false,
                error: 'No app URL configured for this merchant',
            };
        }
        const companyName = (signupRow.merchant_creditor_name ?? '').trim() ||
            (signupRow.company_name ?? '').trim();
        let parsed;
        try {
            parsed = new URL(appUrl);
        }
        catch {
            return { success: false, error: `Invalid app URL: ${appUrl}` };
        }
        const isLocal = LOCAL_HOSTS.has(parsed.hostname);
        if (isLocal) {
            // Deploy locally — write to our own settings (api_access_token)
            const existingSettings = await loadSettings(appDb);
            const merged = {
                ...existingSettings,
                api_access_token: token,
            };
            const ok = await saveSettings(appDb, merged);
            if (!ok)
                return { success: false, error: 'Failed to save local settings' };
        }
        else {
            // Deploy remotely — push token to merchant's deploy-token endpoint
            try {
                const ac = new AbortController();
                const timer = setTimeout(() => ac.abort(), 15000);
                let resp;
                try {
                    resp = await fetchImpl(`${appUrl}/api/gocardless/deploy-token`, {
                        method: 'PUT',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            access_token: token,
                            company_name: companyName,
                        }),
                        signal: ac.signal,
                    });
                }
                finally {
                    clearTimeout(timer);
                }
                if (resp.status !== 200) {
                    const text = (await resp.text().catch(() => '')).slice(0, 200);
                    return {
                        success: false,
                        error: `Remote app returned ${resp.status}: ${text}`,
                    };
                }
                const data = (await resp.json().catch(() => ({})));
                if (!data.success) {
                    return {
                        success: false,
                        error: data.error ?? 'Remote app rejected the token',
                    };
                }
            }
            catch (e) {
                return {
                    success: false,
                    error: `Cannot reach merchant app at ${appUrl}: ${e?.message ?? String(e)}`,
                };
            }
        }
        // Mark as activated
        await appDb('gocardless_partner_signups')
            .where({ id: input.signupId })
            .update({ status: 'activated', updated_at: appDb.fn.now() });
        return {
            success: true,
            company_name: companyName,
            app_url: appUrl,
            message: `Token deployed for ${companyName}`,
        };
    }
    catch (err) {
        return { success: false, error: err?.message ?? String(err) };
    }
}
export async function deployToken(appDb, input) {
    const token = (input.access_token ?? '').trim();
    if (!token) {
        return { success: false, error: 'No token provided' };
    }
    try {
        const existing = await loadSettings(appDb);
        const merged = {
            ...existing,
            api_access_token: token,
        };
        const ok = await saveSettings(appDb, merged);
        if (!ok)
            return { success: false, error: 'Failed to save settings' };
        return {
            success: true,
            message: `Token deployed for ${(input.company_name ?? '').trim()}`,
        };
    }
    catch (err) {
        return { success: false, error: err?.message ?? String(err) };
    }
}
function urlSafeToken(byteLen = 32) {
    return randomBytes(byteLen)
        .toString('base64')
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/, '');
}
export async function initiatePartnerSignup(appDb, input, fetchImpl = fetch) {
    const companyName = (input.companyName ?? '').trim();
    const companyEmail = (input.companyEmail ?? '').trim();
    if (!companyEmail) {
        return { success: false, error: 'Company email is required' };
    }
    try {
        const settings = await loadSettings(appDb);
        const partnerClient = createPartnerClientFromSettings(settings, fetchImpl);
        const stateToken = urlSafeToken();
        let authorisationUrl = null;
        if (partnerClient) {
            let redirectUri = (settings.partner_redirect_uri ?? '').trim();
            if (!redirectUri) {
                const base = (input.baseUrl ?? '').replace(/\/+$/, '');
                redirectUri = `${base}/api/gocardless/partner/callback`;
            }
            authorisationUrl = partnerClient.getAuthorisationUrl({
                redirectUri,
                prefillEmail: companyEmail,
                prefillCompanyName: companyName,
                state: stateToken,
            });
        }
        // Insert the signup row + store state token in status_detail (CSRF
        // validation on callback). Faithful to Python:
        //   create_partner_signup(...); update_partner_signup(id, status_detail=state)
        const inserted = await appDb('gocardless_partner_signups')
            .insert({
            company_name: companyName,
            company_email: companyEmail,
            authorisation_url: authorisationUrl,
            status_detail: stateToken,
            status: 'pending',
            updated_at: appDb.fn.now(),
        })
            .returning('id');
        const signupId = Array.isArray(inserted) && inserted.length > 0
            ? typeof inserted[0] === 'object'
                ? inserted[0].id
                : Number(inserted[0])
            : 0;
        if (authorisationUrl) {
            return {
                success: true,
                signup_id: signupId,
                authorisation_url: authorisationUrl,
                message: 'Redirecting to GoCardless to complete registration.',
            };
        }
        return {
            success: true,
            signup_id: signupId,
            authorisation_url: null,
            message: 'Partner credentials not configured. Please register at GoCardless and enter your API key in Settings.',
            next_step: 'manual',
        };
    }
    catch (err) {
        return { success: false, error: err?.message ?? String(err) };
    }
}
export async function handlePartnerCallback(appDb, input, fetchImpl = fetch) {
    if (input.error) {
        return {
            ok: false,
            title: 'Signup Error',
            message: `GoCardless returned an error: ${input.error}`,
        };
    }
    const code = (input.code ?? '').trim();
    if (!code) {
        return {
            ok: false,
            title: 'Missing Code',
            message: 'No authorisation code received from GoCardless.',
        };
    }
    try {
        const settings = await loadSettings(appDb);
        const partnerClient = createPartnerClientFromSettings(settings, fetchImpl);
        if (!partnerClient) {
            return {
                ok: false,
                title: 'Not Configured',
                message: 'Partner credentials not configured.',
            };
        }
        // CSRF validation: the state token we issued in initiate-signup is
        // stored in status_detail of the latest signup row.
        const latest = (await appDb('gocardless_partner_signups')
            .orderBy('id', 'desc')
            .first());
        if (latest && input.state && latest.status_detail !== input.state) {
            return {
                ok: false,
                title: 'Invalid Request',
                message: 'Invalid state token — please try signing up again.',
            };
        }
        let redirectUri = (settings.partner_redirect_uri ?? '').trim();
        if (!redirectUri) {
            const base = (input.baseUrl ?? '').replace(/\/+$/, '');
            redirectUri = `${base}/api/gocardless/partner/callback`;
        }
        const exchange = await partnerClient.exchangeAuthorisationCode(code, redirectUri);
        if (!exchange.success || !exchange.data) {
            return {
                ok: false,
                title: 'Connection Failed',
                message: exchange.error ?? 'Token exchange failed.',
            };
        }
        const accessToken = exchange.data.access_token;
        const organisationId = (exchange.data.organisation_id ?? '').toString();
        if (!accessToken) {
            return {
                ok: false,
                title: 'Connection Failed',
                message: 'No access token received from GoCardless.',
            };
        }
        let creditorName = '';
        try {
            const orgInfo = await partnerClient.getOrganisationInfo(accessToken);
            if (orgInfo.success && orgInfo.organisation) {
                creditorName = String(orgInfo.organisation.name ?? '').trim();
            }
        }
        catch {
            // best-effort
        }
        if (latest) {
            await appDb('gocardless_partner_signups')
                .where({ id: latest.id })
                .update({
                status: 'completed',
                completed_at: appDb.fn.now(),
                access_token_obtained: true,
                merchant_access_token: accessToken,
                merchant_organisation_id: organisationId || null,
                merchant_creditor_name: creditorName || null,
                partner_referral_id: organisationId || null,
                status_detail: 'OAuth token obtained successfully',
                updated_at: appDb.fn.now(),
            });
        }
        const orgDisplay = creditorName ? ` (${creditorName})` : '';
        return {
            ok: true,
            title: 'Account Connected',
            message: `Your GoCardless account${orgDisplay} has been connected successfully. The signup page will update automatically.`,
        };
    }
    catch (err) {
        return {
            ok: false,
            title: 'Connection Failed',
            message: `Something went wrong: ${err?.message ?? String(err)}`,
        };
    }
}
/** Build the friendly HTML page the OAuth callback shows the merchant. */
export function partnerCallbackHtml(result) {
    const color = result.ok ? '#10b981' : '#ef4444';
    const icon = result.ok ? '&#10003;' : '&#10007;';
    // Mirror Python's HTML format byte-for-byte (matches snapshot tests in
    // the future + existing UI styling expectations).
    return `<!DOCTYPE html>
<html><head><meta charset="UTF-8"><title>${result.title}</title>
<style>body{font-family:Inter,system-ui,sans-serif;display:flex;justify-content:center;align-items:center;min-height:100vh;margin:0;background:#f8fafc}
.card{text-align:center;max-width:420px;padding:3rem;background:white;border-radius:1rem;box-shadow:0 4px 24px rgba(0,0,0,0.08)}
.icon{font-size:3rem;color:${color};margin-bottom:1rem}.title{font-size:1.25rem;font-weight:700;margin-bottom:0.5rem}
.msg{color:#64748b;font-size:0.95rem;line-height:1.5}.hint{margin-top:1.5rem;color:#94a3b8;font-size:0.85rem}</style></head>
<body><div class="card"><div class="icon">${icon}</div><div class="title">${result.title}</div>
<div class="msg">${result.message}</div><div class="hint">You can close this tab and return to the signup page.</div></div></body></html>`;
}
// ---------------------------------------------------------------------
// PUT /api/gocardless/partner/admin-password
// ---------------------------------------------------------------------
export async function setPartnerAdminPassword(appDb, newPassword) {
    const trimmed = (newPassword ?? '').trim();
    if (!trimmed || trimmed.length < 4) {
        return { success: false, error: 'Password must be at least 4 characters' };
    }
    try {
        const settings = await loadSettings(appDb);
        const merged = {
            ...settings,
            partner_admin_password: trimmed,
        };
        const ok = await saveSettings(appDb, merged);
        if (!ok)
            return { success: false, error: 'Failed to save' };
        return { success: true };
    }
    catch (err) {
        return { success: false, error: err?.message ?? String(err) };
    }
}
//# sourceMappingURL=partner.js.map