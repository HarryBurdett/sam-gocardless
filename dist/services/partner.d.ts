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
export interface GetPartnerConfigOptions {
    /**
     * Origin/base URL the request came from, used to build the redirect_uri
     * fallback when no explicit `partner_redirect_uri` is configured.
     * Mirrors Python's `request.base_url` usage.
     */
    baseUrl?: string;
}
export declare function getPartnerConfig(appDb: Knex, opts?: GetPartnerConfigOptions): Promise<PartnerConfigResponse>;
export declare function getLatestPartnerSignup(appDb: Knex): Promise<SignupStatusResponse>;
export declare function getAllMerchantSignups(appDb: Knex, opts?: {
    status?: string | null;
}): Promise<MerchantsResponse>;
export declare function partnerAdminAuth(appDb: Knex, password: string): Promise<AdminAuthResponse>;
export interface UpdateMerchantAppUrlInput {
    signupId: number;
    appUrl: string;
}
export interface UpdateMerchantAppUrlResponse {
    success: boolean;
    error?: string;
}
export declare function updateMerchantAppUrl(appDb: Knex, input: UpdateMerchantAppUrlInput): Promise<UpdateMerchantAppUrlResponse>;
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
export declare function activateMerchant(appDb: Knex, input: ActivateMerchantInput, fetchImpl?: typeof fetch): Promise<ActivateMerchantResponse>;
export interface DeployTokenInput {
    access_token?: string;
    company_name?: string;
}
export interface DeployTokenResponse {
    success: boolean;
    message?: string;
    error?: string;
}
export declare function deployToken(appDb: Knex, input: DeployTokenInput): Promise<DeployTokenResponse>;
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
export declare function initiatePartnerSignup(appDb: Knex, input: InitiateSignupInput, fetchImpl?: typeof fetch): Promise<InitiateSignupResponse>;
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
export declare function handlePartnerCallback(appDb: Knex, input: PartnerCallbackInput, fetchImpl?: typeof fetch): Promise<PartnerCallbackResult>;
/** Build the friendly HTML page the OAuth callback shows the merchant. */
export declare function partnerCallbackHtml(result: PartnerCallbackResult): string;
export declare function setPartnerAdminPassword(appDb: Knex, newPassword: string): Promise<AdminPasswordResponse>;
//# sourceMappingURL=partner.d.ts.map