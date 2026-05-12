import { describe, it, expect, beforeEach } from 'vitest';
import {
  getPartnerConfig,
  getLatestPartnerSignup,
  getAllMerchantSignups,
  partnerAdminAuth,
  setPartnerAdminPassword,
  updateMerchantAppUrl,
  activateMerchant,
  deployToken,
} from '../src/services/partner.js';

interface SignupRow {
  id: number;
  company_name: string | null;
  company_email: string | null;
  billing_request_id: string | null;
  billing_request_flow_id: string | null;
  authorisation_url: string | null;
  status: string;
  status_detail: string | null;
  access_token_obtained: number | boolean;
  merchant_access_token: string | null;
  merchant_organisation_id: string | null;
  merchant_creditor_name: string | null;
  merchant_app_url: string | null;
  partner_referral_id: string | null;
  created_at: string;
  completed_at: string | null;
  updated_at: string | null;
}

interface MockState {
  settings: Record<string, unknown> | null;
  signups: SignupRow[];
  saveSucceeded?: boolean;
}

function makeAppDb(state: MockState): any {
  const db: any = (table: string) => {
    if (table === 'settings') {
      let captured: Record<string, unknown> | null = null;
      const builder: any = {
        where: (cond: Record<string, unknown>) => {
          captured = cond;
          return builder;
        },
        first: () => {
          if (state.settings === null) return Promise.resolve(undefined);
          return Promise.resolve({
            id: 1,
            key: 'gocardless_settings',
            value: JSON.stringify(state.settings),
          });
        },
        insert: (row: Record<string, unknown>) => {
          state.settings = JSON.parse(String(row.value));
          if (state.saveSucceeded === false) return Promise.reject(new Error('insert failed'));
          return Promise.resolve([1]);
        },
        update: (row: Record<string, unknown>) => {
          state.settings = JSON.parse(String(row.value));
          if (state.saveSucceeded === false) return Promise.reject(new Error('update failed'));
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
        then: (cb: (rows: SignupRow[]) => unknown) => {
          let rows = [...state.signups];
          if (where) {
            rows = rows.filter((r) =>
              Object.entries(where!).every(([k, v]) => (r as any)[k] === v),
            );
          }
          rows.sort((a, b) => (orderDir === 'desc' ? b.id - a.id : a.id - b.id));
          return Promise.resolve(cb(rows));
        },
      };
      return builder;
    }
    throw new Error(`Unexpected table: ${table}`);
  };
  db.fn = { now: () => 'NOW()' };
  return db;
}

// ---------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------

describe('getPartnerConfig', () => {
  it('reports configured=true when both client id and secret set', async () => {
    const db = makeAppDb({
      settings: {
        partner_client_id: 'CID',
        partner_client_secret: 'SEC',
        api_sandbox: true,
        partner_redirect_uri: 'https://app.example.com/cb',
      },
      signups: [],
    });
    const result = await getPartnerConfig(db);
    expect(result.partner_configured).toBe(true);
    expect(result.partner_sandbox).toBe(true);
    expect(result.redirect_uri).toBe('https://app.example.com/cb');
  });

  it('reports configured=false when only id is set', async () => {
    const db = makeAppDb({
      settings: { partner_client_id: 'CID' },
      signups: [],
    });
    const result = await getPartnerConfig(db);
    expect(result.partner_configured).toBe(false);
  });

  it('falls back to base URL + /api/gocardless/partner/callback', async () => {
    const db = makeAppDb({
      settings: { partner_client_id: 'CID', partner_client_secret: 'SEC' },
      signups: [],
    });
    const result = await getPartnerConfig(db, {
      baseUrl: 'https://app.example.com',
    });
    expect(result.redirect_uri).toBe(
      'https://app.example.com/api/gocardless/partner/callback',
    );
  });

  it('strips trailing slashes from base URL fallback', async () => {
    const db = makeAppDb({
      settings: { partner_client_id: 'CID', partner_client_secret: 'SEC' },
      signups: [],
    });
    const result = await getPartnerConfig(db, {
      baseUrl: 'https://app.example.com/',
    });
    expect(result.redirect_uri).toBe(
      'https://app.example.com/api/gocardless/partner/callback',
    );
  });

  it('returns success=false on error', async () => {
    const failing: any = () => {
      throw new Error('settings table missing');
    };
    failing.fn = { now: () => 'NOW()' };
    const result = await getPartnerConfig(failing);
    expect(result.success).toBe(false);
  });
});

describe('getLatestPartnerSignup', () => {
  it('returns null when no signups recorded', async () => {
    const db = makeAppDb({ settings: {}, signups: [] });
    const result = await getLatestPartnerSignup(db);
    expect(result.success).toBe(true);
    expect(result.signup).toBeNull();
  });

  it('returns the highest-id row with token stripped', async () => {
    const db = makeAppDb({
      settings: {},
      signups: [
        {
          id: 1,
          company_name: 'Acme',
          company_email: 'a@a.com',
          billing_request_id: 'BR1',
          billing_request_flow_id: null,
          authorisation_url: null,
          status: 'completed',
          status_detail: null,
          access_token_obtained: 1,
          merchant_access_token: 'SECRET-TOKEN',
          merchant_organisation_id: 'OG1',
          merchant_creditor_name: 'Acme Ltd',
          merchant_app_url: null,
          partner_referral_id: null,
          created_at: '2026-04-10',
          completed_at: '2026-04-12',
          updated_at: '2026-04-12',
        },
        {
          id: 2,
          company_name: 'Beta',
          company_email: 'b@b.com',
          billing_request_id: 'BR2',
          billing_request_flow_id: null,
          authorisation_url: null,
          status: 'pending',
          status_detail: null,
          access_token_obtained: 0,
          merchant_access_token: null,
          merchant_organisation_id: null,
          merchant_creditor_name: null,
          merchant_app_url: null,
          partner_referral_id: null,
          created_at: '2026-04-15',
          completed_at: null,
          updated_at: null,
        },
      ],
    });
    const result = await getLatestPartnerSignup(db);
    expect(result.signup?.id).toBe(2);
    // Confirm the response shape doesn't have merchant_access_token
    expect(JSON.stringify(result.signup)).not.toContain('SECRET-TOKEN');
    expect(JSON.stringify(result.signup)).not.toContain(
      'merchant_access_token',
    );
  });

  it('marks has_token=true when token is present', async () => {
    const db = makeAppDb({
      settings: {},
      signups: [
        {
          id: 1,
          company_name: null,
          company_email: null,
          billing_request_id: null,
          billing_request_flow_id: null,
          authorisation_url: null,
          status: 'completed',
          status_detail: null,
          access_token_obtained: 1,
          merchant_access_token: 'token',
          merchant_organisation_id: null,
          merchant_creditor_name: null,
          merchant_app_url: null,
          partner_referral_id: null,
          created_at: '2026-04-15',
          completed_at: null,
          updated_at: null,
        },
      ],
    });
    const result = await getLatestPartnerSignup(db);
    expect(result.signup?.has_token).toBe(true);
  });
});

describe('getAllMerchantSignups', () => {
  beforeEach(() => {});

  it('returns all signups ordered by id desc, with tokens stripped', async () => {
    const db = makeAppDb({
      settings: {},
      signups: [
        {
          id: 1,
          company_name: 'A',
          company_email: null,
          billing_request_id: null,
          billing_request_flow_id: null,
          authorisation_url: null,
          status: 'completed',
          status_detail: null,
          access_token_obtained: 1,
          merchant_access_token: 'AAA',
          merchant_organisation_id: null,
          merchant_creditor_name: null,
          merchant_app_url: null,
          partner_referral_id: null,
          created_at: '2026-04-10',
          completed_at: '2026-04-11',
          updated_at: '2026-04-11',
        },
        {
          id: 2,
          company_name: 'B',
          company_email: null,
          billing_request_id: null,
          billing_request_flow_id: null,
          authorisation_url: null,
          status: 'pending',
          status_detail: null,
          access_token_obtained: 0,
          merchant_access_token: null,
          merchant_organisation_id: null,
          merchant_creditor_name: null,
          merchant_app_url: null,
          partner_referral_id: null,
          created_at: '2026-04-15',
          completed_at: null,
          updated_at: null,
        },
      ],
    });
    const result = await getAllMerchantSignups(db);
    expect(result.merchants).toHaveLength(2);
    expect(result.merchants[0]?.id).toBe(2);
    expect(result.merchants[1]?.id).toBe(1);
    expect(JSON.stringify(result.merchants)).not.toContain('AAA');
  });

  it('filters by status when provided', async () => {
    const db = makeAppDb({
      settings: {},
      signups: [
        {
          id: 1,
          company_name: 'A',
          company_email: null,
          billing_request_id: null,
          billing_request_flow_id: null,
          authorisation_url: null,
          status: 'completed',
          status_detail: null,
          access_token_obtained: 1,
          merchant_access_token: null,
          merchant_organisation_id: null,
          merchant_creditor_name: null,
          merchant_app_url: null,
          partner_referral_id: null,
          created_at: '2026-04-10',
          completed_at: null,
          updated_at: null,
        },
        {
          id: 2,
          company_name: 'B',
          company_email: null,
          billing_request_id: null,
          billing_request_flow_id: null,
          authorisation_url: null,
          status: 'pending',
          status_detail: null,
          access_token_obtained: 0,
          merchant_access_token: null,
          merchant_organisation_id: null,
          merchant_creditor_name: null,
          merchant_app_url: null,
          partner_referral_id: null,
          created_at: '2026-04-15',
          completed_at: null,
          updated_at: null,
        },
      ],
    });
    const result = await getAllMerchantSignups(db, { status: 'completed' });
    expect(result.merchants).toHaveLength(1);
    expect(result.merchants[0]?.id).toBe(1);
  });
});

describe('partnerAdminAuth', () => {
  it('first_time=true when no password set', async () => {
    const db = makeAppDb({ settings: {}, signups: [] });
    const result = await partnerAdminAuth(db, 'anything');
    expect(result.success).toBe(true);
    expect(result.first_time).toBe(true);
  });

  it('rejects wrong password', async () => {
    const db = makeAppDb({
      settings: { partner_admin_password: 'correct' },
      signups: [],
    });
    const result = await partnerAdminAuth(db, 'wrong');
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/Incorrect/);
  });

  it('accepts correct password', async () => {
    const db = makeAppDb({
      settings: { partner_admin_password: 'sekret' },
      signups: [],
    });
    const result = await partnerAdminAuth(db, 'sekret');
    expect(result.success).toBe(true);
    expect(result.first_time).toBeUndefined();
  });
});

