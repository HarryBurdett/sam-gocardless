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
export declare function getEligibleCustomers(appDb: Knex, operaDb: Knex): Promise<EligibleCustomersResponse>;
//# sourceMappingURL=eligible-customers.d.ts.map