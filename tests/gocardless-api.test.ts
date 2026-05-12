import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { GoCardlessClient, createClientFromSettings } from '../src/services/gocardless-api.js';

describe('GoCardlessClient', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('uses sandbox base URL when sandbox=true', async () => {
    (global.fetch as any).mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ creditors: [{ name: 'Test Org' }] }),
    });

    const client = new GoCardlessClient({ accessToken: 'sandbox_token', sandbox: true });
    const result = await client.testConnection();

    expect(result.success).toBe(true);
    expect(result.organisation).toBe('Test Org');
    expect(result.environment).toBe('sandbox');

    const fetchCall = (global.fetch as any).mock.calls[0];
    expect(fetchCall[0]).toMatch(/api-sandbox\.gocardless\.com/);
  });

  it('uses live URL when sandbox=false', async () => {
    (global.fetch as any).mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ creditors: [{ name: 'Live Org' }] }),
    });

    const client = new GoCardlessClient({ accessToken: 'live_token', sandbox: false });
    const result = await client.testConnection();

    expect(result.environment).toBe('live');
    const fetchCall = (global.fetch as any).mock.calls[0];
    expect(fetchCall[0]).toMatch(/^https:\/\/api\.gocardless\.com/);
    // Authorization header set
    expect(fetchCall[1].headers.Authorization).toBe('Bearer live_token');
  });

  it('returns success=false on 401', async () => {
    (global.fetch as any).mockResolvedValue({
      ok: false,
      status: 401,
      text: async () => 'Unauthorized',
    });

    const client = new GoCardlessClient({ accessToken: 'bad_token', sandbox: true });
    const result = await client.testConnection();

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/Invalid GoCardless API token/);
  });

  it('returns success=false on other HTTP errors', async () => {
    (global.fetch as any).mockResolvedValue({
      ok: false,
      status: 500,
      text: async () => 'Internal Server Error',
    });

    const client = new GoCardlessClient({ accessToken: 'token', sandbox: true });
    const result = await client.testConnection();

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/500/);
  });

  it('handles network errors', async () => {
    (global.fetch as any).mockRejectedValue(new Error('ENOTFOUND'));

    const client = new GoCardlessClient({ accessToken: 'token', sandbox: true });
    const result = await client.testConnection();

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/ENOTFOUND/);
  });

  it('reports "no creditors found" when API returns empty list', async () => {
    (global.fetch as any).mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ creditors: [] }),
    });

    const client = new GoCardlessClient({ accessToken: 'token', sandbox: true });
    const result = await client.testConnection();

    expect(result.success).toBe(true);
    expect(result.organisation).toBe('(no creditors found)');
  });
});

