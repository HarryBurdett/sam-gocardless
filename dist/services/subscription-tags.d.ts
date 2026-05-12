/**
 * Subscription tag updates for Opera repeat documents (`ihead`).
 *
 * Faithful port of `update_subscription_tags` in
 * `apps/gocardless/api/routes.py:1602-1741`. Two modes:
 *   - preview: count + per-doc status, no writes
 *   - apply:   UPDATE ihead.ih_analsys with ROWLOCK
 *
 * Filter:
 *   - ih_docstat = 'U'                            (active repeat docs)
 *   - ih_econtr IS NULL OR ih_econtr >= GETDATE() (not expired)
 *   - RTRIM(ih_ignore) IN (configured frequencies)
 *
 * Apply rules:
 *   - overwrite=false: only blank/null ih_analsys is updated
 *   - overwrite=true:  also overwrites docs whose ih_analsys differs
 *                      from the tag
 */
import type { Knex } from 'knex';
export type SubscriptionTagMode = 'preview' | 'apply';
export interface SubscriptionTagsRequest {
    mode?: SubscriptionTagMode;
    overwrite?: boolean;
}
export interface SubscriptionTagDocument {
    doc_ref: string;
    account: string;
    name: string;
    frequency: string;
    frequency_code: string;
    current_analsys: string;
    status: 'already_tagged' | 'will_tag' | 'has_different';
}
export interface SubscriptionTagsPreviewResponse {
    success: boolean;
    tag?: string;
    total_matching?: number;
    already_tagged?: number;
    will_tag?: number;
    has_different?: number;
    documents?: SubscriptionTagDocument[];
    error?: string;
}
export interface SubscriptionTagsApplyResponse {
    success: boolean;
    updated?: number;
    tag?: string;
    overwrite?: boolean;
    error?: string;
}
export type SubscriptionTagsResponse = SubscriptionTagsPreviewResponse | SubscriptionTagsApplyResponse;
/**
 * Run the preview / apply flow.
 */
export declare function updateSubscriptionTags(operaDb: Knex, config: {
    subscription_tag: string;
    subscription_frequencies: string[];
}, req?: SubscriptionTagsRequest): Promise<SubscriptionTagsResponse>;
//# sourceMappingURL=subscription-tags.d.ts.map