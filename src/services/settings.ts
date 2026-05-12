/**
 * GoCardless settings service.
 *
 * Faithful port of `_load_gocardless_settings` and `_save_gocardless_settings`
 * from `apps/gocardless/api/routes.py`.
 *
 * Storage change (intentional, not a behavioural amendment): in Python
 * the settings live in a per-company JSON file
 * (`data/{company}/gocardless/gocardless_settings.json`); under SAM the
 * plugin owns its own per-tenant database (`ai_sam_app_gocardless`),
 * so we promote settings to a single-row key/value table. The dict
 * structure and field semantics are unchanged.
 */
import type { Knex } from 'knex';

export interface GoCardlessSettings {
  default_batch_type: string;
  default_bank_code: string;
  fees_nominal_account: string;
  fees_vat_code: string;
  fees_payment_type: string;
  company_reference: string;
  exclude_description_patterns: string[];
  auto_allocate: boolean;
  gocardless_bank_code: string;
  gocardless_transfer_cbtype: string;
  subscription_tag: string;
  subscription_frequencies: string[];
  archive_folder?: string;
  api_sandbox?: boolean;
  data_source?: string;
  api_access_token?: string;
  partner_client_id?: string;
  partner_client_secret?: string;
  partner_redirect_uri?: string;
  partner_admin_password?: string;
  request_statement_reference?: string;
  payout_lookback_days?: number;
}

const DEFAULTS: GoCardlessSettings = {
  default_batch_type: '',
  default_bank_code: '',
  fees_nominal_account: '',
  fees_vat_code: '1',
  fees_payment_type: '',
  company_reference: '',
  exclude_description_patterns: [],
  auto_allocate: false,
  gocardless_bank_code: process.env.GOCARDLESS_BANK_CODE ?? '',
  gocardless_transfer_cbtype: '',
  subscription_tag: 'SUB',
  subscription_frequencies: ['W', 'M', 'A'],
};

const SETTINGS_KEY = 'gocardless_settings';

/**
 * Load the GoCardless settings dict. If no row exists yet, return defaults.
 */
export async function loadSettings(db: Knex): Promise<GoCardlessSettings> {
  const row = await db('settings').where({ key: SETTINGS_KEY }).first();
  if (!row?.value) return { ...DEFAULTS };
  try {
    const parsed = JSON.parse(row.value) as Partial<GoCardlessSettings>;
    return { ...DEFAULTS, ...parsed };
  } catch {
    return { ...DEFAULTS };
  }
}

/**
 * Save (replace) the GoCardless settings dict.
 *
 * The Python `_save_gocardless_settings` writes the full dict to disk —
 * we mirror that with an upsert. Callers that need merge semantics
 * (the POST endpoint) load → merge → save.
 */
export async function saveSettings(
  db: Knex,
  settings: GoCardlessSettings,
): Promise<boolean> {
  const value = JSON.stringify(settings);
  const existing = await db('settings').where({ key: SETTINGS_KEY }).first();
  try {
    if (existing) {
      await db('settings')
        .where({ key: SETTINGS_KEY })
        .update({ value, updated_at: db.fn.now() });
    } else {
      await db('settings').insert({ key: SETTINGS_KEY, value });
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Mask the sensitive fields in a settings dict for the GET response.
 *
 * Faithful port of the masking logic at lines 1531-1546 of
 * `apps/gocardless/api/routes.py`:
 *   - api_access_token → removed; api_key_configured + api_key_hint added
 *   - partner_client_secret → "••••••••" if set
 */
export function maskSettingsForResponse(
  settings: GoCardlessSettings,
): Record<string, unknown> {
  const result: Record<string, unknown> = { ...settings };

  const apiToken = settings.api_access_token ?? '';
  result.api_key_configured = Boolean(apiToken && apiToken.length > 10);
  if (apiToken) {
    result.api_key_hint =
      apiToken.length > 4 ? `...${apiToken.slice(-4)}` : '****';
  } else {
    result.api_key_hint = '';
  }
  delete result.api_access_token;

  if (settings.partner_client_secret) {
    result.partner_client_secret = '••••••••';
  }

  return result;
}

/**
 * Apply a partial settings update with merge semantics.
 *
 * Faithful port of the merge logic in
 * `apps/gocardless/api/routes.py:save_gocardless_settings`:
 *   - Only specified keys overwrite
 *   - api_access_token: only updated if a non-empty value is given
 *   - partner_client_secret: only updated if non-empty AND not the masked
 *     placeholder '••••••••'
 */
export function mergeSettingsUpdate(
  existing: GoCardlessSettings,
  body: Record<string, unknown>,
): GoCardlessSettings {
  const merged: GoCardlessSettings = { ...existing };

  const mergeableKeys: Array<keyof GoCardlessSettings> = [
    'default_batch_type',
    'default_bank_code',
    'fees_nominal_account',
    'fees_vat_code',
    'fees_payment_type',
    'company_reference',
    'archive_folder',
    'api_sandbox',
    'data_source',
    'exclude_description_patterns',
    'gocardless_bank_code',
    'gocardless_transfer_cbtype',
    'subscription_tag',
    'subscription_frequencies',
    'partner_client_id',
    'partner_redirect_uri',
    'request_statement_reference',
    'payout_lookback_days',
  ];

  for (const key of mergeableKeys) {
    if (key in body && body[key] !== null && body[key] !== undefined) {
      // Type assertion — runtime-safe because we filter null/undefined above
      (merged as any)[key] = body[key];
    }
  }

  // API token: only update if a non-empty value is provided
  const apiAccessToken = body.api_access_token;
  if (apiAccessToken && String(apiAccessToken).trim()) {
    merged.api_access_token = String(apiAccessToken).trim();
  }

  // Partner client secret: only update if non-empty and not the masked placeholder
  const partnerSecret = body.partner_client_secret;
  if (
    partnerSecret &&
    String(partnerSecret).trim() &&
    partnerSecret !== '••••••••'
  ) {
    merged.partner_client_secret = String(partnerSecret).trim();
  }

  return merged;
}
