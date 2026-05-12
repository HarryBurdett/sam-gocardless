/**
 * Eligible-customer listing for the GoCardless onboarding UI.
 *
 * Faithful port of `get_gocardless_eligible_customers`
 * (apps/gocardless/api/routes.py:7551-7635). Combines two populations:
 *   1. Opera customers with sn_analsys='GC' (operator-flagged eligible)
 *   2. Opera customers with a linked mandate in the per-app DB
 *
 * Each row reports has_mandate + mandate_id + mandate_status so the
 * UI can show "needs setup" vs "already mandated" status. Dedup by
 * sn_account so a customer appearing in both populations only shows
 * once.
 *
 * Per CLAUDE.md "dormant accounts excluded" — applies the same
 * sn_dormant=0 / sn_stop=0 filter the matcher uses.
 */
import type { Knex } from 'knex';

export interface EligibleCustomer {
  account: string;
  name: string;
  balance: number;
  email: string | null;
  has_mandate: boolean;
  mandate_id: string | null;
  mandate_status: string | null;
}

export interface EligibleCustomersResponse {
  success: boolean;
  customers: EligibleCustomer[];
  count: number;
  /** Number of customers already linked to a mandate. */
  with_mandate: number;
  /** Number of customers flagged for GC but without a mandate yet. */
  without_mandate: number;
  error?: string;
}

interface MandateLookup {
  opera_account: string;
  mandate_id: string;
  mandate_status: string;
}

export async function getEligibleCustomers(
  appDb: Knex,
  operaDb: Knex,
): Promise<EligibleCustomersResponse> {
  try {
    // 1. Build lookup of all linked mandates from per-app DB
    const mandateRows = (await appDb('gocardless_mandates')
      .where('opera_account', '!=', '__UNLINKED__')
      .select(
        'opera_account',
        'mandate_id',
        'mandate_status',
      )) as unknown as Array<{
      opera_account: string | null;
      mandate_id: string | null;
      mandate_status: string | null;
    }>;
    const mandateLookup = new Map<string, MandateLookup>();
    for (const m of mandateRows ?? []) {
      const acct = (m.opera_account ?? '').trim();
      if (!acct) continue;
      mandateLookup.set(acct, {
        opera_account: acct,
        mandate_id: (m.mandate_id ?? '').trim(),
        mandate_status: (m.mandate_status ?? '').trim(),
      });
    }
    const mandatedAccounts = Array.from(mandateLookup.keys());

    // 2. Build SQL — sn_analsys='GC' OR sn_account in (mandated)
    let sql: string;
    let params: string[];
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
    } else {
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

    const rows = (await operaDb.raw(sql, params)) as unknown as Array<{
      sn_account: string | null;
      sn_name: string | null;
      sn_analsys: string | null;
      sn_currbal: number | string | null;
      sn_email: string | null;
    }>;

    const seen = new Set<string>();
    const customers: EligibleCustomer[] = [];
    for (const r of rows ?? []) {
      const acct = (r.sn_account ?? '').trim();
      if (!acct || seen.has(acct)) continue;
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
    const withMandate = customers.reduce(
      (n, c) => n + (c.has_mandate ? 1 : 0),
      0,
    );
    const withoutMandate = customers.length - withMandate;
    return {
      success: true,
      customers,
      count: customers.length,
      with_mandate: withMandate,
      without_mandate: withoutMandate,
    };
  } catch (err: any) {
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