describe('GoCardlessClient.getPayouts', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns payouts and before-cursor on success', async () => {
    (global.fetch as any).mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        payouts: [
          { id: 'PO0001', amount: 1000, currency: 'GBP', status: 'paid' },
          { id: 'PO0002', amount: 2500, currency: 'GBP', status: 'paid' },
        ],
        meta: { cursors: { before: 'CUR_ABC' } },
      }),
    });

    const client = new GoCardlessClient({ accessToken: 'token', sandbox: true });
    const result = await client.getPayouts({
      status: 'paid',
      limit: 10,
      createdAtGte: '2026-04-01',
    });

    expect(result.success).toBe(true);
    expect(result.payouts).toHaveLength(2);
    expect(result.before).toBe('CUR_ABC');

    const fetchCall = (global.fetch as any).mock.calls[0];
    const url = fetchCall[0] as string;
    expect(url).toMatch(/\/payouts\?/);
    expect(url).toContain('status=paid');
    expect(url).toContain('limit=10');
    // GoCardless filter syntax — bracketed key URL-encoded
    expect(url).toMatch(/created_at(\[gte\]|%5Bgte%5D)=2026-04-01/);
  });

  it('omits query params when not provided', async () => {
    (global.fetch as any).mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ payouts: [], meta: { cursors: { before: null } } }),
    });

    const client = new GoCardlessClient({ accessToken: 'token', sandbox: true });
    const result = await client.getPayouts();

    expect(result.success).toBe(true);
    expect(result.payouts).toEqual([]);
    expect(result.before).toBeNull();

    const url = (global.fetch as any).mock.calls[0][0] as string;
    expect(url).toMatch(/\/payouts$/);
  });

  it('passes through before cursor for pagination', async () => {
    (global.fetch as any).mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ payouts: [], meta: { cursors: { before: null } } }),
    });

    const client = new GoCardlessClient({ accessToken: 'token', sandbox: true });
    await client.getPayouts({ before: 'PAGE_2' });

    const url = (global.fetch as any).mock.calls[0][0] as string;
    expect(url).toContain('before=PAGE_2');
  });

  it('returns success=false on 401', async () => {
    (global.fetch as any).mockResolvedValue({
      ok: false,
      status: 401,
      text: async () => 'Unauthorized',
    });

    const client = new GoCardlessClient({ accessToken: 'bad', sandbox: true });
    const result = await client.getPayouts();

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/Invalid GoCardless API token/);
    expect(result.payouts).toEqual([]);
    expect(result.before).toBeNull();
  });

  it('returns success=false on other HTTP errors', async () => {
    (global.fetch as any).mockResolvedValue({
      ok: false,
      status: 500,
      text: async () => 'Server crashed',
    });

    const client = new GoCardlessClient({ accessToken: 'token', sandbox: true });
    const result = await client.getPayouts();

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/500/);
    expect(result.error).toContain('Server crashed');
  });

  it('handles network errors', async () => {
    (global.fetch as any).mockRejectedValue(new Error('ECONNREFUSED'));

    const client = new GoCardlessClient({ accessToken: 'token', sandbox: true });
    const result = await client.getPayouts();

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/ECONNREFUSED/);
  });

  it('handles missing payouts array gracefully', async () => {
    (global.fetch as any).mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ meta: { cursors: {} } }),
    });

    const client = new GoCardlessClient({ accessToken: 'token', sandbox: true });
    const result = await client.getPayouts();

    expect(result.success).toBe(true);
    expect(result.payouts).toEqual([]);
    expect(result.before).toBeNull();
  });
});

describe('createClientFromSettings', () => {
  it('returns null when no token', () => {
    expect(createClientFromSettings({})).toBeNull();
    expect(createClientFromSettings({ api_access_token: '' })).toBeNull();
  });

  it('returns client when token present', () => {
    const client = createClientFromSettings({
      api_access_token: 'sandbox_token',
      api_sandbox: true,
    });
    expect(client).not.toBeNull();
  });
});

describe('GoCardlessClient.getBillingRequest', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns the billing request on 200', async () => {
    (global.fetch as any).mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        billing_requests: { id: 'BR1', status: 'fulfilled' },
      }),
    });
    const client = new GoCardlessClient({ accessToken: 'token', sandbox: true });
    const result = await client.getBillingRequest('BR1');
    expect(result.success).toBe(true);
    expect(result.billingRequest?.status).toBe('fulfilled');
    const url = (global.fetch as any).mock.calls[0][0] as string;
    expect(url).toMatch(/\/billing_requests\/BR1$/);
  });

  it('refuses empty id', async () => {
    const client = new GoCardlessClient({ accessToken: 'token', sandbox: true });
    const result = await client.getBillingRequest('');
    expect(result.success).toBe(false);
  });
});

