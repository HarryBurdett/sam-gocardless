import { describe, it, expect } from 'vitest';
import {
  GoCardlessPartnerClient,
  createPartnerClientFromSettings,
} from '../src/services/gocardless-api.js';
import {
  initiatePartnerSignup,
  handlePartnerCallback,
  partnerCallbackHtml,
} from '../src/services/partner.js';

interface SignupRow {
  id: number;
  company_name: string | null;
  company_email: string | null;
  authorisation_url: string | null;
  status: string | null;
  status_detail: string | null;
  access_token_obtained: number | boolean;
  merchant_access_token: string | null;
  merchant_organisation_id: string | null;
  merchant_creditor_name: string | null;
  partner_referral_id: string | null;
  completed_at: string | null;
  updated_at: string | null;
}

interface MockState {
  settings: Record<string, unknown> | null;
  signups: SignupRow[];
  nextId: number;
}

function makeAppDb(state: MockState): any {
  const db: any = (table: string) => {
    if (table === 'settings') {
      const builder: any = {
        where: () => builder,
        first: () =>
          Promise.resolve(
            state.settings === null
              ? undefined
              : { id: 1, key: 'gocardless_settings', value: JSON.stringify(state.settings) },
          ),
        insert: (row: Record<string, unknown>) => {
          state.settings = JSON.parse(String(row.value));
          return Promise.resolve([1]);
        },
        update: (row: Record<string, unknown>) => {
          state.settings = JSON.parse(String(row.value));
          return Promise.resolve(1);
        },
      };
      return builder;
    }
    if (table === 'gocardless_partner_signups') {
      let where: Record<string, unknown> | null = null;
      let orderDir: 'asc' | 'desc' = 'asc';
      const builder: any = {
        where: (cond: Record<string, unknown>) => {
          where = cond;
          return builder;
        },
        orderBy: (_col: string, dir: 'asc' | 'desc' = 'asc') => {
          orderDir = dir;
          return builder;
        },
        first: () => {
          let rows = [...state.signups];
          if (where) {
            rows = rows.filter((r) =>
              Object.entries(where!).every(([k, v]) => (r as any)[k] === v),
            );
          }
          rows.sort((a, b) => (orderDir === 'desc' ? b.id - a.id : a.id - b.id));
          return Promise.resolve(rows[0]);
        },
        update: (data: Record<string, unknown>) => {
          let count = 0;
          for (const r of state.signups) {
            const matches = where
              ? Object.entries(where).every(([k, v]) => (r as any)[k] === v)
              : false;
            if (matches) {
              Object.assign(r, data);
              count++;
            }
          }
          return Promise.resolve(count);
        },
        insert: (row: Record<string, unknown>) => ({
          returning: (_: string) => {
            const id = state.nextId++;
            state.signups.push({
              id,
              company_name: (row.company_name as string) ?? null,
              company_email: (row.company_email as string) ?? null,
              authorisation_url: (row.authorisation_url as string) ?? null,
              status: (row.status as string) ?? 'pending',
              status_detail: (row.status_detail as string) ?? null,
              access_token_obtained: 0,
              merchant_access_token: null,
              merchant_organisation_id: null,
              merchant_creditor_name: null,
              partner_referral_id: null,
              completed_at: null,
              updated_at: null,
            });
            return Promise.resolve([{ id }]);
          },
        }),
      };
      return builder;
    }
    throw new Error(`Unexpected table: ${table}`);
  };
  db.fn = { now: () => 'NOW()' };
  return db;
}

// =====================================================================
// GoCardlessPartnerClient
// =====================================================================

