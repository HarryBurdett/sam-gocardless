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
const SANDBOX_URL = 'https://api-sandbox.gocardless.com';
const LIVE_URL = 'https://api.gocardless.com';
export class GoCardlessClient {
    accessToken;
    baseUrl;
    environment;
    constructor(opts) {
        this.accessToken = opts.accessToken;
        this.environment = opts.sandbox ? 'sandbox' : 'live';
        this.baseUrl = opts.sandbox ? SANDBOX_URL : LIVE_URL;
    }
    async request(method, path, body) {
        return fetch(`${this.baseUrl}${path}`, {
            method,
            headers: {
                Authorization: `Bearer ${this.accessToken}`,
                'GoCardless-Version': '2015-07-06',
                Accept: 'application/json',
                'Content-Type': 'application/json',
            },
            body: body ? JSON.stringify(body) : undefined,
        });
    }
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
    async getPayouts(opts = {}) {
        try {
            const params = new URLSearchParams();
            if (opts.status)
                params.set('status', opts.status);
            if (opts.limit)
                params.set('limit', String(opts.limit));
            if (opts.createdAtGte)
                params.set('created_at[gte]', opts.createdAtGte);
            if (opts.before)
                params.set('before', opts.before);
            const path = `/payouts${params.toString() ? `?${params.toString()}` : ''}`;
            const res = await this.request('GET', path);
            if (res.status === 401) {
                return {
                    success: false,
                    payouts: [],
                    before: null,
                    error: 'Invalid GoCardless API token (401 Unauthorized)',
                };
            }
            if (!res.ok) {
                const text = await res.text().catch(() => '');
                return {
                    success: false,
                    payouts: [],
                    before: null,
                    error: `GoCardless API returned ${res.status}: ${text.slice(0, 200)}`,
                };
            }
            const data = (await res.json());
            const payouts = Array.isArray(data.payouts) ? data.payouts : [];
            const before = data.meta?.cursors?.before ?? null;
            return { success: true, payouts, before };
        }
        catch (err) {
            return {
                success: false,
                payouts: [],
                before: null,
                error: `Network error: ${err?.message ?? String(err)}`,
            };
        }
    }
    /**
     * POST /payments/:id/actions/cancel — cancel a pending payment.
     *
     * Faithful port of the cancel_payment call used by
     * cancel_payment_request (apps/gocardless/api/routes.py:8509-8553).
     * Returns a uniform shape rather than throwing so callers can fall
     * back to local-only cancellation if the API call fails (matches
     * Python's "log and continue" behaviour).
     */
    async cancelPayment(paymentId) {
        if (!paymentId)
            return { success: false, error: 'paymentId required' };
        try {
            const res = await this.request('POST', `/payments/${encodeURIComponent(paymentId)}/actions/cancel`, {});
            if (res.status === 401) {
                return {
                    success: false,
                    error: 'Invalid GoCardless API token (401 Unauthorized)',
                };
            }
            if (!res.ok) {
                const text = await res.text().catch(() => '');
                return {
                    success: false,
                    error: `GoCardless API returned ${res.status}: ${text.slice(0, 200)}`,
                };
            }
            const data = (await res.json());
            return { success: true, data };
        }
        catch (err) {
            return {
                success: false,
                error: `Network error: ${err?.message ?? String(err)}`,
            };
        }
    }
    /**
     * GET /payments/:id — fetch a single payment's current status.
     *
     * Used by payment-requests/sync to reconcile local state with
     * GoCardless's view of each pending payment.
     */
    async getPayment(paymentId) {
        if (!paymentId)
            return { success: false, error: 'paymentId required' };
        try {
            const res = await this.request('GET', `/payments/${encodeURIComponent(paymentId)}`);
            if (res.status === 401) {
                return {
                    success: false,
                    error: 'Invalid GoCardless API token (401 Unauthorized)',
                };
            }
            if (!res.ok) {
                const text = await res.text().catch(() => '');
                return {
                    success: false,
                    error: `GoCardless API returned ${res.status}: ${text.slice(0, 200)}`,
                };
            }
            const data = (await res.json());
            return { success: true, payment: data.payments ?? {} };
        }
        catch (err) {
            return {
                success: false,
                error: `Network error: ${err?.message ?? String(err)}`,
            };
        }
    }
    /**
     * GET /billing_requests/:id — fetch a billing request's current state.
     *
     * Used by the check-setups poll endpoint to detect when a customer
     * has completed their authorisation and a mandate has been minted.
     */
    async getBillingRequest(billingRequestId) {
        if (!billingRequestId) {
            return { success: false, error: 'billingRequestId required' };
        }
        try {
            const res = await this.request('GET', `/billing_requests/${encodeURIComponent(billingRequestId)}`);
            if (res.status === 401) {
                return {
                    success: false,
                    error: 'Invalid GoCardless API token (401 Unauthorized)',
                };
            }
            if (!res.ok) {
                const text = await res.text().catch(() => '');
                return {
                    success: false,
                    error: `GoCardless API returned ${res.status}: ${text.slice(0, 200)}`,
                };
            }
            const data = (await res.json());
            return { success: true, billingRequest: data.billing_requests ?? {} };
        }
        catch (err) {
            return {
                success: false,
                error: `Network error: ${err?.message ?? String(err)}`,
            };
        }
    }
    /**
     * POST /billing_requests — create a new billing request.
     *
     * Faithful port of GoCardlessClient.create_billing_request — used
     * by the mandate-setup flow to generate a hosted authorisation
     * URL the customer can use to sign the Direct Debit.
     */
    async createBillingRequest(opts) {
        if (!opts.customerEmail) {
            return { success: false, error: 'customerEmail required' };
        }
        const customer = { email: opts.customerEmail };
        if (opts.customerName)
            customer.given_name = opts.customerName;
        const body = {
            billing_requests: {
                mandate_request: { scheme: 'bacs' },
                links: {},
                resources: { customer },
            },
        };
        if (opts.metadata) {
            body.billing_requests.metadata = opts.metadata;
        }
        try {
            const res = await this.request('POST', '/billing_requests', body);
            if (res.status === 401) {
                return {
                    success: false,
                    error: 'Invalid GoCardless API token (401 Unauthorized)',
                };
            }
            if (!res.ok) {
                const text = await res.text().catch(() => '');
                return {
                    success: false,
                    error: `GoCardless API returned ${res.status}: ${text.slice(0, 200)}`,
                };
            }
            const data = (await res.json());
            return { success: true, billingRequest: data.billing_requests ?? {} };
        }
        catch (err) {
            return {
                success: false,
                error: `Network error: ${err?.message ?? String(err)}`,
            };
        }
    }
    /**
     * POST /billing_request_flows — create the hosted-payment-pages flow
     * URL for an existing billing request. Returns `{authorisation_url}`.
     */
    async createBillingRequestFlow(opts) {
        if (!opts.billingRequestId) {
            return { success: false, error: 'billingRequestId required' };
        }
        const flow = {
            links: { billing_request: opts.billingRequestId },
        };
        if (opts.redirectUri)
            flow.redirect_uri = opts.redirectUri;
        if (opts.exitUri)
            flow.exit_uri = opts.exitUri;
        try {
            const res = await this.request('POST', '/billing_request_flows', { billing_request_flows: flow });
            if (res.status === 401) {
                return {
                    success: false,
                    error: 'Invalid GoCardless API token (401 Unauthorized)',
                };
            }
            if (!res.ok) {
                const text = await res.text().catch(() => '');
                return {
                    success: false,
                    error: `GoCardless API returned ${res.status}: ${text.slice(0, 200)}`,
                };
            }
            const data = (await res.json());
            return { success: true, flow: data.billing_request_flows ?? {} };
        }
        catch (err) {
            return {
                success: false,
                error: `Network error: ${err?.message ?? String(err)}`,
            };
        }
    }
    /**
     * GET /mandates — list mandates.
     *
     * Faithful port of GoCardlessClient.list_mandates. Returns a page
     * of raw mandate objects + the next-page cursor. Used by the
     * mandate-sync flow to walk every mandate in the GoCardless org.
     */
    async listMandates(opts = {}) {
        try {
            const params = new URLSearchParams();
            if (opts.customerId)
                params.set('customer', opts.customerId);
            if (opts.status)
                params.set('status', opts.status);
            params.set('limit', String(Math.min(opts.limit ?? 100, 500)));
            if (opts.cursor)
                params.set('after', opts.cursor);
            const path = `/mandates?${params.toString()}`;
            const res = await this.request('GET', path);
            if (res.status === 401) {
                return {
                    success: false,
                    mandates: [],
                    after: null,
                    error: 'Invalid GoCardless API token (401 Unauthorized)',
                };
            }
            if (!res.ok) {
                const text = await res.text().catch(() => '');
                return {
                    success: false,
                    mandates: [],
                    after: null,
                    error: `GoCardless API returned ${res.status}: ${text.slice(0, 200)}`,
                };
            }
            const data = (await res.json());
            return {
                success: true,
                mandates: Array.isArray(data.mandates) ? data.mandates : [],
                after: data.meta?.cursors?.after ?? null,
            };
        }
        catch (err) {
            return {
                success: false,
                mandates: [],
                after: null,
                error: `Network error: ${err?.message ?? String(err)}`,
            };
        }
    }
    /**
     * GET /mandates/:id — fetch a mandate's current state.
     *
     * Faithful port of GoCardlessClient.get_mandate
     * (sql_rag/gocardless_api.py). Returns the raw GoCardless mandate
     * object. 404s and errors are surfaced as success=false with a
     * friendly message; callers can fall back to local data.
     */
    async getMandate(mandateId) {
        if (!mandateId)
            return { success: false, error: 'mandateId required' };
        try {
            const res = await this.request('GET', `/mandates/${encodeURIComponent(mandateId)}`);
            if (res.status === 401) {
                return {
                    success: false,
                    error: 'Invalid GoCardless API token (401 Unauthorized)',
                };
            }
            if (!res.ok) {
                const text = await res.text().catch(() => '');
                return {
                    success: false,
                    error: `GoCardless API returned ${res.status}: ${text.slice(0, 200)}`,
                };
            }
            const data = (await res.json());
            return { success: true, mandate: data.mandates ?? {} };
        }
        catch (err) {
            return {
                success: false,
                error: `Network error: ${err?.message ?? String(err)}`,
            };
        }
    }
    /**
     * GET /customers/:id — fetch a customer's contact details.
     *
     * Faithful port of GoCardlessClient.get_customer. Used during
     * mandate-link to harvest the customer email.
     */
    async getCustomer(customerId) {
        if (!customerId)
            return { success: false, error: 'customerId required' };
        try {
            const res = await this.request('GET', `/customers/${encodeURIComponent(customerId)}`);
            if (res.status === 401) {
                return {
                    success: false,
                    error: 'Invalid GoCardless API token (401 Unauthorized)',
                };
            }
            if (!res.ok) {
                const text = await res.text().catch(() => '');
                return {
                    success: false,
                    error: `GoCardless API returned ${res.status}: ${text.slice(0, 200)}`,
                };
            }
            const data = (await res.json());
            return { success: true, customer: data.customers ?? {} };
        }
        catch (err) {
            return {
                success: false,
                error: `Network error: ${err?.message ?? String(err)}`,
            };
        }
    }
    /**
     * POST /mandates/:id/actions/cancel — cancel a mandate.
     *
     * Faithful port of the cancel call wrapped by
     * cancel_gocardless_mandate (apps/gocardless/api/routes.py
     * :6795-6830). Returns uniform shape so the wrapping service can
     * detect "already cancelled" responses gracefully (Python's source
     * treats them as success too).
     */
    async cancelMandate(mandateId) {
        if (!mandateId)
            return { success: false, error: 'mandateId required' };
        try {
            const res = await this.request('POST', `/mandates/${encodeURIComponent(mandateId)}/actions/cancel`, {});
            if (res.status === 401) {
                return {
                    success: false,
                    error: 'Invalid GoCardless API token (401 Unauthorized)',
                };
            }
            if (!res.ok) {
                const text = await res.text().catch(() => '');
                if (text.toLowerCase().includes('already') &&
                    text.toLowerCase().includes('cancel')) {
                    return { success: true, status: 'cancelled', alreadyCancelled: true };
                }
                return {
                    success: false,
                    error: `GoCardless API error: ${text.slice(0, 200) || `${res.status}`}`,
                };
            }
            const data = (await res.json());
            return { success: true, status: data.mandates?.status ?? 'cancelled' };
        }
        catch (err) {
            return {
                success: false,
                error: `Network error: ${err?.message ?? String(err)}`,
            };
        }
    }
    /**
     * POST /payments — create a new payment against a mandate.
     *
     * Faithful port of GoCardlessClient.create_payment
     * (sql_rag/gocardless_api.py:329-380). Uniform `{success, payment?,
     * error?}` shape so callers can compose without exception-handling.
     */
    async createPayment(opts) {
        if (!opts.mandateId)
            return { success: false, error: 'mandateId required' };
        const body = {
            amount: opts.amountPence,
            currency: opts.currency ?? 'GBP',
            links: { mandate: opts.mandateId },
            retry_if_possible: opts.retryIfPossible !== false,
        };
        if (opts.description)
            body.description = opts.description;
        if (opts.chargeDate)
            body.charge_date = opts.chargeDate;
        if (opts.reference)
            body.reference = opts.reference;
        if (opts.metadata)
            body.metadata = opts.metadata;
        try {
            const res = await this.request('POST', '/payments', { payments: body });
            if (res.status === 401) {
                return {
                    success: false,
                    error: 'Invalid GoCardless API token (401 Unauthorized)',
                };
            }
            if (!res.ok) {
                const text = await res.text().catch(() => '');
                return {
                    success: false,
                    error: `GoCardless API returned ${res.status}: ${text.slice(0, 200)}`,
                };
            }
            const data = (await res.json());
            return { success: true, payment: data.payments ?? {} };
        }
        catch (err) {
            return {
                success: false,
                error: `Network error: ${err?.message ?? String(err)}`,
            };
        }
    }
    /**
     * POST /subscriptions — create a new subscription against a mandate.
     *
     * Faithful port of GoCardlessClient.create_subscription
     * (sql_rag/gocardless_api.py:434-485). Returns uniform shape
     * `{success, subscription?, error?}` so callers can compose without
     * exception-handling.
     */
    async createSubscription(opts) {
        if (!opts.mandateId)
            return { success: false, error: 'mandateId required' };
        const body = {
            amount: opts.amountPence,
            currency: 'GBP',
            interval_unit: opts.intervalUnit,
            interval: opts.interval ?? 1,
            links: { mandate: opts.mandateId },
        };
        if (opts.dayOfMonth !== undefined && opts.dayOfMonth !== null) {
            body.day_of_month = opts.dayOfMonth;
        }
        if (opts.name)
            body.name = opts.name;
        if (opts.startDate)
            body.start_date = opts.startDate;
        if (opts.count !== undefined && opts.count !== null)
            body.count = opts.count;
        if (opts.metadata)
            body.metadata = opts.metadata;
        try {
            const res = await this.request('POST', '/subscriptions', {
                subscriptions: body,
            });
            if (res.status === 401) {
                return {
                    success: false,
                    error: 'Invalid GoCardless API token (401 Unauthorized)',
                };
            }
            if (!res.ok) {
                const text = await res.text().catch(() => '');
                return {
                    success: false,
                    error: `GoCardless API returned ${res.status}: ${text.slice(0, 200)}`,
                };
            }
            const data = (await res.json());
            return { success: true, subscription: data.subscriptions ?? {} };
        }
        catch (err) {
            return {
                success: false,
                error: `Network error: ${err?.message ?? String(err)}`,
            };
        }
    }
    /**
     * GET /subscriptions — list subscriptions.
     *
     * Faithful port of GoCardlessClient.list_subscriptions
     * (sql_rag/gocardless_api.py:487-527). Returns the page of raw
     * subscription objects plus the next-page cursor for pagination.
     */
    async listSubscriptions(opts = {}) {
        try {
            const params = new URLSearchParams();
            if (opts.mandateId)
                params.set('mandate', opts.mandateId);
            if (opts.customerId)
                params.set('customer', opts.customerId);
            if (opts.status)
                params.set('status', opts.status);
            params.set('limit', String(Math.min(opts.limit ?? 100, 500)));
            if (opts.cursor)
                params.set('after', opts.cursor);
            const path = `/subscriptions?${params.toString()}`;
            const res = await this.request('GET', path);
            if (res.status === 401) {
                return {
                    success: false,
                    subscriptions: [],
                    after: null,
                    error: 'Invalid GoCardless API token (401 Unauthorized)',
                };
            }
            if (!res.ok) {
                const text = await res.text().catch(() => '');
                return {
                    success: false,
                    subscriptions: [],
                    after: null,
                    error: `GoCardless API returned ${res.status}: ${text.slice(0, 200)}`,
                };
            }
            const data = (await res.json());
            return {
                success: true,
                subscriptions: Array.isArray(data.subscriptions) ? data.subscriptions : [],
                after: data.meta?.cursors?.after ?? null,
            };
        }
        catch (err) {
            return {
                success: false,
                subscriptions: [],
                after: null,
                error: `Network error: ${err?.message ?? String(err)}`,
            };
        }
    }
    /**
     * GET /subscriptions/:id — fetch a subscription's current state.
     *
     * Faithful port of `GoCardlessClient.get_subscription`
     * (sql_rag/gocardless_api.py:529-532). Returns the raw GoCardless
     * subscription object inside `{success, subscription}`.
     */
    async getSubscription(subscriptionId) {
        if (!subscriptionId)
            return { success: false, error: 'subscriptionId required' };
        try {
            const res = await this.request('GET', `/subscriptions/${encodeURIComponent(subscriptionId)}`);
            if (res.status === 401) {
                return {
                    success: false,
                    error: 'Invalid GoCardless API token (401 Unauthorized)',
                };
            }
            if (!res.ok) {
                const text = await res.text().catch(() => '');
                return {
                    success: false,
                    error: `GoCardless API returned ${res.status}: ${text.slice(0, 200)}`,
                };
            }
            const data = (await res.json());
            return { success: true, subscription: data.subscriptions ?? {} };
        }
        catch (err) {
            return {
                success: false,
                error: `Network error: ${err?.message ?? String(err)}`,
            };
        }
    }
    /**
     * PUT /subscriptions/:id — update name / amount / metadata.
     *
     * Faithful port of `GoCardlessClient.update_subscription`
     * (sql_rag/gocardless_api.py:534-564). Only fields that are non-null/
     * non-undefined are sent to GoCardless (matches Python's `is not None`
     * gate).
     */
    async updateSubscription(subscriptionId, opts = {}) {
        if (!subscriptionId)
            return { success: false, error: 'subscriptionId required' };
        const subData = {};
        if (opts.name !== undefined && opts.name !== null)
            subData.name = opts.name;
        if (opts.amountPence !== undefined && opts.amountPence !== null)
            subData.amount = opts.amountPence;
        if (opts.metadata !== undefined && opts.metadata !== null)
            subData.metadata = opts.metadata;
        try {
            const res = await this.request('PUT', `/subscriptions/${encodeURIComponent(subscriptionId)}`, { subscriptions: subData });
            if (res.status === 401) {
                return {
                    success: false,
                    error: 'Invalid GoCardless API token (401 Unauthorized)',
                };
            }
            if (!res.ok) {
                const text = await res.text().catch(() => '');
                return {
                    success: false,
                    error: `GoCardless API returned ${res.status}: ${text.slice(0, 200)}`,
                };
            }
            const data = (await res.json());
            return { success: true, subscription: data.subscriptions ?? {} };
        }
        catch (err) {
            return {
                success: false,
                error: `Network error: ${err?.message ?? String(err)}`,
            };
        }
    }
    /**
     * POST /subscriptions/:id/actions/pause — pause an active subscription.
     *
     * Faithful port of `GoCardlessClient.pause_subscription`.
     */
    async pauseSubscription(subscriptionId) {
        return this._subscriptionAction(subscriptionId, 'pause');
    }
    /**
     * POST /subscriptions/:id/actions/resume — resume a paused subscription.
     *
     * Faithful port of `GoCardlessClient.resume_subscription`.
     */
    async resumeSubscription(subscriptionId) {
        return this._subscriptionAction(subscriptionId, 'resume');
    }
    /**
     * POST /subscriptions/:id/actions/cancel — cancel a subscription.
     *
     * Faithful port of `GoCardlessClient.cancel_subscription`. Cannot
     * be undone (per GoCardless API).
     */
    async cancelSubscription(subscriptionId) {
        return this._subscriptionAction(subscriptionId, 'cancel');
    }
    async _subscriptionAction(subscriptionId, action) {
        if (!subscriptionId)
            return { success: false, error: 'subscriptionId required' };
        try {
            const res = await this.request('POST', `/subscriptions/${encodeURIComponent(subscriptionId)}/actions/${action}`, {});
            if (res.status === 401) {
                return {
                    success: false,
                    error: 'Invalid GoCardless API token (401 Unauthorized)',
                };
            }
            if (!res.ok) {
                const text = await res.text().catch(() => '');
                return {
                    success: false,
                    error: `GoCardless API returned ${res.status}: ${text.slice(0, 200)}`,
                };
            }
            const data = (await res.json());
            return { success: true, subscription: data.subscriptions ?? {} };
        }
        catch (err) {
            return {
                success: false,
                error: `Network error: ${err?.message ?? String(err)}`,
            };
        }
    }
    /**
     * Test the API token by hitting GET /creditors.
     *
     * Returns success + organisation name on a 200, or a friendly error
     * message on auth failure / network error.
     */
    async testConnection() {
        try {
            const res = await this.request('GET', '/creditors?limit=1');
            if (res.status === 401) {
                return {
                    success: false,
                    error: 'Invalid GoCardless API token (401 Unauthorized)',
                    environment: this.environment,
                };
            }
            if (!res.ok) {
                const text = await res.text().catch(() => '');
                return {
                    success: false,
                    error: `GoCardless API returned ${res.status}: ${text.slice(0, 200)}`,
                    environment: this.environment,
                };
            }
            const data = (await res.json());
            const orgName = data.creditors?.[0]?.name ?? '(no creditors found)';
            return {
                success: true,
                message: `Connected to GoCardless ${this.environment}`,
                organisation: orgName,
                environment: this.environment,
            };
        }
        catch (err) {
            return {
                success: false,
                error: `Network error: ${err?.message ?? String(err)}`,
                environment: this.environment,
            };
        }
    }
    /**
     * GET /payouts/:id — fetch a single payout, parsed.
     * Faithful port of `GoCardlessClient.get_payout`.
     */
    async _fetchRaw(path) {
        const res = await this.request('GET', path);
        if (!res.ok)
            return null;
        return (await res.json());
    }
    async getPayout(payoutId) {
        if (!payoutId)
            return null;
        const data = await this._fetchRaw(`/payouts/${encodeURIComponent(payoutId)}`);
        if (!data)
            return null;
        const p = (data.payouts ?? {});
        return this._parsePayout(p);
    }
    /**
     * GET /payout_items?payout=:id — payment + fee items for one payout.
     * Faithful port of `GoCardlessClient.get_payout_items`.
     */
    async getPayoutItems(payoutId, limit = 500) {
        if (!payoutId)
            return [];
        const params = new URLSearchParams({
            payout: payoutId,
            limit: String(Math.min(limit, 500)),
        });
        const data = await this._fetchRaw(`/payout_items?${params.toString()}`);
        if (!data)
            return [];
        const items = (data.payout_items ?? []);
        return Array.isArray(items) ? items : [];
    }
    /**
     * GET /creditor_bank_accounts/:id — cached.
     * Used by _parsePayout to fill in destination account / sort code.
     */
    _creditorBankCache = new Map();
    async getCreditorBankAccount(accountId) {
        if (!accountId)
            return {};
        const cached = this._creditorBankCache.get(accountId);
        if (cached)
            return cached;
        const data = await this._fetchRaw(`/creditor_bank_accounts/${encodeURIComponent(accountId)}`);
        const acc = (data?.creditor_bank_accounts ?? {});
        this._creditorBankCache.set(accountId, acc);
        return acc;
    }
    /**
     * GET /payments/:id — internal helper that returns the raw record
     * (the existing public `getPayment` returns a wrapped envelope).
     */
    async _getPaymentRaw(paymentId) {
        if (!paymentId)
            return null;
        const data = await this._fetchRaw(`/payments/${encodeURIComponent(paymentId)}`);
        return data ? (data.payments ?? {}) : null;
    }
    async _getMandateRaw(mandateId) {
        if (!mandateId)
            return null;
        const data = await this._fetchRaw(`/mandates/${encodeURIComponent(mandateId)}`);
        return data ? (data.mandates ?? {}) : null;
    }
    async _getCustomerRaw(customerId) {
        if (!customerId)
            return null;
        const data = await this._fetchRaw(`/customers/${encodeURIComponent(customerId)}`);
        return data ? (data.customers ?? {}) : null;
    }
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
    async getPayoutWithPayments(payoutId) {
        const payout = await this.getPayout(payoutId);
        if (!payout)
            return null;
        const items = await this.getPayoutItems(payoutId);
        let feesVat = 0;
        const paymentIds = [];
        for (const item of items) {
            const itemType = String(item.type ?? '');
            const links = (item.links ?? {});
            if (itemType === 'payment_paid_out') {
                const pid = links.payment;
                if (typeof pid === 'string' && pid)
                    paymentIds.push(pid);
            }
            else if (itemType === 'gocardless_fee' || itemType === 'app_fee') {
                const taxes = Array.isArray(item.taxes) ? item.taxes : [];
                for (const tax of taxes) {
                    feesVat += Math.abs(Number(tax.amount ?? 0)) / 100;
                }
            }
        }
        // Phase 1: payments
        const paymentMap = new Map();
        await runPool(10, paymentIds, async (pid) => {
            const data = await this._getPaymentRaw(pid).catch(() => null);
            if (data)
                paymentMap.set(pid, data);
        });
        // Phase 2: mandates
        const mandateIds = new Set();
        for (const pd of paymentMap.values()) {
            const mid = pd.links?.mandate;
            if (typeof mid === 'string' && mid)
                mandateIds.add(mid);
        }
        const mandateMap = new Map();
        await runPool(10, Array.from(mandateIds), async (mid) => {
            const m = await this._getMandateRaw(mid).catch(() => null);
            if (m)
                mandateMap.set(mid, m);
        });
        // Phase 3: customers
        const customerIds = new Set();
        for (const mid of mandateIds) {
            const m = mandateMap.get(mid);
            const cid = m?.links?.customer;
            if (typeof cid === 'string' && cid)
                customerIds.add(cid);
        }
        const customerMap = new Map();
        await runPool(10, Array.from(customerIds), async (cid) => {
            const c = await this._getCustomerRaw(cid).catch(() => null);
            if (c)
                customerMap.set(cid, c);
        });
        // Phase 4: assemble structured payments.
        const payments = [];
        for (const pid of paymentIds) {
            const pd = paymentMap.get(pid);
            if (!pd)
                continue;
            const mid = pd.links?.mandate ??
                null;
            let cid = null;
            let customerName = null;
            if (mid) {
                const m = mandateMap.get(mid);
                cid = m?.links?.customer ?? null;
                if (cid) {
                    const c = customerMap.get(cid);
                    const company = c?.company_name ?? '';
                    if (company) {
                        customerName = company;
                    }
                    else {
                        const given = c?.given_name ?? '';
                        const family = c?.family_name ?? '';
                        const full = `${given} ${family}`.trim();
                        customerName = full || null;
                    }
                }
            }
            payments.push({
                id: pd.id ?? '',
                amount: Number(pd.amount ?? 0) / 100,
                currency: pd.currency ?? 'GBP',
                status: pd.status ?? null,
                charge_date: pd.charge_date ?? null,
                customer_name: customerName,
                customer_id: cid,
                mandate_id: mid,
                description: pd.description ?? null,
                reference: pd.reference ?? null,
                metadata: pd.metadata ?? {},
            });
        }
        payout.payments = payments;
        payout.fees_vat = feesVat;
        // gross_amount as in Python @property: sum of payments
        payout.gross_amount = payments.reduce((s, p) => s + p.amount, 0);
        return payout;
    }
    /**
     * Internal: structured parse of a `/payouts` record, matching the
     * Python `_parse_payout` shape. Async because it follows the
     * creditor_bank_account link to populate sort code / account number.
     */
    async _parsePayout(data) {
        const fx = (data.fx ?? {});
        const fxAmountPence = fx.fx_amount;
        const fxAmount = typeof fxAmountPence === 'number' ? fxAmountPence / 100 :
            typeof fxAmountPence === 'string' && fxAmountPence ? Number(fxAmountPence) / 100 :
                null;
        let bankAccountNumber = null;
        let bankSortCode = null;
        const cbaId = data.links?.creditor_bank_account ?? '';
        if (cbaId) {
            const cba = await this.getCreditorBankAccount(cbaId).catch(() => ({}));
            bankAccountNumber =
                (cba['account_number_ending'] ??
                    cba['account_number']) ?? null;
            bankSortCode = cba['bank_code'] ?? null;
        }
        return {
            id: data.id ?? '',
            amount: Number(data.amount ?? 0) / 100,
            currency: data.currency ?? 'GBP',
            status: data.status ?? null,
            reference: data.reference ?? '',
            arrival_date: data.arrival_date ?? null,
            created_at: data.created_at ?? null,
            deducted_fees: Number(data.deducted_fees ?? 0) / 100,
            payout_type: data.payout_type ?? '',
            payments: [],
            fees_vat: 0,
            gross_amount: 0,
            fx_amount: fxAmount,
            fx_currency: fx.fx_currency ?? null,
            exchange_rate: fx.exchange_rate ?? null,
            bank_account_number: bankAccountNumber,
            bank_sort_code: bankSortCode,
        };
    }
}
/**
 * Run an async task across `items` with bounded concurrency.
 * Mirrors Python's ThreadPoolExecutor(max_workers=N) pattern.
 */