describe('GoCardlessClient.createBillingRequest / createBillingRequestFlow', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('createBillingRequest POSTs the billing_requests envelope', async () => {
    (global.fetch as any).mockResolvedValue({
      ok: true,
      status: 201,
      json: async () => ({ billing_requests: { id: 'BR1', status: 'pending' } }),
    });
    const client = new GoCardlessClient({ accessToken: 'token', sandbox: true });
    const result = await client.createBillingRequest({
      customerEmail: 'a@b.com',
      customerName: 'Acme Ltd',
      metadata: { opera_account: 'CUST01' },
    });
    expect(result.success).toBe(true);
    expect(result.billingRequest?.id).toBe('BR1');
    const fetchCall = (global.fetch as any).mock.calls[0];
    expect(fetchCall[0]).toMatch(/\/billing_requests$/);
    const body = JSON.parse(fetchCall[1].body);
    expect(body.billing_requests.resources.customer.email).toBe('a@b.com');
    expect(body.billing_requests.metadata.opera_account).toBe('CUST01');
  });

  it('createBillingRequest refuses empty email', async () => {
    const client = new GoCardlessClient({ accessToken: 'token', sandbox: true });
    const result = await client.createBillingRequest({ customerEmail: '' });
    expect(result.success).toBe(false);
  });

  it('createBillingRequest reports HTTP errors', async () => {
    (global.fetch as any).mockResolvedValue({
      ok: false,
      status: 422,
      text: async () => 'invalid email',
    });
    const client = new GoCardlessClient({ accessToken: 'token', sandbox: true });
    const result = await client.createBillingRequest({
      customerEmail: 'a@b.com',
    });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/422/);
  });

  it('createBillingRequestFlow POSTs the billing_request_flows envelope', async () => {
    (global.fetch as any).mockResolvedValue({
      ok: true,
      status: 201,
      json: async () => ({
        billing_request_flows: {
          id: 'FL1',
          authorisation_url: 'https://gc/x',
        },
      }),
    });
    const client = new GoCardlessClient({ accessToken: 'token', sandbox: true });
    const result = await client.createBillingRequestFlow({
      billingRequestId: 'BR1',
    });
    expect(result.success).toBe(true);
    expect(result.flow?.authorisation_url).toBe('https://gc/x');
    const body = JSON.parse((global.fetch as any).mock.calls[0][1].body);
    expect(body.billing_request_flows.links.billing_request).toBe('BR1');
  });

  it('createBillingRequestFlow refuses empty id', async () => {
    const client = new GoCardlessClient({ accessToken: 'token', sandbox: true });
    const result = await client.createBillingRequestFlow({
      billingRequestId: '',
    });
    expect(result.success).toBe(false);
  });
});

describe('GoCardlessClient.createSubscription', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('POSTs the subscriptions wrapper with required fields + currency=GBP', async () => {
    (global.fetch as any).mockResolvedValue({
      ok: true,
      status: 201,
      json: async () => ({
        subscriptions: { id: 'SB_NEW', status: 'active' },
      }),
    });
    const client = new GoCardlessClient({ accessToken: 'token', sandbox: true });
    const result = await client.createSubscription({
      mandateId: 'MD1',
      amountPence: 12000,
      intervalUnit: 'monthly',
      interval: 1,
      name: 'Acme Quarterly',
      metadata: { opera_account: 'CUST01' },
    });
    expect(result.success).toBe(true);
    expect(result.subscription?.id).toBe('SB_NEW');
    const fetchCall = (global.fetch as any).mock.calls[0];
    expect(fetchCall[0]).toMatch(/\/subscriptions$/);
    expect(fetchCall[1].method).toBe('POST');
    const body = JSON.parse(fetchCall[1].body);
    expect(body.subscriptions.amount).toBe(12000);
    expect(body.subscriptions.currency).toBe('GBP');
    expect(body.subscriptions.interval_unit).toBe('monthly');
    expect(body.subscriptions.interval).toBe(1);
    expect(body.subscriptions.links.mandate).toBe('MD1');
    expect(body.subscriptions.metadata.opera_account).toBe('CUST01');
  });

  it('omits optional fields when not provided', async () => {
    (global.fetch as any).mockResolvedValue({
      ok: true,
      status: 201,
      json: async () => ({ subscriptions: { id: 'SB1' } }),
    });
    const client = new GoCardlessClient({ accessToken: 'token', sandbox: true });
    await client.createSubscription({
      mandateId: 'MD1',
      amountPence: 100,
      intervalUnit: 'monthly',
    });
    const body = JSON.parse((global.fetch as any).mock.calls[0][1].body);
    expect(body.subscriptions.day_of_month).toBeUndefined();
    expect(body.subscriptions.name).toBeUndefined();
    expect(body.subscriptions.start_date).toBeUndefined();
    expect(body.subscriptions.metadata).toBeUndefined();
    expect(body.subscriptions.interval).toBe(1);
  });

  it('refuses empty mandate id', async () => {
    const client = new GoCardlessClient({ accessToken: 'token', sandbox: true });
    const result = await client.createSubscription({
      mandateId: '',
      amountPence: 100,
      intervalUnit: 'monthly',
    });
    expect(result.success).toBe(false);
  });

  it('reports HTTP errors uniformly', async () => {
    (global.fetch as any).mockResolvedValue({
      ok: false,
      status: 422,
      text: async () => 'mandate not active',
    });
    const client = new GoCardlessClient({ accessToken: 'token', sandbox: true });
    const result = await client.createSubscription({
      mandateId: 'MD1',
      amountPence: 100,
      intervalUnit: 'monthly',
    });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/422/);
  });
});

