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

const SUFFIXES = [
  ' LTD',
  ' LIMITED',
  ' PLC',
  ' INC',
  ' LLC',
  ' CO',
  ' COMPANY',
];

export function normaliseSuggestName(name: string | null | undefined): string {
  if (!name) return '';
  let n = name.toUpperCase().trim();
  for (const suffix of SUFFIXES) {
    if (n.endsWith(suffix)) {
      n = n.slice(0, n.length - suffix.length);
      break;
    }
  }
  // Python also strips a trailing single '.' character (its suffix
  // list contains '.' after the company-name suffixes).
  if (n.endsWith('.')) n = n.slice(0, -1);
  return n.trim();
}

// ---------------------------------------------------------------------
// Ratcliff/Obershelp ratio
// ---------------------------------------------------------------------
// Re-exported from @sqlrag/sam-shared so existing callers keep working.
// The shared implementation is a faithful port of Python's
// `difflib.SequenceMatcher.ratio`; see
// `apps-sam/shared/src/string/sequence-matcher.ts`.
export const sequenceMatcherRatio = sharedSequenceMatcherRatio;

// ---------------------------------------------------------------------
// Service entry point
// ---------------------------------------------------------------------

interface CustomerRow {
  account: string | null;
  name: string | null;
  analsys: string | null;
  balance: number | string | null;
}

export async function suggestMandateMatch(
  operaDb: Knex,
  gcName: string,
): Promise<SuggestMandateMatchResponse> {
  const trimmedName = (gcName ?? '').trim();
  try {
    const rows = (await operaDb('sname')
      .where({ sn_stop: 0 })
      .orderBy('sn_name', 'asc')
      .select(
        operaDb.raw('RTRIM(sn_account) AS account'),
        operaDb.raw('RTRIM(sn_name) AS name'),
        operaDb.raw('RTRIM(sn_analsys) AS analsys'),
        operaDb.raw('sn_currbal AS balance'),
      )) as unknown as CustomerRow[];
    if (!rows || rows.length === 0) {
      return { success: true, suggestions: [], gc_name: trimmedName };
    }
    const gcNorm = normaliseSuggestName(trimmedName);
    if (!gcNorm) {
      return { success: true, suggestions: [], gc_name: trimmedName };
    }

    const candidates: MatchSuggestion[] = [];
    for (const row of rows) {
      const account = (row.account ?? '').trim();
      const name = (row.name ?? '').trim();
      if (!account || !name) continue;
      const operaNorm = normaliseSuggestName(name);
      let score: number;
      if (gcNorm === operaNorm) {
        score = 1.0;
      } else if (
        operaNorm.length > 0 &&
        (gcNorm.includes(operaNorm) || operaNorm.includes(gcNorm))
      ) {
        score = 0.85;
      } else {
        score = sequenceMatcherRatio(gcNorm, operaNorm);
      }
      if (score >= 0.5) {
        candidates.push({
          account,
          name,
          score: Math.round(score * 1000) / 1000,
          is_gc:
            (row.analsys ?? '').toString().trim().toUpperCase() === 'GC',
        });
      }
    }

    candidates.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      // GC-tagged customers tied at the top
      if (a.is_gc !== b.is_gc) return a.is_gc ? -1 : 1;
      return a.name.localeCompare(b.name);
    });

    return {
      success: true,
      suggestions: candidates.slice(0, 5),
      gc_name: trimmedName,
    };
  } catch {
    // Match Python: dashboard always loads, soft success on error
    return { success: true, suggestions: [], gc_name: trimmedName };
  }
}