describe('GoCardlessPartnerClient.getAuthorisationUrl', () => {
  it('uses sandbox connect URL by default and bracketed prefill keys', () => {
    const c = new GoCardlessPartnerClient({
      clientId: 'CID',
      clientSecret: 'SEC',
      // sandbox defaults to true via the Options type
    });
    const url = c.getAuthorisationUrl({
      redirectUri: 'https://app.example.com/cb',
      prefillEmail: 'op@example.com',
      prefillCompanyName: 'Acme Ltd',
      state: 'STATE-1',
    });
    expect(url).toMatch(/^https:\/\/connect-sandbox\.gocardless\.com\/oauth\/authorize\?/);
    expect(url).toContain('response_type=code');
    expect(url).toContain('client_id=CID');
    expect(url).toContain('scope=read_write');
    expect(url).toContain('redirect_uri=https%3A%2F%2Fapp.example.com%2Fcb');
    expect(url).toContain('access_type=offline');
    expect(url).toMatch(/prefill(\[email\]|%5Bemail%5D)=op%40example\.com/);
    expect(url).toMatch(/prefill(\[company_name\]|%5Bcompany_name%5D)=Acme/);
    expect(url).toContain('state=STATE-1');
  });

  it('uses live connect URL when sandbox=false', () => {
    const c = new GoCardlessPartnerClient({
      clientId: 'CID',
      clientSecret: 'SEC',
      sandbox: false,
    });
    const url = c.getAuthorisationUrl({ redirectUri: 'https://x' });
    expect(url).toMatch(/^https:\/\/connect\.gocardless\.com\//);
  });

  it('omits prefill/state when not supplied', () => {
    const c = new GoCardlessPartnerClient({ clientId: 'C', clientSecret: 'S' });
    const url = c.getAuthorisationUrl({ redirectUri: 'https://x' });
    expect(url).not.toContain('prefill');
    expect(url).not.toContain('state=');
  });
});

describe('GoCardlessPartnerClient.exchangeAuthorisationCode', () => {
  it('POSTs JSON with grant_type=authorization_code and returns parsed body on 200', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fakeFetch = (u: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(u), init });
      return Promise.resolve({
        status: 200,
        ok: true,
        json: async () => ({
          access_token: 'AT-1',
          token_type: 'bearer',
          scope: 'read_write',
          organisation_id: 'OG_ABC',
        }),
        text: async () => '',
      } as Response);
    };
    const c = new GoCardlessPartnerClient({
      clientId: 'CID',
      clientSecret: 'SEC',
      fetchImpl: fakeFetch as any,
    });
    const r = await c.exchangeAuthorisationCode('CODE-1', 'https://x/cb');
    expect(r.success).toBe(true);
    expect(r.data?.access_token).toBe('AT-1');
    expect(r.data?.organisation_id).toBe('OG_ABC');

    expect(calls[0]?.url).toMatch(/connect-sandbox.*\/oauth\/access_token$/);
    expect(calls[0]?.init?.method).toBe('POST');
    const body = JSON.parse(String(calls[0]?.init?.body ?? '{}'));
    expect(body).toEqual({
      grant_type: 'authorization_code',
      client_id: 'CID',
      client_secret: 'SEC',
      code: 'CODE-1',
      redirect_uri: 'https://x/cb',
    });
  });

  it('returns failure with error_description when status != 200', async () => {
    const fakeFetch = () =>
      Promise.resolve({
        status: 400,
        ok: false,
        text: async () =>
          JSON.stringify({
            error: 'invalid_grant',
            error_description: 'code expired',
          }),
        json: async () => ({}),
      } as Response);
    const c = new GoCardlessPartnerClient({
      clientId: 'CID',
      clientSecret: 'SEC',
      fetchImpl: fakeFetch as any,
    });
    const r = await c.exchangeAuthorisationCode('BAD', 'https://x');
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/code expired/);
  });

  it('returns failure on network error', async () => {
    const fakeFetch = () => Promise.reject(new Error('ECONNREFUSED'));
    const c = new GoCardlessPartnerClient({
      clientId: 'CID',
      clientSecret: 'SEC',
      fetchImpl: fakeFetch as any,
    });
    const r = await c.exchangeAuthorisationCode('X', 'https://x');
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/ECONNREFUSED/);
  });
});

describe('GoCardlessPartnerClient.getOrganisationInfo', () => {
  it('returns first creditor on 200', async () => {
    const fakeFetch = () =>
      Promise.resolve({
        status: 200,
        ok: true,
        json: async () => ({ creditors: [{ id: 'CR1', name: 'Acme Ltd' }] }),
      } as Response);
    const c = new GoCardlessPartnerClient({
      clientId: 'C',
      clientSecret: 'S',
      fetchImpl: fakeFetch as any,
    });
    const r = await c.getOrganisationInfo('TKN');
    expect(r.success).toBe(true);
    expect(r.organisation?.name).toBe('Acme Ltd');
  });

  it('returns empty object when no creditors', async () => {
    const fakeFetch = () =>
      Promise.resolve({
        status: 200,
        ok: true,
        json: async () => ({ creditors: [] }),
      } as Response);
    const c = new GoCardlessPartnerClient({
      clientId: 'C',
      clientSecret: 'S',
      fetchImpl: fakeFetch as any,
    });
    const r = await c.getOrganisationInfo('TKN');
    expect(r.success).toBe(true);
    expect(r.organisation).toEqual({});
  });

  it('returns failure on non-200', async () => {
    const fakeFetch = () =>
      Promise.resolve({ status: 401, ok: false } as Response);
    const c = new GoCardlessPartnerClient({
      clientId: 'C',
      clientSecret: 'S',
      fetchImpl: fakeFetch as any,
    });
    const r = await c.getOrganisationInfo('TKN');
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/401/);
  });
});

