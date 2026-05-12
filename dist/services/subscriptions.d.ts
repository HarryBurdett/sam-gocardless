/**
 * GoCardless subscription read + lifecycle services.
 *
 * Faithful port of:
 *   - list_subscriptions / get_subscription
 *     (sql_rag/gocardless_payments.py:958-1075)
 *   - update_subscription_status
 *     (sql_rag/gocardless_payments.py:1077-1092)
 *   - add_subscription_document / remove_subscription_document /
 *     get_subscriptions_by_source_doc
 *     (sql_rag/gocardless_payments.py:1107-1174)
 *   - pause/resume/cancel/update routes
 *     (apps/gocardless/api/routes.py:9157-9372)
 *   - link / unlink routes
 *     (apps/gocardless/api/routes.py:8788-8874)
 *
 * Reads from the per-app DB's aligned `gocardless_subscriptions` and
 * `gocardless_subscription_documents` tables (migration 007).
 *
 * The pause/resume/cancel/update lifecycle wrappers take a `remote`
 * callback so callers can wire the GoCardless API client (or a stub
 * for tests). Mirrors the existing pattern used by `cancelMandate`.
 */
import type { Knex } from 'knex';
export interface OperaLinkedDocument {
    doc_ref: string;
    ex_vat: number;
    vat: number;
    total_inc_vat: number;
    amount_pence: number;
    amount_formatted: string;
    frequency_code: string;
    frequency: string;
    interval_unit: string;
    interval_count: number;
    has_sub_tag: boolean;
}
export interface Subscription {
    id: number;
    subscription_id: string;
    mandate_id: string;
    opera_account: string;
    opera_name: string;
    source_doc: string;
    source_docs: string[];
    amount_pence: number;
    amount_pounds: number;
    amount_formatted: string;
    currency: string;
    interval_unit: string;
    interval_count: number;
    frequency: string;
    day_of_month: number | null;
    name: string;
    status: string;
    start_date: string;
    end_date: string;
    created_at: string;
    updated_at: string;
    synced_at: string;
    /** Used by listSubscriptions for back-compat with the dashboard. */
    customer_name: string;
    linked_documents: OperaLinkedDocument[];
    linked_document_count: number;
    opera_amount_pence: number | null;
    opera_amount_formatted: string | null;
    opera_frequency: string | null;
    has_sub_tag: boolean | null;
    mismatch: {
        details: string[];
    } | null;
}
export interface ListSubscriptionsOptions {
    status?: string | null;
    operaAccount?: string | null;
    /** Mirrors Python's include_cancelled — defaults to false. */
    includeCancelled?: boolean;
    limit?: number;
}
export interface ListSubscriptionsResponse {
    success: boolean;
    subscriptions: Subscription[];
    count: number;
    /** Number of subscriptions where GC and Opera disagree. */
    with_mismatch?: number;
    error?: string;
}
export interface GetSubscriptionResponse {
    success: boolean;
    subscription?: Subscription;
    error?: string;
}
export interface SubscriptionLifecycleResponse {
    success: boolean;
    subscription?: Subscription;
    message?: string;
    error?: string;
}
export interface RemoteSubscriptionResult {
    success: boolean;
    subscription?: Record<string, unknown>;
    error?: string;
}
export declare function listSubscriptions(appDb: Knex, opts?: ListSubscriptionsOptions, operaDb?: Knex | null): Promise<ListSubscriptionsResponse>;
export declare function getSubscription(appDb: Knex, subscriptionId: string, operaDb?: Knex | null): Promise<GetSubscriptionResponse>;
export declare function updateSubscriptionStatus(appDb: Knex, subscriptionId: string, status: string): Promise<boolean>;
export declare function pauseSubscription(appDb: Knex, subscriptionId: string, remote: (id: string) => Promise<RemoteSubscriptionResult>): Promise<SubscriptionLifecycleResponse>;
export declare function resumeSubscription(appDb: Knex, subscriptionId: string, remote: (id: string) => Promise<RemoteSubscriptionResult>): Promise<SubscriptionLifecycleResponse>;
export declare function cancelSubscription(appDb: Knex, subscriptionId: string, remote: (id: string) => Promise<RemoteSubscriptionResult>): Promise<SubscriptionLifecycleResponse>;
export interface UpdateSubscriptionInput {
    name?: string | null;
    amountPence?: number | null;
}
/**
 * PUT /subscriptions/:id — push name/amount to GoCardless, then mirror
 * the result locally. Faithful port of update_gocardless_subscription
 * (apps/gocardless/api/routes.py:9248-9291).
 *
 * Local update only changes columns the caller actually sent (or the
 * status mirrored from the remote response). If the local row is
 * absent the remote call is still performed (matches Python's "no-op
 * silently when local missing" semantics).
 */