describe('GoCardlessClient.listSubscriptions', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('passes filters and parses page + cursor', async () => {
    (global.fetch as any).mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        subscriptions: [{ id: 'SB1' }, { id: 'SB2' }],
        meta: { cursors: { after: 'NEXT' } },
      }),
    });
    const client = new GoCardlessClient({ accessToken: 'token', sandbox: true });
    const result = await client.listSubscriptions({
      mandateId: 'MD1',
      status: 'active',
      limit: 50,
      cursor: 'PREV',
    });
    expect(result.success).toBe(true);
    expect(result.subscriptions).toHaveLength(2);
    expect(result.after).toBe('NEXT');
    const url = (global.fetch as any).mock.calls[0][0] as string;
    expect(url).toContain('mandate=MD1');
    expect(url).toContain('status=active');
    expect(url).toContain('limit=50');
    expect(url).toContain('after=PREV');
  });

  it('caps limit at 500', async () => {
    (global.fetch as any).mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ subscriptions: [], meta: { cursors: {} } }),
    });
    const client = new GoCardlessClient({ accessToken: 'token', sandbox: true });
    await client.listSubscriptions({ limit: 1000 });
    const url = (global.fetch as any).mock.calls[0][0] as string;
    expect(url).toContain('limit=500');
  });

  it('returns empty array on 401', async () => {
    (global.fetch as any).mockResolvedValue({
      ok: false,
      status: 401,
      text: async () => 'Unauthorized',
    });
    const client = new GoCardlessClient({ accessToken: 'bad', sandbox: true });
    const result = await client.listSubscriptions();
    expect(result.success).toBe(false);
    expect(result.subscriptions).toEqual([]);
    expect(result.after).toBeNull();
  });
});

describe('GoCardlessClient.getMandate / getCustomer', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('getMandate returns the mandate on 200', async () => {
    (global.fetch as any).mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        mandates: { id: 'MD1', status: 'active', scheme: 'bacs' },
      }),
    });
    const client = new GoCardlessClient({ accessToken: 'token', sandbox: true });
    const result = await client.getMandate('MD1');
    expect(result.success).toBe(true);
    expect(result.mandate?.status).toBe('active');
    const url = (global.fetch as any).mock.calls[0][0] as string;
    expect(url).toMatch(/\/mandates\/MD1$/);
  });

  it('getMandate returns 404-friendly error on bad status', async () => {
    (global.fetch as any).mockResolvedValue({
      ok: false,
      status: 404,
      text: async () => 'not found',
    });
    const client = new GoCardlessClient({ accessToken: 'token', sandbox: true });
    const result = await client.getMandate('MISSING');
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/404/);
  });

  it('getMandate refuses empty id', async () => {
    const client = new GoCardlessClient({ accessToken: 'token', sandbox: true });
    const result = await client.getMandate('');
    expect(result.success).toBe(false);
  });

  it('getCustomer returns the customer on 200', async () => {
    (global.fetch as any).mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        customers: { id: 'CU1', email: 'a@b.com', given_name: 'Jane' },
      }),
    });
    const client = new GoCardlessClient({ accessToken: 'token', sandbox: true });
    const result = await client.getCustomer('CU1');
    expect(result.success).toBe(true);
    expect(result.customer?.email).toBe('a@b.com');
    const url = (global.fetch as any).mock.calls[0][0] as string;
    expect(url).toMatch(/\/customers\/CU1$/);
  });

  it('getCustomer refuses empty id', async () => {
    const client = new GoCardlessClient({ accessToken: 'token', sandbox: true });
    const result = await client.getCustomer('');
    expect(result.success).toBe(false);
  });
});

