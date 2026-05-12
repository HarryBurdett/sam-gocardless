/**
 * GoCardless repeat-document listing.
 *
 * Faithful port of get_gocardless_repeat_documents
 * (apps/gocardless/api/routes.py:8619-8785). Reads Opera ihead
 * (status 'U' = unposted/active repeat) joined to itran summary
 * for accurate amounts, then cross-references the per-app mandates
 * + subscriptions tables to attach link/mismatch info.
 *
 * Two filtering modes:
 *   - require_mandate=true (default): only return docs for customers
 *     who have an active GC mandate.
 *   - require_mandate=false: return every active repeat doc — used
 *     by the link-existing-subscription UI.
 *
 * Matching strategy for "suggest a subscription to link":
 *   1. Exact amount match against subs in the same opera_account
 *      whose `source_doc` row column is empty
 *   2. Within £1 (100p) tolerance against same set
 *   Picks the FIRST match (preserves Python's non-stable order).
 */
import type { Knex } from 'knex';
export interface RepeatDocumentMismatch {
    details: string[];
    sub_amount_pence: number;
    sub_amount_formatted: string;
    doc_amount_pence: number;
    doc_amount_formatted: string;
}
export interface MatchingSubscription {
    subscription_id: string;
    name: string;
    amount_formatted: string;
    status: string;
}
export interface RepeatDocument {
    doc_ref: string;
    opera_account: string;
    customer_name: string;
    frequency_code: string;
    frequency: string;
    interval_unit: string;
    interval_count: number;
    start_date: string | null;
    end_date: string | null;
    ex_vat: number;
    vat: number;
    total_inc_vat: number;
    amount_formatted: string;
    amount_pence: number;
    customer_ref: string;
    narration: string;
    is_sub_tagged: boolean;
    department: string;
    has_mandate: boolean;
    mandate_id: string | null;
    has_subscription: boolean;
    subscription_id: string | null;
    subscription_status: string | null;
    mismatch: RepeatDocumentMismatch | null;
    matching_subscription: MatchingSubscription | null;
}
export interface GetRepeatDocumentsOptions {
    /** Default true — match Python's `require_mandate: bool = Query(True)`. */
    requireMandate?: boolean;
    /** Subscription analysis-tag (default 'SUB' per Python). */
    subscriptionTag?: string;
}
export interface GetRepeatDocumentsResponse {
    success: boolean;
    documents: RepeatDocument[];
    count: number;
    with_mandate: number;
    with_subscription: number;
    with_match: number;
    error?: string;
}
export declare function getRepeatDocuments(operaDb: Knex, appDb: Knex, opts?: GetRepeatDocumentsOptions): Promise<GetRepeatDocumentsResponse>;
//# sourceMappingURL=repeat-documents.d.ts.map