describe('updateMerchantAppUrl', () => {
  it('rejects missing signupId', async () => {
    const db = makeAppDb({ settings: {}, signups: [] });
    const result = await updateMerchantAppUrl(db, { signupId: 0, appUrl: 'x' });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/No signup ID/);
  });

  it('strips trailing slash from app URL', async () => {
    const state: MockState = {
      settings: {},
      signups: [
        {
          id: 1, company_name: null, company_email: null,
          billing_request_id: null, billing_request_flow_id: null,
          authorisation_url: null, status: 'pending', status_detail: null,
          access_token_obtained: 0, merchant_access_token: null,
          merchant_organisation_id: null, merchant_creditor_name: null,
          merchant_app_url: null, partner_referral_id: null,
          created_at: '2026-04-15', completed_at: null, updated_at: null,
        },
      ],
    };
    const db = makeAppDb(state);
    const result = await updateMerchantAppUrl(db, {
      signupId: 1,
      appUrl: 'https://x.com/app/',
    });
    expect(result.success).toBe(true);
    expect(state.signups[0]?.merchant_app_url).toBe('https://x.com/app');
  });

  it('returns "Signup record not found" when no row updated', async () => {
    const db = makeAppDb({ settings: {}, signups: [] });
    const result = await updateMerchantAppUrl(db, {
      signupId: 999,
      appUrl: 'https://x.com',
    });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/not found/);
  });
});