export declare function updateSubscriptionDetails(appDb: Knex, subscriptionId: string, input: UpdateSubscriptionInput, remote: (id: string, opts: UpdateSubscriptionInput) => Promise<RemoteSubscriptionResult>): Promise<SubscriptionLifecycleResponse>;
export interface CreateSubscriptionInput {
    sourceDocs: string[];
    dayOfMonth?: number | null;
    startDate?: string | null;
}
export interface CreateSubscriptionRemote {
    (opts: {
        mandateId: string;
        amountPence: number;
        intervalUnit: string;
        interval: number;
        dayOfMonth?: number | null;
        name: string;
        startDate?: string | null;
        metadata: Record<string, string>;
    }): Promise<{
        success: boolean;
        subscription?: Record<string, unknown>;
        error?: string;
    }>;
}
export interface OperaRepeatDocReader {
    /**
     * Returns every active repeat doc with the SUB tag matching one of
     * the supplied refs, plus the line totals (pence). Empty array if
     * no docs found.
     */
    fetchTaggedDocs: (sourceDocs: string[], subscriptionTag: string) => Promise<Array<{
        ih_doc: string;
        ih_account: string;
        ih_name: string;
        ih_ignore: string;
        ih_custref: string;
    }>>;
    /** Sum of it_exvat + it_vatval for all the supplied docs (pence). */
    sumLineTotals: (sourceDocs: string[]) => Promise<{
        lineNettPence: number;
        lineVatPence: number;
    }>;
}
export interface CreateSubscriptionResponse {
    success: boolean;
    subscription?: Subscription;
    gc_response?: Record<string, unknown>;
    error?: string;
}
export declare function createSubscription(appDb: Knex, input: CreateSubscriptionInput, operaReader: OperaRepeatDocReader, remote: CreateSubscriptionRemote, opts?: {
    subscriptionTag?: string;
}): Promise<CreateSubscriptionResponse>;
export interface RemoteSubscription {
    id?: string;
    amount?: number | string;
    interval_unit?: string;
    interval?: number | string;
    day_of_month?: number | string | null;
    name?: string | null;
    status?: string;
    start_date?: string | null;
    end_date?: string | null;
    links?: {
        mandate?: string;
    };
    [k: string]: unknown;
}
export interface SyncSubscriptionsResponse {
    success: boolean;
    message?: string;
    synced?: number;
    updated?: number;
    total?: number;
    error?: string;
}
interface SyncOptions {
    /**
     * Resolves a mandate_id to {opera_account, opera_name} using the
     * local mandates table + best-effort GoCardless API enrichment.
     * Allows the caller to inject API mandate/customer fetches without
     * coupling this module to the API client.
     */
    resolveAccount?: (mandateId: string) => Promise<{
        opera_account: string | null;
        opera_name: string | null;
    }>;
    pageSize?: number;
}
interface PageResult {
    subscriptions: RemoteSubscription[];
    after: string | null;
}
/**
 * Faithful port of sync_gocardless_subscriptions
 * (apps/gocardless/api/routes.py:9375-9500). Pulls every subscription
 * from GoCardless and upserts the local row, preserving any existing
 * source_doc / opera_name when GC didn't supply better.
 */
export declare function syncSubscriptionsFromGocardless(appDb: Knex, fetchPage: (cursor: string | null) => Promise<PageResult>, opts?: SyncOptions): Promise<SyncSubscriptionsResponse>;
export interface OperaDocAmount {
    /** Sum of `it_exvat` across the linked itran lines, in pence. */
    lineNettPence: number;
    /** Sum of `it_vatval` across the linked itran lines, in pence. */
    lineVatPence: number;
}
export interface SyncSubscriptionFromOperaResponse {
    success: boolean;
    message?: string;
    old_amount_pence?: number;
    new_amount_pence?: number;
    old_amount_formatted?: string;
    new_amount_formatted?: string;
    subscription?: Subscription;
    error?: string;
}
/**
 * Faithful port of sync_subscription_from_opera
 * (apps/gocardless/api/routes.py:9172-9245).
 *
 * The Opera read and the GoCardless update are injected so this
 * function stays unit-testable. The HTTP layer wires:
 *   readOperaDocAmount = sum(it_exvat) + sum(it_vatval) FROM itran
 *                        WHERE it_doc IN (...)
 *   updateRemote       = GoCardlessClient.updateSubscription(id, {amountPence})
 */
export declare function syncSubscriptionFromOpera(appDb: Knex, subscriptionId: string, readOperaDocAmount: (sourceDocs: string[]) => Promise<OperaDocAmount>, updateRemote: (id: string, amountPence: number) => Promise<RemoteSubscriptionResult>): Promise<SyncSubscriptionFromOperaResponse>;
export interface LinkSubscriptionInput {
    subscriptionId: string;
    sourceDoc: string;
}
export declare function linkSubscriptionToDocument(appDb: Knex, input: LinkSubscriptionInput): Promise<SubscriptionLifecycleResponse>;
export interface UnlinkSubscriptionInput {
    subscriptionId: string;
    sourceDoc?: string | null;
}
export declare function unlinkSubscriptionFromDocument(appDb: Knex, input: UnlinkSubscriptionInput): Promise<SubscriptionLifecycleResponse>;
export {};
//# sourceMappingURL=subscriptions.d.ts.map