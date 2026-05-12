/**
 * Minimal GoCardless REST API client.
 *
 * Faithful port of the bits of `sql_rag/gocardless_api.py` we need
 * for test-api. Other client methods (get_payouts, create_payment,
 * etc.) ported as needed in subsequent sessions.
 *
 * Uses native fetch (Node 18+) to avoid the axios dependency in the
 * Python version.
 */
export interface GoCardlessClientOptions {
    accessToken: string;
    sandbox?: boolean;
}
export interface TestConnectionResult {
    success: boolean;
    message?: string;
    organisation?: string;
    environment?: 'sandbox' | 'live';
    error?: string;
}
export declare class GoCardlessClient {
    private accessToken;
    private baseUrl;
    private environment;
    constructor(opts: GoCardlessClientOptions);
    private request;
    /**
     * GET /payouts — list payouts with optional filters.
     *
     * Faithful port of the get_payouts call in
     * sql_rag/gocardless_api.py. Returns the raw payouts array plus
     * the cursor `before` from GoCardless's pagination metadata.
     *
     * NB: this returns raw GoCardless objects. The matching/import
     * pipeline that joins payouts → payments → mandates → customers
     * lives elsewhere (and isn't ported in this session).
     */
    getPayouts(opts?: {
        status?: string;
        limit?: number;
        createdAtGte?: string;
        before?: string;
    }): Promise<{
        success: boolean;
        payouts: Array<Record<string, unknown>>;
        before: string | null;
        error?: string;
    }>;
    /**
     * POST /payments/:id/actions/cancel — cancel a pending payment.
     *
     * Faithful port of the cancel_payment call used by
     * cancel_payment_request (apps/gocardless/api/routes.py:8509-8553).
     * Returns a uniform shape rather than throwing so callers can fall
     * back to local-only cancellation if the API call fails (matches
     * Python's "log and continue" behaviour).
     */
    cancelPayment(paymentId: string): Promise<{
        success: boolean;
        data?: Record<string, unknown>;
        error?: string;
    }>;
    /**
     * GET /payments/:id — fetch a single payment's current status.
     *
     * Used by payment-requests/sync to reconcile local state with
     * GoCardless's view of each pending payment.
     */
    getPayment(paymentId: string): Promise<{
        success: boolean;
        payment?: {
            id?: string;
            status?: string;
            charge_date?: string;
            amount?: number;
            [k: string]: unknown;
        };
        error?: string;
    }>;
    /**
     * GET /billing_requests/:id — fetch a billing request's current state.
     *
     * Used by the check-setups poll endpoint to detect when a customer
     * has completed their authorisation and a mandate has been minted.
     */
    getBillingRequest(billingRequestId: string): Promise<{
        success: boolean;
        billingRequest?: Record<string, unknown>;
        error?: string;
    }>;
    /**
     * POST /billing_requests — create a new billing request.
     *
     * Faithful port of GoCardlessClient.create_billing_request — used
     * by the mandate-setup flow to generate a hosted authorisation
     * URL the customer can use to sign the Direct Debit.
     */
    createBillingRequest(opts: {
        customerEmail: string;
        customerName?: string | null;
        description?: string | null;
        metadata?: Record<string, string> | null;
    }): Promise<{
        success: boolean;
        billingRequest?: Record<string, unknown>;
        error?: string;
    }>;
    /**
     * POST /billing_request_flows — create the hosted-payment-pages flow
     * URL for an existing billing request. Returns `{authorisation_url}`.
     */
    createBillingRequestFlow(opts: {
        billingRequestId: string;
        redirectUri?: string | null;
        exitUri?: string | null;
    }): Promise<{
        success: boolean;
        flow?: Record<string, unknown>;
        error?: string;
    }>;
    /**
     * GET /mandates — list mandates.
     *
     * Faithful port of GoCardlessClient.list_mandates. Returns a page
     * of raw mandate objects + the next-page cursor. Used by the
     * mandate-sync flow to walk every mandate in the GoCardless org.
     */
    listMandates(opts?: {
        customerId?: string;
        status?: string;
        limit?: number;
        cursor?: string;
    }): Promise<{
        success: boolean;
        mandates: Array<Record<string, unknown>>;
        after: string | null;
        error?: string;
    }>;
    /**
     * GET /mandates/:id — fetch a mandate's current state.
     *
     * Faithful port of GoCardlessClient.get_mandate
     * (sql_rag/gocardless_api.py). Returns the raw GoCardless mandate
     * object. 404s and errors are surfaced as success=false with a
     * friendly message; callers can fall back to local data.
     */
    getMandate(mandateId: string): Promise<{
        success: boolean;
        mandate?: Record<string, unknown>;
        error?: string;
    }>;
    /**
     * GET /customers/:id — fetch a customer's contact details.
     *
     * Faithful port of GoCardlessClient.get_customer. Used during
     * mandate-link to harvest the customer email.
     */
    getCustomer(customerId: string): Promise<{
        success: boolean;
        customer?: Record<string, unknown>;
        error?: string;
    }>;
    /**
     * POST /mandates/:id/actions/cancel — cancel a mandate.
     *
     * Faithful port of the cancel call wrapped by
     * cancel_gocardless_mandate (apps/gocardless/api/routes.py
     * :6795-6830). Returns uniform shape so the wrapping service can
     * detect "already cancelled" responses gracefully (Python's source
     * treats them as success too).
     */
    cancelMandate(mandateId: string): Promise<{
        success: boolean;
        status?: string;
        error?: string;
        alreadyCancelled?: boolean;
    }>;
    /**
     * POST /payments — create a new payment against a mandate.
     *
     * Faithful port of GoCardlessClient.create_payment
     * (sql_rag/gocardless_api.py:329-380). Uniform `{success, payment?,
     * error?}` shape so callers can compose without exception-handling.
     */
    createPayment(opts: {
        amountPence: number;
        mandateId: string;
        description?: string | null;
        chargeDate?: string | null;
        currency?: string;
        metadata?: Record<string, string> | null;
        reference?: string | null;
        retryIfPossible?: boolean;
    }): Promise<{
        success: boolean;
        payment?: Record<string, unknown>;
        error?: string;
    }>;
    /**
     * POST /subscriptions — create a new subscription against a mandate.
     *
     * Faithful port of GoCardlessClient.create_subscription
     * (sql_rag/gocardless_api.py:434-485). Returns uniform shape
     * `{success, subscription?, error?}` so callers can compose without
     * exception-handling.
     */
    createSubscription(opts: {
        mandateId: string;
        amountPence: number;
        intervalUnit: string;
        interval?: number;
        dayOfMonth?: number | null;
        name?: string | null;
        startDate?: string | null;
        count?: number | null;
        metadata?: Record<string, string> | null;
    }): Promise<{
        success: boolean;
        subscription?: Record<string, unknown>;
        error?: string;
    }>;
    /**
     * GET /subscriptions — list subscriptions.
     *
     * Faithful port of GoCardlessClient.list_subscriptions
     * (sql_rag/gocardless_api.py:487-527). Returns the page of raw
     * subscription objects plus the next-page cursor for pagination.
     */
    listSubscriptions(opts?: {
        mandateId?: string;
        customerId?: string;
        status?: string;
        limit?: number;
        cursor?: string;
    }): Promise<{
        success: boolean;
        subscriptions: Array<Record<string, unknown>>;
        after: string | null;
        error?: string;
    }>;
    /**
     * GET /subscriptions/:id — fetch a subscription's current state.
     *
     * Faithful port of `GoCardlessClient.get_subscription`
     * (sql_rag/gocardless_api.py:529-532). Returns the raw GoCardless
     * subscription object inside `{success, subscription}`.
     */
    getSubscription(subscriptionId: string): Promise<{
        success: boolean;
        subscription?: Record<string, unknown>;
        error?: string;
    }>;
    /**
     * PUT /subscriptions/:id — update name / amount / metadata.
     *
     * Faithful port of `GoCardlessClient.update_subscription`
     * (sql_rag/gocardless_api.py:534-564). Only fields that are non-null/
     * non-undefined are sent to GoCardless (matches Python's `is not None`
     * gate).
     */
    updateSubscription(subscriptionId: string, opts?: {
        name?: string | null;
        amountPence?: number | null;
        metadata?: Record<string, string> | null;
    }): Promise<{
        success: boolean;
        subscription?: Record<string, unknown>;
        error?: string;
    }>;
    /**
     * POST /subscriptions/:id/actions/pause — pause an active subscription.
     *
     * Faithful port of `GoCardlessClient.pause_subscription`.
     */
    pauseSubscription(subscriptionId: string): Promise<{
        success: boolean;
        subscription?: Record<string, unknown>;
        error?: string;
    }>;
    /**
     * POST /subscriptions/:id/actions/resume — resume a paused subscription.
     *
     * Faithful port of `GoCardlessClient.resume_subscription`.
     */
    resumeSubscription(subscriptionId: string): Promise<{
        success: boolean;
        subscription?: Record<string, unknown>;
        error?: string;
    }>;
    /**
     * POST /subscriptions/:id/actions/cancel — cancel a subscription.
     *
     * Faithful port of `GoCardlessClient.cancel_subscription`. Cannot
     * be undone (per GoCardless API).
     */
    cancelSubscription(subscriptionId: string): Promise<{
        success: boolean;
        subscription?: Record<string, unknown>;
        error?: string;
    }>;
    private _subscriptionAction;
    /**
     * Test the API token by hitting GET /creditors.
     *
     * Returns success + organisation name on a 200, or a friendly error
     * message on auth failure / network error.
     */
    testConnection(): Promise<TestConnectionResult>;
    /**
     * GET /payouts/:id — fetch a single payout, parsed.
     * Faithful port of `GoCardlessClient.get_payout`.
     */
    private _fetchRaw;
    getPayout(payoutId: string): Promise<FullPayout | null>;
    /**
     * GET /payout_items?payout=:id — payment + fee items for one payout.
     * Faithful port of `GoCardlessClient.get_payout_items`.
     */
    getPayoutItems(payoutId: string, limit?: number): Promise<Array<Record<string, unknown>>>;
    /**
     * GET /creditor_bank_accounts/:id — cached.
     * Used by _parsePayout to fill in destination account / sort code.
     */
    private _creditorBankCache;
    getCreditorBankAccount(accountId: string): Promise<Record<string, unknown>>;
    /**
     * GET /payments/:id — internal helper that returns the raw record
     * (the existing public `getPayment` returns a wrapped envelope).
     */
    private _getPaymentRaw;
    private _getMandateRaw;
    private _getCustomerRaw;
    /**
     * Composite fetch: payout + all payments + mandates + customer names.
     *
     * Faithful port of `GoCardlessClient.get_payout_with_payments`
     * (sql_rag/gocardless_api.py:660-766). Phase 1 fetches payments;
     * phase 2 fetches unique mandates; phase 3 fetches unique customers.
     * Phases run with bounded concurrency (10) to mirror Python's
     * ThreadPoolExecutor(max_workers=10).
     *
     * `fees_vat` is computed from the payout_items taxes (gocardless_fee /
     * app_fee item types) the same way Python does it.
     */
    getPayoutWithPayments(payoutId: string): Promise<FullPayout | null>;
    /**
     * Internal: structured parse of a `/payouts` record, matching the
     * Python `_parse_payout` shape. Async because it follows the
     * creditor_bank_account link to populate sort code / account number.
     */
    private _parsePayout;
}
/** Structured payment record, parallel to Python's GoCardlessPayment. */
export interface FullPayment {
    id: string;
    amount: number;
    currency: string;
    status: string | null;
    charge_date: string | null;
    customer_name: string | null;
    customer_id: string | null;
    mandate_id: string | null;
    description: string | null;
    reference: string | null;
    metadata: Record<string, unknown>;
}
/** Structured payout record, parallel to Python's GoCardlessPayout. */
export interface FullPayout {
    id: string;
    amount: number;
    currency: string;
    status: string | null;
    reference: string;
    arrival_date: string | null;
    created_at: string | null;
    deducted_fees: number;
    payout_type: string;
    payments: FullPayment[];
    fees_vat: number;
    gross_amount: number;
    fx_amount: number | null;
    fx_currency: string | null;
    exchange_rate: string | null;
    bank_account_number: string | null;
    bank_sort_code: string | null;
}
/**
 * Create a client from saved settings, or return null if no token.
 */
