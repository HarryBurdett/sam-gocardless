/**
 * GoCardless mandate listing.
 *
 * Faithful port of:
 *   - list_gocardless_mandates       (apps/gocardless/api/routes.py:6404-6425)
 *   - list_unlinked_gocardless_mandates (routes.py:6428-6447)
 *
 * Reads the per-app DB's `gocardless_mandates` table.
 * `opera_account = '__UNLINKED__'` is the sentinel for mandates synced
 * from the GoCardless API but not yet linked to an Opera customer —
 * they appear in /unlinked endpoint for manual linking.
 *
 * The main /mandates list filters out __UNLINKED__ entries when there's
 * a linked version of the same mandate_id (deduplication for the case
 * where a sync creates an unlinked row and a later operator action
 * links it without removing the placeholder).
 */
import type { Knex } from 'knex';
export interface Mandate {
    id: number;
    mandate_id: string;
    opera_account: string;
    opera_name: string;
    gocardless_name: string;
    gocardless_customer_id: string;
    mandate_status: string;
    scheme: string;
    email: string;
    created_at: string;
    updated_at: string;
}
export interface ListMandatesOptions {
    status?: string | null;
    operaAccount?: string | null;
}
export interface ListMandatesResponse {
    success: boolean;
    mandates: Mandate[];
    count: number;
    error?: string;
}
export declare function listMandates(appDb: Knex, opts?: ListMandatesOptions): Promise<ListMandatesResponse>;
export interface LinkMandateInput {
    operaAccount: string;
    mandateId: string;
    operaName?: string | null;
    gocardlessName?: string | null;
    gocardlessCustomerId?: string | null;
    mandateStatus?: string;
    scheme?: string;
    email?: string | null;
}
export interface LinkMandateResult {
    success: boolean;
    /** Set when re-linking — caller should also clear sn_analsys on this account. */
    oldOperaAccount?: string | null;
    /** GC's stored opera_name when this mandate was previously linked. */
    gcMandateName?: string | null;
    /** True when caller didn't pass `confirm=true` and a re-link was detected. */
    needsConfirm?: boolean;
    /** Local DB row after the upsert. */
    mandate?: Mandate;
    message?: string;
    error?: string;
}
/**
 * Upsert a (opera_account, mandate_id) link in `gocardless_mandates`.
 * Faithful port of payments_db.link_mandate
 * (sql_rag/gocardless_payments.py:415-482) plus the route-side
 * relink confirmation guard from
 * apps/gocardless/api/routes.py:6657-6792.
 *
 * Behaviour:
 *   - When the same mandate is currently linked to a *different*
 *     non-__UNLINKED__ account, requires `confirm=true` to proceed.
 *   - On confirmed relink, removes the old row first, then upserts.
 *   - Always removes any __UNLINKED__ placeholder for this mandate.
 *   - Updates an existing (account, mandate) row if one exists; else
 *     inserts. COALESCE-style: optional fields preserved when not
 *     supplied.
 */
export declare function linkMandate(appDb: Knex, input: LinkMandateInput & {
    confirm?: boolean;
}): Promise<LinkMandateResult>;
export interface RemoteMandate {
    id?: string;
    status?: string;
    scheme?: string;
    links?: {
        customer?: string;
    };
    [k: string]: unknown;
}
export interface RemoteCustomerLite {
    company_name?: string;
    given_name?: string;
    family_name?: string;
    email?: string;
}
export interface OperaGcCustomer {
    account: string;
    name: string;
    email?: string | null;
}
export interface SyncMandatesPage {
    mandates: RemoteMandate[];
    after: string | null;
}
export interface SyncMandatesResponse {
    success: boolean;
    message?: string;
    synced_count?: number;
    new_count?: number;
    updated_count?: number;
    auto_linked_count?: number;
    error?: string;
}
export declare function normaliseCompanyName(name: string | null | undefined): string;
export declare function findOperaCustomerMatch(gcName: string | null | undefined, customers: OperaGcCustomer[]): OperaGcCustomer | null;
/**
 * Faithful port of sync_gocardless_mandates
 * (apps/gocardless/api/routes.py:6450-6654). For each remote mandate:
 *   - Fetch the GC customer (when there's a linked customer_id)
 *   - If we already have a row for this mandate_id:
 *       * linked → update status/scheme/email
 *       * unlinked (__UNLINKED__) → try auto-match; if matched, link;
 *         else update placeholder
 *   - Else (new):
 *       * Try auto-match; if matched, link; else insert __UNLINKED__
 *         placeholder.
 *
 * Cleanup pass at the end: drops any __UNLINKED__ row when a linked
 * row exists for the same mandate_id.
 */
export declare function syncMandatesFromGocardless(appDb: Knex, fetchPage: (cursor: string | null) => Promise<SyncMandatesPage>, fetchCustomer: (customerId: string) => Promise<RemoteCustomerLite | null>, operaCustomers: OperaGcCustomer[]): Promise<SyncMandatesResponse>;
export interface CancelMandateResponse {
    success: boolean;
    message?: string;
    status?: string;
    error?: string;
}
export declare function cancelMandate(appDb: Knex, mandateId: string, cancelRemote?: (id: string) => Promise<{
    success: boolean;
    status?: string;
    error?: string;
    alreadyCancelled?: boolean;
}>): Promise<CancelMandateResponse>;
export interface UnlinkMandateResponse {
    success: boolean;
    message?: string;
    error?: string;
}
export declare function unlinkMandate(appDb: Knex, mandateId: string): Promise<UnlinkMandateResponse>;
export declare function listUnlinkedMandates(appDb: Knex): Promise<ListMandatesResponse>;
//# sourceMappingURL=mandates.d.ts.map