describe('activateMerchant', () => {
  function makeSignup(over: Partial<SignupRow> = {}): SignupRow {
    return {
      id: 1, company_name: 'Acme', company_email: null,
      billing_request_id: null, billing_request_flow_id: null,
      authorisation_url: null, status: 'completed', status_detail: null,
      access_token_obtained: 1, merchant_access_token: 'TKN-123',
      merchant_organisation_id: null, merchant_creditor_name: 'Acme Ltd',
      merchant_app_url: 'https://merchant.example.com',
      partner_referral_id: null,
      created_at: '2026-04-10', completed_at: null, updated_at: null,
      ...over,
    };
  }

  it('rejects missing signupId', async () => {
    const db = makeAppDb({ settings: {}, signups: [] });
    const result = await activateMerchant(db, { signupId: 0 });
    expect(result.success).toBe(false);
  });

  it('returns "Signup record not found" when row missing', async () => {
    const db = makeAppDb({ settings: {}, signups: [] });
    const result = await activateMerchant(db, { signupId: 99 });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/not found/);
  });

  it('rejects when no merchant_access_token', async () => {
    const db = makeAppDb({
      settings: {},
      signups: [makeSignup({ merchant_access_token: null })],
    });
    const result = await activateMerchant(db, { signupId: 1 });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/No access token/);
  });

  it('rejects when no app URL configured', async () => {
    const db = makeAppDb({
      settings: {},
      signups: [makeSignup({ merchant_app_url: '' })],
    });
    const result = await activateMerchant(db, { signupId: 1 });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/No app URL/);
  });

  it('local URL: writes token to local settings', async () => {
    const state: MockState = {
      settings: {},
      signups: [makeSignup({ merchant_app_url: 'http://localhost:3000' })],
    };
    const db = makeAppDb(state);
    const result = await activateMerchant(db, { signupId: 1 });
    expect(result.success).toBe(true);
    expect((state.settings as any).api_access_token).toBe('TKN-123');
    expect(state.signups[0]?.status).toBe('activated');
  });

  it('remote URL: pushes token via fetch and marks activated', async () => {
    const state: MockState = {
      settings: {},
      signups: [
        makeSignup({ merchant_app_url: 'https://merchant.example.com' }),
      ],
    };
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fakeFetch = (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      return Promise.resolve({
        status: 200,
        ok: true,
        json: async () => ({ success: true }),
        text: async () => '',
      } as Response);
    };
    const db = makeAppDb(state);
    const result = await activateMerchant(
      db,
      { signupId: 1 },
      fakeFetch as any,
    );
    expect(result.success).toBe(true);
    expect(calls[0]?.url).toBe(
      'https://merchant.example.com/api/gocardless/deploy-token',
    );
    expect(calls[0]?.init?.method).toBe('PUT');
    const body = JSON.parse(String(calls[0]?.init?.body ?? '{}'));
    expect(body.access_token).toBe('TKN-123');
    expect(body.company_name).toBe('Acme Ltd');
    expect(state.signups[0]?.status).toBe('activated');
  });

  it('remote URL non-200 → returns error', async () => {
    const state: MockState = {
      settings: {},
      signups: [makeSignup({ merchant_app_url: 'https://x.com' })],
    };
    const fakeFetch = () =>
      Promise.resolve({
        status: 500,
        ok: false,
        json: async () => ({}),
        text: async () => 'broken',
      } as Response);
    const result = await activateMerchant(
      makeAppDb(state),
      { signupId: 1 },
      fakeFetch as any,
    );
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/Remote app returned 500/);
  });

  it('remote URL: success=false → returns error', async () => {
    const state: MockState = {
      settings: {},
      signups: [makeSignup({ merchant_app_url: 'https://x.com' })],
    };
    const fakeFetch = () =>
      Promise.resolve({
        status: 200,
        ok: true,
        json: async () => ({ success: false, error: 'duplicate token' }),
        text: async () => '',
      } as Response);
    const result = await activateMerchant(
      makeAppDb(state),
      { signupId: 1 },
      fakeFetch as any,
    );
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/duplicate token/);
  });

  it('rejects malformed app URL', async () => {
    const db = makeAppDb({
      settings: {},
      signups: [makeSignup({ merchant_app_url: 'not a url' })],
    });
    const result = await activateMerchant(db, { signupId: 1 });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/Invalid app URL/);
  });
});