describe('createPartnerClientFromSettings', () => {
  it('returns null when neither id nor secret', () => {
    expect(createPartnerClientFromSettings({})).toBeNull();
  });
  it('returns null when only one credential', () => {
    expect(
      createPartnerClientFromSettings({ partner_client_id: 'X' }),
    ).toBeNull();
  });
  it('returns client when both set', () => {
    expect(
      createPartnerClientFromSettings({
        partner_client_id: 'X',
        partner_client_secret: 'Y',
        api_sandbox: true,
      }),
    ).toBeInstanceOf(GoCardlessPartnerClient);
  });
});

// =====================================================================
// initiatePartnerSignup
// =====================================================================

describe('initiatePartnerSignup', () => {
  it('rejects missing email', async () => {
    const db = makeAppDb({ settings: {}, signups: [], nextId: 1 });
    const r = await initiatePartnerSignup(db, { companyEmail: '' });
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/email is required/);
  });

  it('returns next_step=manual when no partner credentials', async () => {
    const db = makeAppDb({ settings: {}, signups: [], nextId: 1 });
    const r = await initiatePartnerSignup(db, {
      companyEmail: 'foo@example.com',
    });
    expect(r.success).toBe(true);
    expect(r.next_step).toBe('manual');
    expect(r.authorisation_url).toBeNull();
    expect(r.signup_id).toBe(1);
  });

  it('returns auth URL + writes pending signup with state token', async () => {
    const state: MockState = {
      settings: {
        partner_client_id: 'CID',
        partner_client_secret: 'SEC',
        api_sandbox: true,
      },
      signups: [],
      nextId: 1,
    };
    const r = await initiatePartnerSignup(makeAppDb(state), {
      companyEmail: 'foo@example.com',
      companyName: 'Foo Ltd',
      baseUrl: 'https://app.example.com',
    });
    expect(r.success).toBe(true);
    expect(r.authorisation_url).toMatch(/connect-sandbox\.gocardless\.com/);
    expect(r.authorisation_url).toContain('client_id=CID');
    expect(r.authorisation_url).toContain('redirect_uri=');
    // Default redirect URI = base + /api/gocardless/partner/callback
    expect(r.authorisation_url).toMatch(/redirect_uri=https%3A%2F%2Fapp\.example\.com%2Fapi%2Fgocardless%2Fpartner%2Fcallback/);
    expect(state.signups).toHaveLength(1);
    expect(state.signups[0]?.company_email).toBe('foo@example.com');
    // status_detail holds the state token for CSRF check
    expect(state.signups[0]?.status_detail).toBeTruthy();
    expect(state.signups[0]?.status_detail?.length).toBeGreaterThan(20);
    // Auth URL contains that same state token
    const stateMatch = /state=([^&]+)/.exec(r.authorisation_url ?? '');
    expect(stateMatch?.[1]).toBe(state.signups[0]?.status_detail);
  });
});

// =====================================================================
// handlePartnerCallback
// =====================================================================