async function runPool(concurrency, items, worker) {
    if (items.length === 0)
        return;
    const queue = items.slice();
    const inflight = [];
    while (queue.length > 0 || inflight.length > 0) {
        while (inflight.length < concurrency && queue.length > 0) {
            const it = queue.shift();
            const p = worker(it).finally(() => {
                const idx = inflight.indexOf(p);
                if (idx >= 0)
                    inflight.splice(idx, 1);
            });
            inflight.push(p);
        }
        if (inflight.length > 0)
            await Promise.race(inflight);
    }
}
/**
 * Create a client from saved settings, or return null if no token.
 */
export function createClientFromSettings(settings) {
    if (!settings.api_access_token)
        return null;
    return new GoCardlessClient({
        accessToken: settings.api_access_token,
        sandbox: !!settings.api_sandbox,
    });
}
// =====================================================================
// GoCardlessPartnerClient — OAuth Connect for merchant onboarding
// =====================================================================
/**
 * GoCardless Partner / Connect OAuth client.
 *
 * Faithful port of `GoCardlessPartnerClient`
 * (sql_rag/gocardless_api.py:855-1001).
 *
 * Used by the partner-portal flow to:
 *   1. Generate an authorisation URL for a new merchant
 *   2. Exchange the returned code for a merchant access token
 *   3. Fetch the merchant's creditor info to verify the token works
 *
 * NB: per MEMORY.md, sandbox=true is the default for safety. Live
 * mode must be explicitly opted in.
 */
