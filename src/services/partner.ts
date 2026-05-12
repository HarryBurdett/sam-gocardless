/**
 * GoCardless partner-portal helpers.
 *
 * Faithful port of the partner endpoints in
 * `apps/gocardless/api/routes.py:1322-1522` and the supporting
 * GoCardlessPaymentsDB methods in `sql_rag/gocardless_payments.py`.
 *
 * Three read endpoints + admin-auth helpers:
 *   - GET  /api/gocardless/partner/config           (partner-configured probe)
 *   - GET  /api/gocardless/partner/signup-status    (latest signup, token stripped)
 *   - GET  /api/gocardless/partner/merchants        (all signups, tokens stripped)
 *   - POST /api/gocardless/partner/admin-auth       (admin-password gate)
 *   - PUT  /api/gocardless/partner/admin-password   (set/change admin password)
 *
 * Token redaction: `merchant_access_token` is NEVER returned to the
 * frontend — the response gets a `has_token: bool` instead.
 */
import type { Knex } from 'knex';
import { randomBytes } from 'node:crypto';
import {
  loadSettings,
  saveSettings,
  type GoCardlessSettings,
} from './settings.js';
import {
  createPartnerClientFromSettings,
} from './gocardless-api.js';

// ---------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------

export interface PartnerConfigResponse {
  success: boolean;
  partner_configured: boolean;
  partner_sandbox: boolean;
  redirect_uri: string;
  error?: string;
}

export interface PartnerSignup {
  id: number;
  company_name: string | null;
  company_email: string | null;
  billing_request_id: string | null;
  billing_request_flow_id: string | null;
  authorisation_url: string | null;
  status: string;
  status_detail: string | null;
  access_token_obtained: boolean;
  merchant_organisation_id: string | null;
  merchant_creditor_name: string | null;
  merchant_app_url: string | null;
  partner_referral_id: string | null;
  created_at: string;
  completed_at: string | null;
  updated_at: string | null;
  /** True when merchant_access_token is set; the token itself is never returned. */
  has_token: boolean;
}

export interface SignupStatusResponse {
  success: boolean;
  signup: PartnerSignup | null;
  error?: string;
}

export interface MerchantsResponse {
  success: boolean;
  merchants: PartnerSignup[];
  error?: string;
}

export interface AdminAuthResponse {
  success: boolean;
  first_time?: boolean;
  error?: string;
}

export interface AdminPasswordResponse {
  success: boolean;
  error?: string;
}

// ---------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------

interface SignupRow {
  id: number;
  company_name: string | null;
  company_email: string | null;
  billing_request_id: string | null;
  billing_request_flow_id: string | null;
  authorisation_url: string | null;
  status: string | null;
  status_detail: string | null;
  access_token_obtained: number | boolean | null;
  merchant_access_token: string | null;
  merchant_organisation_id: string | null;
  merchant_creditor_name: string | null;
  merchant_app_url: string | null;
  partner_referral_id: string | null;
  created_at: Date | string;
  completed_at: Date | string | null;
  updated_at: Date | string | null;
}

function toIso(d: Date | string | null | undefined): string | null {
  if (!d) return null;
  if (d instanceof Date) return d.toISOString();
  return String(d);
}

