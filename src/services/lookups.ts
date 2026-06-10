/**
 * Read-only lookup services for the GoCardless plugin.
 *
 * Faithful ports of the simple list endpoints in
 * `apps/gocardless/api/routes.py`:
 *   - get_gocardless_batch_types
 *   - get_nominal_accounts
 *   - get_vat_codes
 *   - get_nominal_payment_types
 *   - get_gocardless_setup_status
 */
import type { Knex } from 'knex';
import { fetchVatCodesWithRates } from '../_shared/index.js';
import { loadSettings, type GoCardlessSettings } from './settings.js';
import { companyScope } from '../_shared/get-company.js';

// =====================================================================
// Batch types — atype where ay_type='R' AND ay_batched=1
// =====================================================================

export interface BatchType {
  code: string;
  description: string;
  is_gocardless: boolean;
}

export interface BatchTypesResponse {
  success: boolean;
  batch_types: BatchType[];
  warning?: string;
  recommended?: BatchType | null;
  error?: string;
}

export async function getBatchTypes(operaDb: Knex): Promise<BatchTypesResponse> {
  try {
    const rows = (await operaDb.raw(`
      SELECT ay_cbtype, ay_desc, ay_batched
      FROM atype
      WHERE ay_type = 'R' AND ay_batched = 1
      ORDER BY ay_desc
    `)) as unknown as Array<{
      ay_cbtype: string | null;
      ay_desc: string | null;
      ay_batched: number | null;
    }>;

    if (!Array.isArray(rows) || rows.length === 0) {
      return {
        success: true,
        batch_types: [],
        warning:
          'No batched receipt types found. You may need to create a GoCardless type in Opera.',
      };
    }

    const types: BatchType[] = rows.map((row) => {
      const desc = row.ay_desc ? String(row.ay_desc).trim() : '';
      return {
        code: row.ay_cbtype ? String(row.ay_cbtype).trim() : '',
        description: desc,
        is_gocardless: desc.toLowerCase().includes('gocardless'),
      };
    });

    const recommended = types.find((t) => t.is_gocardless) ?? types[0] ?? null;

    return { success: true, batch_types: types, recommended };
  } catch (err: any) {
    return { success: false, batch_types: [], error: err?.message ?? String(err) };
  }
}

// =====================================================================
// Nominal accounts — nacnt excluding Z-prefixed system accounts
// =====================================================================

export interface NominalAccount {
  code: string;
  description: string;
  allow_project: number;
  allow_department: number;
  default_project: string;
  default_department: string;
}

export interface NominalAccountsResponse {
  success: boolean;
  accounts: NominalAccount[];
  error?: string;
}

