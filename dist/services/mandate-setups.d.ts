/**
 * Mandate setup-request operations.
 *
 * Faithful ports of:
 *   - list_pending_mandate_setups (apps/gocardless/api/routes.py:7054-7067)
 *   - cancel_mandate_setup        (routes.py:7220-7244)
 *
 * (The check-setups poll endpoint is a separate larger port — depends
 * on `client.get_billing_request` + `client.get_mandate` + auto-link
 * logic. This service is the read + cancel half.)
 *
 * Stored in `mandate_setup_requests` (per-app DB).
 */
import type { Knex } from 'knex';
export interface MandateSetup {
    id: number;
    opera_account: string;
    opera_name: string;
    customer_email: string;
    billing_request_id: string;
    billing_request_flow_id: string;
    authorisation_url: string;
    mandate_id: string;
    gocardless_customer_id: string;
    status: string;
    status_detail: string;
    email_sent_at: string | null;
    mandate_active_at: string | null;
    created_at: string;
    updated_at: string;
}
export interface ListMandateSetupsResponse {
    success: boolean;
    setups: MandateSetup[];
    pending_count: number;
    error?: string;
}
export declare function listMandateSetups(appDb: Knex): Promise<ListMandateSetupsResponse>;
export interface CreateMandateSetupInput {
    operaAccount: string;
    operaName?: string | null;
    customerEmail: string;
    emailSubject?: string | null;
    emailBodyHtml?: string | null;
    /** Falls back to 'Our Company' (matches Python). */
    companyName?: string | null;
}
export interface CreateMandateSetupResponse {
    success: boolean;
    message?: string;
    setup?: MandateSetup;
    email_sent?: boolean;
    email_error?: string | null;
    authorisation_url?: string;
    error?: string;
}
export interface CreateMandateSetupRemote {
    /**
     * Create a billing request + return its id (and a customer link if any).
     */
    createBillingRequest: (opts: {
        customerEmail: string;
        customerName: string | null;
        metadata: Record<string, string>;
    }) => Promise<{
        success: boolean;
        id?: string;
        error?: string;
    }>;
    /**
     * Create a flow → returns the hosted authorisation URL + flow id.
     */
    createBillingRequestFlow: (billingRequestId: string) => Promise<{
        success: boolean;
        flowId?: string;
        authorisationUrl?: string;
        error?: string;
    }>;
}
export interface CreateMandateSetupEmailSender {
    (opts: {
        to: string;
        subject: string;
        bodyHtml: string;
    }): Promise<{
        success: boolean;
        error?: string | null;
    }>;
}
/**
 * Faithful port of create_mandate_setup
 * (apps/gocardless/api/routes.py:6852-7051). Pipeline:
 *   1. Validate inputs (account, email).
 *   2. Create billing request via remote callback.
 *   3. Create billing-request-flow → authorisation URL.
 *   4. Insert a tracking row (status='pending').
 *   5. Best-effort email dispatch via injected sender. On success
 *      mark status='email_sent' + email_sent_at; on failure leave
 *      status='pending' with status_detail.
 */
export declare function createMandateSetup(appDb: Knex, input: CreateMandateSetupInput, remote: CreateMandateSetupRemote, sendEmail?: CreateMandateSetupEmailSender): Promise<CreateMandateSetupResponse>;
export interface CheckSetupsRemote {
    /** GET /billing_requests/:id */
    getBillingRequest: (id: string) => Promise<{
        success: boolean;
        /** Billing request status: 'fulfilled' | 'pending' | 'action_required' | 'cancelled' | ... */
        status?: string;
        /** mandate_request_mandate or mandate */
        mandateId?: string | null;
        customerId?: string | null;
        error?: string;
    }>;
    /** GET /mandates/:id */
    getMandate: (id: string) => Promise<{
        success: boolean;
        /** Mandate status: 'active' | 'pending_*' | 'submitted' | 'cancelled' | 'expired' | 'failed' | ... */
        status?: string;
        error?: string;
    }>;
}
export interface CheckSetupsLinkResult {
    success: boolean;
    error?: string;
}
/**
 * Called when a mandate setup completes. Links the mandate to its
 * Opera customer in `gocardless_mandates` and sets `sn_analsys='GC'`
 * on the Opera customer. The router supplies this via the existing
 * `linkMandate` service + a ROWLOCK Opera write.
 */
export type CompleteMandateSetupFn = (input: {
    setup: MandateSetup;
    mandateId: string;
    gocardlessCustomerId: string | null;
}) => Promise<CheckSetupsLinkResult>;
export interface CheckSetupsUpdate {
    setup_id: number;
    opera_account: string;
    opera_name: string;
    old_status: string;
    new_status?: string;
    mandate_id?: string | null;
    error?: string;
}
export interface CheckSetupsResponse {
    success: boolean;
    message?: string;
    updates: CheckSetupsUpdate[];
    error?: string;
}
/**
 * Faithful port of check_mandate_setups
 * (apps/gocardless/api/routes.py:7070-7186).
 *
 * For each pending mandate setup row:
 *   1. Fetch the billing_request status via the remote callback
 *   2. Map brq.status + mandate.status to a local status:
 *        brq=fulfilled  + mandate=active                 → completed
 *        brq=fulfilled  + mandate=pending_*              → mandate_created
 *        brq=fulfilled  + mandate=cancelled/expired/failed → failed
 *        brq=pending|action_required + setup=email_sent → authorisation_pending
 *        brq=cancelled                                   → cancelled
 *   3. Persist any non-null update_fields to the local row
 *   4. If the new status is 'completed' AND we have a mandate_id,
 *      call completeSetup which links the mandate + sets
 *      sn_analsys='GC' on the Opera customer
 *
 * Per-row failures are reported in updates[] but never abort the run.
 */
export declare function checkPendingMandateSetups(appDb: Knex, remote: CheckSetupsRemote, completeSetup?: CompleteMandateSetupFn): Promise<CheckSetupsResponse>;
export interface CancelSetupResponse {
    success: boolean;
    message?: string;
    error?: string;
}
export declare function cancelMandateSetup(appDb: Knex, setupId: number): Promise<CancelSetupResponse>;
//# sourceMappingURL=mandate-setups.d.ts.map