describe('GoCardlessClient.createPayment', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('POSTs the payments wrapper with the expected body', async () => {
    (global.fetch as any).mockResolvedValue({
      ok: true,
      status: 201,
      json: async () => ({ payments: { id: 'PM1', status: 'pending_submission' } }),
    });
    const client = new GoCardlessClient({ accessToken: 'token', sandbox: true });
    const result = await client.createPayment({
      amountPence: 5000,
      mandateId: 'MD1',
      description: 'INV001',
      chargeDate: '2026-05-15',
      metadata: { opera_account: 'CUST01', invoices: 'INV001' },
    });
    expect(result.success).toBe(true);
    expect(result.payment?.id).toBe('PM1');
    const fetchCall = (global.fetch as any).mock.calls[0];
    expect(fetchCall[0]).toMatch(/\/payments$/);
    expect(fetchCall[1].method).toBe('POST');
    const body = JSON.parse(fetchCall[1].body);
    expect(body.payments.amount).toBe(5000);
    expect(body.payments.currency).toBe('GBP');
    expect(body.payments.links.mandate).toBe('MD1');
    expect(body.payments.charge_date).toBe('2026-05-15');
    expect(body.payments.metadata.opera_account).toBe('CUST01');
    expect(body.payments.retry_if_possible).toBe(true);
  });

  it('omits optional fields when not provided', async () => {
    (global.fetch as any).mockResolvedValue({
      ok: true,
      status: 201,
      json: async () => ({ payments: { id: 'PM1' } }),
    });
    const client = new GoCardlessClient({ accessToken: 'token', sandbox: true });
    await client.createPayment({ amountPence: 100, mandateId: 'MD1' });
    const body = JSON.parse((global.fetch as any).mock.calls[0][1].body);
    expect(body.payments.charge_date).toBeUndefined();
    expect(body.payments.description).toBeUndefined();
    expect(body.payments.metadata).toBeUndefined();
  });

  it('honours retryIfPossible=false', async () => {
    (global.fetch as any).mockResolvedValue({
      ok: true,
      status: 201,
      json: async () => ({ payments: { id: 'PM1' } }),
    });
    const client = new GoCardlessClient({ accessToken: 'token', sandbox: true });
    await client.createPayment({
      amountPence: 100,
      mandateId: 'MD1',
      retryIfPossible: false,
    });
    const body = JSON.parse((global.fetch as any).mock.calls[0][1].body);
    expect(body.payments.retry_if_possible).toBe(false);
  });

  it('reports HTTP errors uniformly', async () => {
    (global.fetch as any).mockResolvedValue({
      ok: false,
      status: 422,
      text: async () => 'mandate not active',
    });
    const client = new GoCardlessClient({ accessToken: 'token', sandbox: true });
    const result = await client.createPayment({
      amountPence: 100,
      mandateId: 'MD1',
    });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/422/);
  });

  it('refuses empty mandate id', async () => {
    const client = new GoCardlessClient({ accessToken: 'token', sandbox: true });
    const result = await client.createPayment({ amountPence: 100, mandateId: '' });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/mandateId required/);
  });
});

describe('GoCardlessClient.getSubscription', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns the subscription on 200', async () => {
    (global.fetch as any).mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ subscriptions: { id: 'SB1', status: 'active' } }),
    });
    const client = new GoCardlessClient({ accessToken: 'token', sandbox: true });
    const result = await client.getSubscription('SB1');
    expect(result.success).toBe(true);
    expect(result.subscription?.id).toBe('SB1');
    const url = (global.fetch as any).mock.calls[0][0] as string;
    expect(url).toMatch(/\/subscriptions\/SB1$/);
    expect((global.fetch as any).mock.calls[0][1].method).toBe('GET');
  });

  it('returns 401 error on bad token', async () => {
    (global.fetch as any).mockResolvedValue({
      ok: false,
      status: 401,
      text: async () => 'Unauthorized',
    });
    const client = new GoCardlessClient({ accessToken: 'bad', sandbox: true });
    const result = await client.getSubscription('SB1');
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/401/);
  });

  it('refuses empty subscription id', async () => {
    const client = new GoCardlessClient({ accessToken: 'token', sandbox: true });
    const result = await client.getSubscription('');
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/subscriptionId required/);
  });
});

