/**
 * GoCardless mandate-match suggestion.
 *
 * Faithful port of suggest_mandate_match
 * (apps/gocardless/api/routes.py:7644-7718). Returns up to 5
 * candidate Opera customers ranked by similarity to a GoCardless
 * customer name.
 *
 * Scoring tiers (matches Python exactly):
 *   1. Exact match after normalisation              → 1.0
 *   2. Containment (one normalised name contains
 *      the other)                                   → 0.85
 *   3. Fuzzy ratio via Ratcliff/Obershelp algorithm → 0..1
 *
 * Threshold: candidates below 0.5 are dropped. Final list sorted
 * by score desc, with GC-tagged customers (sn_analsys='GC') tied
 * at the top, then name asc.
 *
 * Normalisation: uppercase, trim, strip common company suffixes
 * ` LTD`, ` LIMITED`, ` PLC`, ` INC`, ` LLC`, ` CO`, ` COMPANY`,
 * `.` (single trailing dot). Note this is a SUPERSET of the
 * normalisation used in `mandates.ts:normaliseCompanyName` —
 * Python's suggest_mandate_match also strips a trailing period.
 */
import type { Knex } from 'knex';
import { sequenceMatcherRatio as sharedSequenceMatcherRatio } from '../_shared/index.js';
export interface MatchSuggestion {
    account: string;
    name: string;
    score: number;
    is_gc: boolean;
}
export interface SuggestMandateMatchResponse {
    success: boolean;
    suggestions: MatchSuggestion[];
    gc_name: string;
    error?: string;
}
export declare function normaliseSuggestName(name: string | null | undefined): string;
export declare const sequenceMatcherRatio: typeof sharedSequenceMatcherRatio;
export declare function suggestMandateMatch(operaDb: Knex, gcName: string): Promise<SuggestMandateMatchResponse>;
//# sourceMappingURL=suggest-match.d.ts.map