describe('deployToken', () => {
  it('rejects missing token', async () => {
    const db = makeAppDb({ settings: {}, signups: [] });
    const result = await deployToken(db, { access_token: '' });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/No token/);
  });

  it('saves token to settings.api_access_token', async () => {
    const state: MockState = { settings: {}, signups: [] };
    const result = await deployToken(makeAppDb(state), {
      access_token: 'NEW-TOKEN',
      company_name: 'Acme Ltd',
    });
    expect(result.success).toBe(true);
    expect(result.message).toMatch(/Acme Ltd/);
    expect((state.settings as any).api_access_token).toBe('NEW-TOKEN');
  });
});

describe('setPartnerAdminPassword', () => {
  it('rejects passwords shorter than 4 characters', async () => {
    const db = makeAppDb({ settings: {}, signups: [] });
    const result = await setPartnerAdminPassword(db, 'abc');
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/at least 4/);
  });

  it('rejects empty password', async () => {
    const db = makeAppDb({ settings: {}, signups: [] });
    const result = await setPartnerAdminPassword(db, '   ');
    expect(result.success).toBe(false);
  });

  it('saves valid password', async () => {
    const state: MockState = { settings: {}, signups: [] };
    const db = makeAppDb(state);
    const result = await setPartnerAdminPassword(db, 'newpassword');
    expect(result.success).toBe(true);
    expect((state.settings as any).partner_admin_password).toBe('newpassword');
  });
});