describe('GoCardlessClient.updateSubscription', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('PUTs subscriptions wrapper with only provided fields', async () => {
    (global.fetch as any).mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        subscriptions: { id: 'SB1', amount: 5000, status: 'active' },
      }),
    });
    const client = new GoCardlessClient({ accessToken: 'token', sandbox: true });
    const result = await client.updateSubscription('SB1', { amountPence: 5000 });
    expect(result.success).toBe(true);
    expect(result.subscription?.amount).toBe(5000);
    const fetchCall = (global.fetch as any).mock.calls[0];
    expect(fetchCall[1].method).toBe('PUT');
    const body = JSON.parse(fetchCall[1].body);
    expect(body).toEqual({ subscriptions: { amount: 5000 } });
  });

  it('passes name and metadata through', async () => {
    (global.fetch as any).mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ subscriptions: { id: 'SB1' } }),
    });
    const client = new GoCardlessClient({ accessToken: 'token', sandbox: true });
    await client.updateSubscription('SB1', {
      name: 'New Name',
      metadata: { foo: 'bar' },
    });
    const body = JSON.parse((global.fetch as any).mock.calls[0][1].body);
    expect(body.subscriptions.name).toBe('New Name');
    expect(body.subscriptions.metadata).toEqual({ foo: 'bar' });
    expect(body.subscriptions.amount).toBeUndefined();
  });

  it('returns error message on HTTP failure', async () => {
    (global.fetch as any).mockResolvedValue({
      ok: false,
      status: 422,
      text: async () => 'invalid amount',
    });
    const client = new GoCardlessClient({ accessToken: 'token', sandbox: true });
    const result = await client.updateSubscription('SB1', { amountPence: -1 });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/422/);
    expect(result.error).toContain('invalid amount');
  });

  it('refuses empty subscription id', async () => {
    const client = new GoCardlessClient({ accessToken: 'token', sandbox: true });
    const result = await client.updateSubscription('', { name: 'X' });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/subscriptionId required/);
  });
});

describe('GoCardlessClient.pauseSubscription / resumeSubscription / cancelSubscription', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('pauseSubscription POSTs to /actions/pause', async () => {
    (global.fetch as any).mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ subscriptions: { id: 'SB1', status: 'paused' } }),
    });
    const client = new GoCardlessClient({ accessToken: 'token', sandbox: true });
    const result = await client.pauseSubscription('SB1');
    expect(result.success).toBe(true);
    expect(result.subscription?.status).toBe('paused');
    const fetchCall = (global.fetch as any).mock.calls[0];
    expect(fetchCall[0]).toMatch(/\/subscriptions\/SB1\/actions\/pause$/);
    expect(fetchCall[1].method).toBe('POST');
  });

  it('resumeSubscription POSTs to /actions/resume', async () => {
    (global.fetch as any).mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ subscriptions: { id: 'SB1', status: 'active' } }),
    });
    const client = new GoCardlessClient({ accessToken: 'token', sandbox: true });
    const result = await client.resumeSubscription('SB1');
    expect(result.success).toBe(true);
    expect(result.subscription?.status).toBe('active');
    const url = (global.fetch as any).mock.calls[0][0] as string;
    expect(url).toMatch(/\/actions\/resume$/);
  });

  it('cancelSubscription POSTs to /actions/cancel', async () => {
    (global.fetch as any).mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ subscriptions: { id: 'SB1', status: 'cancelled' } }),
    });
    const client = new GoCardlessClient({ accessToken: 'token', sandbox: true });
    const result = await client.cancelSubscription('SB1');
    expect(result.success).toBe(true);
    expect(result.subscription?.status).toBe('cancelled');
    const url = (global.fetch as any).mock.calls[0][0] as string;
    expect(url).toMatch(/\/actions\/cancel$/);
  });

  it('reports HTTP errors uniformly', async () => {
    (global.fetch as any).mockResolvedValue({
      ok: false,
      status: 422,
      text: async () => 'cannot pause',
    });
    const client = new GoCardlessClient({ accessToken: 'token', sandbox: true });
    const result = await client.pauseSubscription('SB1');
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/422/);
  });

  it('refuses empty subscription id', async () => {
    const client = new GoCardlessClient({ accessToken: 'token', sandbox: true });
    expect((await client.pauseSubscription('')).success).toBe(false);
    expect((await client.resumeSubscription('')).success).toBe(false);
    expect((await client.cancelSubscription('')).success).toBe(false);
  });
});