const PARTNER_SANDBOX_CONNECT_URL = 'https://connect-sandbox.gocardless.com';
const PARTNER_LIVE_CONNECT_URL = 'https://connect.gocardless.com';
const PARTNER_SANDBOX_API_URL = 'https://api-sandbox.gocardless.com';
const PARTNER_LIVE_API_URL = 'https://api.gocardless.com';
export class GoCardlessPartnerClient {
    clientId;
    clientSecret;
    sandbox;
    connectUrl;
    apiUrl;
    fetchImpl;
    constructor(opts) {
        this.clientId = opts.clientId;
        this.clientSecret = opts.clientSecret;
        this.sandbox = opts.sandbox ?? true;
        this.connectUrl = this.sandbox
            ? PARTNER_SANDBOX_CONNECT_URL
            : PARTNER_LIVE_CONNECT_URL;
        this.apiUrl = this.sandbox ? PARTNER_SANDBOX_API_URL : PARTNER_LIVE_API_URL;
        this.fetchImpl = opts.fetchImpl ?? fetch;
    }
    /**
     * Generate the OAuth consent URL the merchant visits to authorise
     * our app. Uses GoCardless OAuth Connect bracketed-prefill keys
     * (`prefill[email]`, `prefill[company_name]`).
     */
    getAuthorisationUrl(opts) {
        const params = new URLSearchParams();
        params.set('response_type', 'code');
        params.set('client_id', this.clientId);
        params.set('scope', opts.scope ?? 'read_write');
        params.set('redirect_uri', opts.redirectUri);
        params.set('access_type', 'offline');
        if (opts.prefillEmail)
            params.set('prefill[email]', opts.prefillEmail);
        if (opts.prefillCompanyName)
            params.set('prefill[company_name]', opts.prefillCompanyName);
        if (opts.state)
            params.set('state', opts.state);
        return `${this.connectUrl}/oauth/authorize?${params.toString()}`;
    }
    /**
     * Exchange the authorisation code for a merchant access token.
     * The redirect_uri MUST match the one used in getAuthorisationUrl.
     */
    async exchangeAuthorisationCode(code, redirectUri) {
        const url = `${this.connectUrl}/oauth/access_token`;
        try {
            const ac = new AbortController();
            const timer = setTimeout(() => ac.abort(), 30000);
            let res;
            try {
                res = await this.fetchImpl(url, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        grant_type: 'authorization_code',
                        client_id: this.clientId,
                        client_secret: this.clientSecret,
                        code,
                        redirect_uri: redirectUri,
                    }),
                    signal: ac.signal,
                });
            }
            finally {
                clearTimeout(timer);
            }
            if (res.status !== 200) {
                let msg = await res.text().catch(() => '');
                try {
                    const data = JSON.parse(msg);
                    msg = data.error_description ?? data.error ?? msg;
                }
                catch {
                    // keep raw text
                }
                return {
                    success: false,
                    error: `Token exchange failed (${res.status}): ${msg.slice(0, 200)}`,
                };
            }
            const data = (await res.json());
            return { success: true, data };
        }
        catch (err) {
            return {
                success: false,
                error: `Token exchange request failed: ${err?.message ?? String(err)}`,
            };
        }
    }
    /**
     * Verify the merchant token by fetching the first creditor.
     * Returns the creditor (or `{}` when none) — same shape as Python.
     */
    async getOrganisationInfo(accessToken) {
        const url = `${this.apiUrl}/creditors`;
        try {
            const res = await this.fetchImpl(url, {
                method: 'GET',
                headers: {
                    Authorization: `Bearer ${accessToken}`,
                    'GoCardless-Version': '2015-07-06',
                    'Content-Type': 'application/json',
                },
            });
            if (res.status !== 200) {
                return {
                    success: false,
                    error: `Failed to get organisation info: ${res.status}`,
                };
            }
            const data = (await res.json());
            const creditors = Array.isArray(data.creditors) ? data.creditors : [];
            return { success: true, organisation: creditors[0] ?? {} };
        }
        catch (err) {
            return {
                success: false,
                error: `Organisation info request failed: ${err?.message ?? String(err)}`,
            };
        }
    }
}
/**
 * Build a GoCardlessPartnerClient from saved settings, or return null
 * when partner credentials aren't configured.
 */
export function createPartnerClientFromSettings(settings, fetchImpl) {
    const clientId = (settings.partner_client_id ?? '').trim();
    const clientSecret = (settings.partner_client_secret ?? '').trim();
    if (!clientId || !clientSecret)
        return null;
    return new GoCardlessPartnerClient({
        clientId,
        clientSecret,
        sandbox: !!settings.api_sandbox,
        fetchImpl,
    });
}
//# sourceMappingURL=gocardless-api.js.map