function rowToSignup(row: SignupRow): PartnerSignup {
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

// ---------------------------------------------------------------------
// GET /api/gocardless/partner/config
// ---------------------------------------------------------------------

export interface GetPartnerConfigOptions {
  /**
   * Origin/base URL the request came from, used to build the redirect_uri
   * fallback when no explicit `partner_redirect_uri` is configured.
   * Mirrors Python's `request.base_url` usage.
   */
  baseUrl?: string;
}

export async function getPartnerConfig(
  appDb: Knex,
  opts: GetPartnerConfigOptions = {},
): Promise<PartnerConfigResponse> {
  try {
    const settings = await loadSettings(appDb);
    const hasPartner = !!(
      settings.partner_client_id && settings.partner_client_secret
    );
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
  } catch (err: any) {
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

export async function getLatestPartnerSignup(
  appDb: Knex,
): Promise<SignupStatusResponse> {
  try {
    const row = (await appDb('gocardless_partner_signups')
      .orderBy('id', 'desc')
      .first()) as SignupRow | undefined;
    if (!row) {
      return { success: true, signup: null };
    }
    return { success: true, signup: rowToSignup(row) };
  } catch (err: any) {
    return { success: false, signup: null, error: err?.message ?? String(err) };
  }
}

// ---------------------------------------------------------------------
// GET /api/gocardless/partner/merchants
// ---------------------------------------------------------------------

export async function getAllMerchantSignups(
  appDb: Knex,
  opts: { status?: string | null } = {},
): Promise<MerchantsResponse> {
  try {
    let query = appDb('gocardless_partner_signups').orderBy('id', 'desc');
    if (opts.status) {
      query = query.where({ status: opts.status });
    }
    const rows = (await query) as unknown as SignupRow[];
    return { success: true, merchants: rows.map(rowToSignup) };
  } catch (err: any) {
    return { success: false, merchants: [], error: err?.message ?? String(err) };
  }
}

// ---------------------------------------------------------------------
// POST /api/gocardless/partner/admin-auth
// ---------------------------------------------------------------------

export async function partnerAdminAuth(
  appDb: Knex,
  password: string,
): Promise<AdminAuthResponse> {
  try {
    const settings = await loadSettings(appDb);
    const stored = (
      (settings as GoCardlessSettings & { partner_admin_password?: string })
        .partner_admin_password ?? ''
    ).trim();
    if (!stored) {
      // First-time access — allow so the operator can set a password
      return { success: true, first_time: true };
    }
    if ((password ?? '').trim() === stored) {
      return { success: true };
    }
    return { success: false, error: 'Incorrect password' };
  } catch (err: any) {
    return { success: false, error: err?.message ?? String(err) };
  }
}

// ---------------------------------------------------------------------
// PUT /api/gocardless/partner/merchant-app-url
// ---------------------------------------------------------------------

export interface UpdateMerchantAppUrlInput {
  signupId: number;
  appUrl: string;
}

export interface UpdateMerchantAppUrlResponse {
  success: boolean;
  error?: string;
}

export async function updateMerchantAppUrl(
  appDb: Knex,
  input: UpdateMerchantAppUrlInput,
): Promise<UpdateMerchantAppUrlResponse> {
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
  } catch (err: any) {
    return { success: false, error: err?.message ?? String(err) };
  }
}

// ---------------------------------------------------------------------
// POST /api/gocardless/partner/activate-merchant
// ---------------------------------------------------------------------

export interface ActivateMerchantInput {
  signupId: number;
}

export interface ActivateMerchantResponse {
  success: boolean;
  company_name?: string;
  app_url?: string;
  message?: string;
  error?: string;
}

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '0.0.0.0']);