export async function getNominalAccounts(operaDb: Knex): Promise<NominalAccountsResponse> {
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
    `)) as unknown as Array<{
      na_acnt: string | null;
      na_desc: string | null;
      na_allwprj: number | null;
      na_allwjob: number | null;
      na_project: string | null;
      na_job: string | null;
    }>;

    if (!Array.isArray(rows) || rows.length === 0) {
      return { success: true, accounts: [] };
    }

    const accounts: NominalAccount[] = rows.map((row) => ({
      code: row.na_acnt ? String(row.na_acnt).trim() : '',
      description: row.na_desc ? String(row.na_desc).trim() : '',
      allow_project: Number(row.na_allwprj ?? 0),
      allow_department: Number(row.na_allwjob ?? 0),
      default_project: (row.na_project ?? '').trim(),
      default_department: (row.na_job ?? '').trim(),
    }));

    return { success: true, accounts };
  } catch (err: any) {
    return { success: false, accounts: [], error: err?.message ?? String(err) };
  }
}

// =====================================================================
// Payment types — atype where ay_type='P' (excluding batched)
// =====================================================================

export interface PaymentType {
  code: string;
  description: string;
}

export interface PaymentTypesResponse {
  success: boolean;
  types: PaymentType[];
  error?: string;
}

export async function getPaymentTypes(operaDb: Knex): Promise<PaymentTypesResponse> {
  try {
    const rows = (await operaDb.raw(`
      SELECT ay_cbtype, ay_desc
      FROM atype WITH (NOLOCK)
      WHERE ay_type = 'P' AND (ay_batched = 0 OR ay_batched IS NULL)
      ORDER BY ay_cbtype
    `)) as unknown as Array<{ ay_cbtype: string | null; ay_desc: string | null }>;

    if (!Array.isArray(rows) || rows.length === 0) {
      return { success: true, types: [] };
    }

    const types: PaymentType[] = rows.map((row) => ({
      code: row.ay_cbtype ? String(row.ay_cbtype).trim() : '',
      description: row.ay_desc ? String(row.ay_desc).trim() : '',
    }));

    return { success: true, types };
  } catch (err: any) {
    return { success: false, types: [], error: err?.message ?? String(err) };
  }
}

// =====================================================================
// VAT codes — ztax 'P' (purchases) for the fees split
// =====================================================================

export interface GcVatCode {
  code: string;
  description: string;
  rate: number;
  type: string;
  nominal_account: string;
}

export interface VatCodesResponse {
  success: boolean;
  /** Legacy shape — `codes` is the canonical key (matches
   *  apps/gocardless/api/routes.py:1875 exactly). Frontend reads this. */
  codes: GcVatCode[];
  /** ISO date the rates were evaluated against. */
  as_of_date: string;
  error?: string;
}

export async function getVatCodes(
  operaDb: Knex,
  asOfDate: string | null = null,
): Promise<VatCodesResponse> {
  try {
    let refDate: Date;
    if (asOfDate) {
      const parsed = new Date(asOfDate);
      refDate = Number.isNaN(parsed.getTime()) ? new Date() : parsed;
    } else {
      refDate = new Date();
    }

    const result = await fetchVatCodesWithRates(operaDb, refDate);
    const codes: GcVatCode[] = result.vatCodes.map((c) => ({
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
  } catch (err: any) {
    return {
      success: false,
      codes: [],
      as_of_date: new Date().toISOString().slice(0, 10),
      error: err?.message ?? String(err),
    };
  }
}

// =====================================================================
// Bank accounts — nbank list
// =====================================================================

export interface BankAccount {
  code: string;
  description: string;
}

export interface BankAccountsResponse {
  success: boolean;
  accounts: BankAccount[];
  error?: string;
}

export async function getBankAccounts(operaDb: Knex): Promise<BankAccountsResponse> {
  try {
    const rows = (await operaDb.raw(`
      SELECT nk_acnt, nk_desc
      FROM nbank WITH (NOLOCK)
      ORDER BY nk_acnt
    `)) as unknown as Array<{ nk_acnt: string | null; nk_desc: string | null }>;

    if (!Array.isArray(rows) || rows.length === 0) {
      return { success: true, accounts: [] };
    }
    const accounts: BankAccount[] = rows.map((row) => ({
      code: row.nk_acnt ? String(row.nk_acnt).trim() : '',
      description: row.nk_desc ? String(row.nk_desc).trim() : '',
    }));
    return { success: true, accounts };
  } catch (err: any) {
    return { success: false, accounts: [], error: err?.message ?? String(err) };
  }
}

// =====================================================================
// Consolidated import-config — batch types + nominal accounts + VAT codes
// =====================================================================

export interface ImportConfigResponse {
  success: boolean;
  batch_types: BatchType[];
  batch_types_recommended: BatchType | null;
  nominal_accounts: NominalAccount[];
  vat_codes: GcVatCode[];
  vat_as_of_date: string;
  error?: string;
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
export async function getImportConfig(
  operaDb: Knex,
  asOfDate: string | null = null,
): Promise<ImportConfigResponse> {
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
  } catch (err: any) {
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

// =====================================================================
// Setup status — has GoCardless been configured?
// =====================================================================

export interface SetupStatusResponse {
  success: boolean;
  configured: boolean;
  pending_signup: Record<string, unknown> | null;
}

export async function getSetupStatus(
  appDb: Knex | null,
  companyCode: string,
): Promise<SetupStatusResponse> {
  let settings: GoCardlessSettings | null = null;
  if (appDb) {
    try {
      settings = await loadSettings(appDb, companyCode);
    } catch {
      // No settings = not configured
    }
  }

  const apiToken = settings?.api_access_token ?? '';
  const configured = Boolean(apiToken && apiToken.length > 10);

  let pendingSignup: Record<string, unknown> | null = null;
  if (!configured && appDb) {
    try {
      const rows = (await appDb('gocardless_partner_signups')
        .where({ ...companyScope(companyCode) })
        .orderBy('created_at', 'desc')
        .first()) as unknown as Record<string, unknown> | undefined;
      if (rows && rows.status !== 'completed' && rows.status !== 'failed') {
        pendingSignup = rows;
      }
    } catch {
      // Table may not exist yet
    }
  }

  return {
    success: true,
    configured,
    pending_signup: pendingSignup,
  };
}