export declare function createClientFromSettings(settings: {
    api_access_token?: string;
    api_sandbox?: boolean;
}): GoCardlessClient | null;
export interface GoCardlessPartnerClientOptions {
    clientId: string;
    clientSecret: string;
    sandbox?: boolean;
    /** Override fetch — primarily for tests. */
    fetchImpl?: typeof fetch;
}
export interface AuthorisationUrlOptions {
    redirectUri: string;
    scope?: string;
    prefillEmail?: string | null;
    prefillCompanyName?: string | null;
    state?: string | null;
}
export interface ExchangeCodeResult {
    access_token: string;
    token_type?: string;
    scope?: string;
    organisation_id?: string;
}
export interface ExchangeCodeResponse {
    success: boolean;
    data?: ExchangeCodeResult;
    error?: string;
}
export interface OrganisationInfo {
    id?: string;
    name?: string;
    [k: string]: unknown;
}
export interface OrganisationInfoResponse {
    success: boolean;
    organisation?: OrganisationInfo;
    error?: string;
}
export declare class GoCardlessPartnerClient {
    private clientId;
    private clientSecret;
    private sandbox;
    private connectUrl;
    private apiUrl;
    private fetchImpl;
    constructor(opts: GoCardlessPartnerClientOptions);
    /**
     * Generate the OAuth consent URL the merchant visits to authorise
     * our app. Uses GoCardless OAuth Connect bracketed-prefill keys
     * (`prefill[email]`, `prefill[company_name]`).
     */
    getAuthorisationUrl(opts: AuthorisationUrlOptions): string;
    /**
     * Exchange the authorisation code for a merchant access token.
     * The redirect_uri MUST match the one used in getAuthorisationUrl.
     */
    exchangeAuthorisationCode(code: string, redirectUri: string): Promise<ExchangeCodeResponse>;
    /**
     * Verify the merchant token by fetching the first creditor.
     * Returns the creditor (or `{}` when none) — same shape as Python.
     */
    getOrganisationInfo(accessToken: string): Promise<OrganisationInfoResponse>;
}
/**
 * Build a GoCardlessPartnerClient from saved settings, or return null
 * when partner credentials aren't configured.
 */
export declare function createPartnerClientFromSettings(settings: {
    partner_client_id?: string;
    partner_client_secret?: string;
    api_sandbox?: boolean;
}, fetchImpl?: typeof fetch): GoCardlessPartnerClient | null;
//# sourceMappingURL=gocardless-api.d.ts.map