describe('handlePartnerCallback', () => {
  function withSettings(): MockState {
    return {
      settings: {
        partner_client_id: 'CID',
        partner_client_secret: 'SEC',
        api_sandbox: true,
      },
      signups: [],
      nextId: 1,
    };
  }

  it('returns Signup Error when GoCardless returned ?error', async () => {
    const r = await handlePartnerCallback(makeAppDb(withSettings()), {
      error: 'access_denied',
    });
    expect(r.ok).toBe(false);
    expect(r.title).toBe('Signup Error');
    expect(r.message).toMatch(/access_denied/);
  });

  it('returns Missing Code when no ?code', async () => {
    const r = await handlePartnerCallback(makeAppDb(withSettings()), {});
    expect(r.ok).toBe(false);
    expect(r.title).toBe('Missing Code');
  });

  it('returns Not Configured when partner credentials missing', async () => {
    const r = await handlePartnerCallback(
      makeAppDb({ settings: {}, signups: [], nextId: 1 }),
      { code: 'CODE' },
    );
    expect(r.ok).toBe(false);
    expect(r.title).toBe('Not Configured');
  });

  it('rejects mismatched state token', async () => {
    const state = withSettings();
    state.signups.push({
      id: 1,
      company_name: 'Foo',
      company_email: 'f@e',
      authorisation_url: 'https://x',
      status: 'pending',
      status_detail: 'TOKEN-A',
      access_token_obtained: 0,
      merchant_access_token: null,
      merchant_organisation_id: null,
      merchant_creditor_name: null,
      partner_referral_id: null,
      completed_at: null,
      updated_at: null,
    });
    const r = await handlePartnerCallback(makeAppDb(state), {
      code: 'CODE',
      state: 'TOKEN-B',
    });
    expect(r.ok).toBe(false);
    expect(r.title).toBe('Invalid Request');
  });

  it('exchanges code, fetches creditor, updates signup, returns Account Connected', async () => {
    const state = withSettings();
    state.signups.push({
      id: 1,
      company_name: 'Foo',
      company_email: 'f@e',
      authorisation_url: 'https://x',
      status: 'pending',
      status_detail: 'STATE-OK',
      access_token_obtained: 0,
      merchant_access_token: null,
      merchant_organisation_id: null,
      merchant_creditor_name: null,
      partner_referral_id: null,
      completed_at: null,
      updated_at: null,
    });

    const fakeFetch = (u: string | URL | Request) => {
      const url = String(u);
      if (url.includes('/oauth/access_token')) {
        return Promise.resolve({
          status: 200,
          ok: true,
          json: async () => ({
            access_token: 'MT-1',
            organisation_id: 'OG-1',
          }),
          text: async () => '',
        } as Response);
      }
      if (url.includes('/creditors')) {
        return Promise.resolve({
          status: 200,
          ok: true,
          json: async () => ({ creditors: [{ id: 'CR1', name: 'Foo Ltd' }] }),
        } as Response);
      }
      return Promise.reject(new Error('unexpected URL'));
    };

    const r = await handlePartnerCallback(
      makeAppDb(state),
      { code: 'CODE', state: 'STATE-OK', baseUrl: 'https://app.example.com' },
      fakeFetch as any,
    );
    expect(r.ok).toBe(true);
    expect(r.title).toBe('Account Connected');
    expect(r.message).toMatch(/Foo Ltd/);

    expect(state.signups[0]?.status).toBe('completed');
    expect(state.signups[0]?.merchant_access_token).toBe('MT-1');
    expect(state.signups[0]?.merchant_organisation_id).toBe('OG-1');
    expect(state.signups[0]?.merchant_creditor_name).toBe('Foo Ltd');
    expect(state.signups[0]?.access_token_obtained).toBe(true);
  });

  it('returns Connection Failed on token exchange error', async () => {
    const fakeFetch = () =>
      Promise.resolve({
        status: 400,
        ok: false,
        text: async () =>
          JSON.stringify({
            error: 'invalid_grant',
            error_description: 'code expired',
          }),
        json: async () => ({}),
      } as Response);
    const state = withSettings();
    state.signups.push({
      id: 1, company_name: null, company_email: null,
      authorisation_url: null, status: 'pending', status_detail: 'STATE',
      access_token_obtained: 0, merchant_access_token: null,
      merchant_organisation_id: null, merchant_creditor_name: null,
      partner_referral_id: null, completed_at: null, updated_at: null,
    });
    const r = await handlePartnerCallback(
      makeAppDb(state),
      { code: 'CODE', state: 'STATE' },
      fakeFetch as any,
    );
    expect(r.ok).toBe(false);
    expect(r.title).toBe('Connection Failed');
    expect(r.message).toMatch(/code expired/);
  });
});

// =====================================================================
// partnerCallbackHtml
// =====================================================================

describe('partnerCallbackHtml', () => {
  it('renders success styling', () => {
    const html = partnerCallbackHtml({
      ok: true,
      title: 'OK',
      message: 'Done',
    });
    expect(html).toContain('#10b981'); // green
    expect(html).toContain('&#10003;'); // checkmark
    expect(html).toContain('OK');
    expect(html).toContain('Done');
  });

  it('renders failure styling', () => {
    const html = partnerCallbackHtml({
      ok: false,
      title: 'FAIL',
      message: 'Bad',
    });
    expect(html).toContain('#ef4444'); // red
    expect(html).toContain('&#10007;'); // x mark
  });
});
