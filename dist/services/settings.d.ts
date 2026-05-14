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
    /** BACS reference template — what appears on the customer's bank
     *  statement (max 10 chars). Supports merge fields:
     *    {company}  → request_statement_reference (default)
     *    {inv}      → invoice ref (e.g. INV26492)
     *    {inv_num}  → invoice number digits only (e.g. 26492)
     *    {customer} → Opera customer account (e.g. R019)
     *  Plus length suffixes: {company4}, {inv_num5}, etc. take the
     *  first N chars/digits. Faithful port of legacy 23b9542 + 4bd437a.
     */
    bacs_reference_template?: string;
    payout_lookback_days?: number;
}
/**
 * Load the GoCardless settings dict. If no row exists yet, return defaults.
 */
export declare function loadSettings(db: Knex): Promise<GoCardlessSettings>;
/**
 * Save (replace) the GoCardless settings dict.
 *
 * The Python `_save_gocardless_settings` writes the full dict to disk —
 * we mirror that with an upsert. Callers that need merge semantics
 * (the POST endpoint) load → merge → save.
 */
export declare function saveSettings(db: Knex, settings: GoCardlessSettings): Promise<boolean>;
/**
 * Mask the sensitive fields in a settings dict for the GET response.
 *
 * Faithful port of the masking logic at lines 1531-1546 of
 * `apps/gocardless/api/routes.py`:
 *   - api_access_token → removed; api_key_configured + api_key_hint added
 *   - partner_client_secret → "••••••••" if set
 */
export declare function maskSettingsForResponse(settings: GoCardlessSettings): Record<string, unknown>;
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
export declare function mergeSettingsUpdate(existing: GoCardlessSettings, body: Record<string, unknown>): GoCardlessSettings;
//# sourceMappingURL=settings.d.ts.map