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
export declare function getBatchTypes(operaDb: Knex): Promise<BatchTypesResponse>;
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
export declare function getNominalAccounts(operaDb: Knex): Promise<NominalAccountsResponse>;
export interface PaymentType {
    code: string;
    description: string;
}
export interface PaymentTypesResponse {
    success: boolean;
    types: PaymentType[];
    error?: string;
}
export declare function getPaymentTypes(operaDb: Knex): Promise<PaymentTypesResponse>;
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
export declare function getVatCodes(operaDb: Knex, asOfDate?: string | null): Promise<VatCodesResponse>;
export interface BankAccount {
    code: string;
    description: string;
}
export interface BankAccountsResponse {
    success: boolean;
    accounts: BankAccount[];
    error?: string;
}
export declare function getBankAccounts(operaDb: Knex): Promise<BankAccountsResponse>;
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
export declare function getImportConfig(operaDb: Knex, asOfDate?: string | null): Promise<ImportConfigResponse>;
export interface SetupStatusResponse {
    success: boolean;
    configured: boolean;
    pending_signup: Record<string, unknown> | null;
}
export declare function getSetupStatus(appDb: Knex | null): Promise<SetupStatusResponse>;
//# sourceMappingURL=lookups.d.ts.map