export async function activateMerchant(
  appDb: Knex,
  input: ActivateMerchantInput,
  fetchImpl: typeof fetch = fetch,
): Promise<ActivateMerchantResponse> {
  if (!input.signupId) {
    return { success: false, error: 'No signup ID provided' };
  }

  try {
    const signupRow = (await appDb('gocardless_partner_signups')
      .where({ id: input.signupId })
      .first()) as SignupRow | undefined;

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

    const companyName =
      (signupRow.merchant_creditor_name ?? '').trim() ||
      (signupRow.company_name ?? '').trim();

    let parsed: URL;
    try {
      parsed = new URL(appUrl);
    } catch {
      return { success: false, error: `Invalid app URL: ${appUrl}` };
    }
    const isLocal = LOCAL_HOSTS.has(parsed.hostname);

    if (isLocal) {
      // Deploy locally — write to our own settings (api_access_token)
      const existingSettings = await loadSettings(appDb);
      const merged: GoCardlessSettings = {
        ...existingSettings,
        api_access_token: token,
      };
      const ok = await saveSettings(appDb, merged);
      if (!ok) return { success: false, error: 'Failed to save local settings' };
    } else {
      // Deploy remotely — push token to merchant's deploy-token endpoint
      try {
        const ac = new AbortController();
        const timer = setTimeout(() => ac.abort(), 15000);
        let resp: Response;
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
        } finally {
          clearTimeout(timer);
        }
        if (resp.status !== 200) {
          const text = (await resp.text().catch(() => '')).slice(0, 200);
          return {
            success: false,
            error: `Remote app returned ${resp.status}: ${text}`,
          };
        }
        const data = (await resp.json().catch(() => ({}))) as {
          success?: boolean;
          error?: string;
        };
        if (!data.success) {
          return {
            success: false,
            error: data.error ?? 'Remote app rejected the token',
          };
        }
      } catch (e: any) {
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
  } catch (err: any) {
    return { success: false, error: err?.message ?? String(err) };
  }
}

// ---------------------------------------------------------------------
// PUT /api/gocardless/deploy-token (receive a token from partner portal)
// ---------------------------------------------------------------------

export interface DeployTokenInput {
  access_token?: string;
  company_name?: string;
}

export interface DeployTokenResponse {
  success: boolean;
  message?: string;
  error?: string;
}

export async function deployToken(
  appDb: Knex,
  input: DeployTokenInput,
): Promise<DeployTokenResponse> {
  const token = (input.access_token ?? '').trim();
  if (!token) {
    return { success: false, error: 'No token provided' };
  }
  try {
    const existing = await loadSettings(appDb);
    const merged: GoCardlessSettings = {
      ...existing,
      api_access_token: token,
    };
    const ok = await saveSettings(appDb, merged);
    if (!ok) return { success: false, error: 'Failed to save settings' };
    return {
      success: true,
      message: `Token deployed for ${(input.company_name ?? '').trim()}`,
    };
  } catch (err: any) {
    return { success: false, error: err?.message ?? String(err) };
  }
}

// ---------------------------------------------------------------------
// POST /api/gocardless/partner/initiate-signup
// ---------------------------------------------------------------------

export interface InitiateSignupInput {
  companyName?: string;
  companyEmail: string;
  /** Origin/base URL for the redirect_uri fallback. */
  baseUrl?: string;
}

export interface InitiateSignupResponse {
  success: boolean;
  signup_id?: number;
  authorisation_url?: string | null;
  message?: string;
  next_step?: string;
  error?: string;
}

function urlSafeToken(byteLen: number = 32): string {
  return randomBytes(byteLen)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

export async function initiatePartnerSignup(
  appDb: Knex,
  input: InitiateSignupInput,
  fetchImpl: typeof fetch = fetch,
): Promise<InitiateSignupResponse> {
  const companyName = (input.companyName ?? '').trim();
  const companyEmail = (input.companyEmail ?? '').trim();
  if (!companyEmail) {
    return { success: false, error: 'Company email is required' };
  }

  try {
    const settings = await loadSettings(appDb);
    const partnerClient = createPartnerClientFromSettings(settings, fetchImpl);
    const stateToken = urlSafeToken();

    let authorisationUrl: string | null = null;
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
    const signupId =
      Array.isArray(inserted) && inserted.length > 0
        ? typeof inserted[0] === 'object'
          ? (inserted[0] as { id: number }).id
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
      message:
        'Partner credentials not configured. Please register at GoCardless and enter your API key in Settings.',
      next_step: 'manual',
    };
  } catch (err: any) {
    return { success: false, error: err?.message ?? String(err) };
  }
}

// ---------------------------------------------------------------------
// GET /api/gocardless/partner/callback (OAuth redirect target)
// ---------------------------------------------------------------------

export interface PartnerCallbackInput {
  code?: string | null;
  state?: string | null;
  error?: string | null;
  baseUrl?: string;
}

export interface PartnerCallbackResult {
  ok: boolean;
  title: string;
  message: string;
}

export async function handlePartnerCallback(
  appDb: Knex,
  input: PartnerCallbackInput,
  fetchImpl: typeof fetch = fetch,
): Promise<PartnerCallbackResult> {
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
      .first()) as
      | { id: number; status_detail: string | null }
      | undefined;
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

    const exchange = await partnerClient.exchangeAuthorisationCode(
      code,
      redirectUri,
    );
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
    } catch {
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
  } catch (err: any) {
    return {
      ok: false,
      title: 'Connection Failed',
      message: `Something went wrong: ${err?.message ?? String(err)}`,
    };
  }
}

/** Build the friendly HTML page the OAuth callback shows the merchant. */
export function partnerCallbackHtml(result: PartnerCallbackResult): string {
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

export async function setPartnerAdminPassword(
  appDb: Knex,
  newPassword: string,
): Promise<AdminPasswordResponse> {
  const trimmed = (newPassword ?? '').trim();
  if (!trimmed || trimmed.length < 4) {
    return { success: false, error: 'Password must be at least 4 characters' };
  }
  try {
    const settings = await loadSettings(appDb);
    const merged = {
      ...settings,
      partner_admin_password: trimmed,
    } as GoCardlessSettings & { partner_admin_password: string };
    const ok = await saveSettings(appDb, merged);
    if (!ok) return { success: false, error: 'Failed to save' };
    return { success: true };
  } catch (err: any) {
    return { success: false, error: err?.message ?? String(err) };
  }
}
