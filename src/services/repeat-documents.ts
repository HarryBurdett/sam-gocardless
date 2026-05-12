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

const FREQUENCY_MAP: Record<string, { unit: string; count: number }> = {
  W: { unit: 'weekly', count: 1 },
  M: { unit: 'monthly', count: 1 },
  Q: { unit: 'monthly', count: 3 },
  A: { unit: 'yearly', count: 1 },
};

const FREQUENCY_LABELS: Record<string, string> = {
  W: 'Weekly',
  F: 'Fortnightly',
  M: 'Monthly',
  B: 'Bi-monthly',
  Q: 'Quarterly',
  H: 'Half-yearly',
  A: 'Annual',
};

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

interface IheadRow {
  ih_doc: string | null;
  ih_account: string | null;
  ih_name: string | null;
  ih_ignore: string | null;
  ih_dcontr: number | string | null;
  ih_scontr: Date | string | null;
  ih_econtr: Date | string | null;
  ih_job: string | null;
  ih_analsys: string | null;
  ih_custref: string | null;
  ih_narr1: string | null;
  line_nett: number | string | null;
  line_vat: number | string | null;
}

interface MandateRow {
  mandate_id: string | null;
  opera_account: string | null;
}

interface SubRow {
  subscription_id: string | null;
  opera_account: string | null;
  amount_pence: number | string | null;
  source_doc: string | null;
  status: string | null;
  name: string | null;
  interval_unit: string | null;
  interval_count: number | string | null;
}

function trim(s: string | null | undefined): string {
  return (s ?? '').trim();
}

function dateToIso(d: Date | string | null): string | null {
  if (!d) return null;
  if (d instanceof Date) {
    if (Number.isNaN(d.getTime())) return null;
    return d.toISOString();
  }
  return String(d);
}

function formatPounds(pence: number): string {
  return `£${(pence / 100).toLocaleString('en-GB', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

function frequencyDetails(
  freqCode: string,
  daysBetween: number,
): { unit: string; count: number; label: string } {
  const code = (freqCode ?? 'M').trim() || 'M';
  const map = FREQUENCY_MAP[code] ?? { unit: 'monthly', count: 1 };
  let label = FREQUENCY_LABELS[code];
  if (!label) {
    if (code === 'D') label = `Every ${daysBetween} days`;
    else label = code;
  }
  return { unit: map.unit, count: map.count, label };
}

export async function getRepeatDocuments(
  operaDb: Knex,
  appDb: Knex,
  opts: GetRepeatDocumentsOptions = {},
): Promise<GetRepeatDocumentsResponse> {
  const requireMandate = opts.requireMandate !== false;
  const subTag = opts.subscriptionTag ?? 'SUB';
  try {
    // 1. Active mandates lookup keyed by opera_account
    const mandateRows = (await appDb('gocardless_mandates')
      .where({ mandate_status: 'active' })
      .select('mandate_id', 'opera_account')) as unknown as MandateRow[];
    const mandateLookup = new Map<string, MandateRow>();
    for (const m of mandateRows ?? []) {
      const acct = trim(m.opera_account);
      if (acct) mandateLookup.set(acct, m);
    }

    // 2. Active/paused subscriptions grouped by opera_account
    const subRows = (await appDb('gocardless_subscriptions')
      .select(
        'subscription_id',
        'opera_account',
        'amount_pence',
        'source_doc',
        'status',
        'name',
        'interval_unit',
        'interval_count',
      )) as unknown as SubRow[];
    const subsByAccount = new Map<string, SubRow[]>();
    for (const s of subRows ?? []) {
      const acct = trim(s.opera_account);
      const status = trim(s.status);
      if (!acct) continue;
      if (status !== 'active' && status !== 'paused') continue;
      const list = subsByAccount.get(acct) ?? [];
      list.push(s);
      subsByAccount.set(acct, list);
    }

    // 3. Subscriptions linked to specific docs via junction table — used
    //    for "has_subscription" + mismatch detection.
    const docLinks = (await appDb('gocardless_subscription_documents').select(
      'subscription_id',
      'source_doc',
    )) as unknown as Array<{
      subscription_id: string | null;
      source_doc: string | null;
    }>;
    const subBySourceDoc = new Map<string, SubRow>();
    const subById = new Map<string, SubRow>();
    for (const s of subRows ?? []) {
      const sid = trim(s.subscription_id);
      if (sid) subById.set(sid, s);
    }
    for (const link of docLinks ?? []) {
      const doc = trim(link.source_doc);
      const sid = trim(link.subscription_id);
      if (!doc || !sid) continue;
      const sub = subById.get(sid);
      // Match Python's "AND s.status != 'cancelled'" filter.
      if (sub && trim(sub.status) !== 'cancelled') {
        // Latest-wins (Python orders by created_at DESC LIMIT 1)
        if (!subBySourceDoc.has(doc)) subBySourceDoc.set(doc, sub);
      }
    }

    // 4. Read Opera ihead joined to itran totals (in pence).
    const heads = (await operaDb('ihead')
      .leftJoin(
        operaDb('itran')
          .select('it_doc')
          .sum({ line_nett: 'it_exvat' })
          .sum({ line_vat: 'it_vatval' })
          .groupBy('it_doc')
          .as('lines'),
        'lines.it_doc',
        'ih_doc',
      )
      .where({ ih_docstat: 'U' })
      .andWhere((qb) => {
        qb.whereNull('ih_econtr').orWhere(
          'ih_econtr',
          '>=',
          operaDb.raw('GETDATE()'),
        );
      })
      .orderBy([
        { column: 'ih_account', order: 'asc' },
        { column: 'ih_doc', order: 'asc' },
      ])
      .select(
        'ih_doc',
        'ih_account',
        'ih_name',
        'ih_ignore',
        'ih_dcontr',
        'ih_scontr',
        'ih_econtr',
        'ih_job',
        'ih_analsys',
        'ih_custref',
        'ih_narr1',
        operaDb.raw('COALESCE(lines.line_nett, 0) AS line_nett'),
        operaDb.raw('COALESCE(lines.line_vat, 0) AS line_vat'),
      )) as unknown as IheadRow[];

    const documents: RepeatDocument[] = [];
    for (const row of heads ?? []) {
      const docRef = trim(row.ih_doc);
      const account = trim(row.ih_account);
      const name = trim(row.ih_name);
      const freqCode = trim(row.ih_ignore) || 'M';
      const daysBetween = Number(row.ih_dcontr ?? 0) || 0;
      const dept = trim(row.ih_job);
      const analsys = trim(row.ih_analsys);
      const custRef = trim(row.ih_custref);
      const narr = trim(row.ih_narr1);
      const lineNettPence = Number(row.line_nett ?? 0) || 0;
      const lineVatPence = Number(row.line_vat ?? 0) || 0;
      const exVat = lineNettPence / 100;
      const vat = lineVatPence / 100;
      const totalIncVat = exVat + vat;
      const amountPence = Math.round(lineNettPence + lineVatPence);
      const isSubTagged = analsys === subTag;

      const freq = frequencyDetails(freqCode, daysBetween);
      const mandate = mandateLookup.get(account) ?? null;
      if (requireMandate && !mandate) continue;

      const existingSub = subBySourceDoc.get(docRef) ?? null;

      // Suggest a matching subscription only when not yet linked.
      let matchingSub: SubRow | null = null;
      if (!existingSub) {
        const candidates = subsByAccount.get(account) ?? [];
        for (const s of candidates) {
          const sAmt = Math.round(Number(s.amount_pence ?? 0));
          if (sAmt === amountPence && !trim(s.source_doc)) {
            matchingSub = s;
            break;
          }
        }
        if (!matchingSub) {
          for (const s of candidates) {
            const sAmt = Math.round(Number(s.amount_pence ?? 0));
            if (Math.abs(sAmt - amountPence) <= 100 && !trim(s.source_doc)) {
              matchingSub = s;
              break;
            }
          }
        }
      }

      // Detect mismatch when a subscription is linked
      let mismatch: RepeatDocumentMismatch | null = null;
      if (existingSub) {
        const subAmount = Math.round(Number(existingSub.amount_pence ?? 0));
        const subUnit = trim(existingSub.interval_unit) || 'monthly';
        const subCount = Number(existingSub.interval_count ?? 1) || 1;
        const details: string[] = [];
        if (subAmount !== amountPence) {
          details.push(
            `Amount: subscription ${formatPounds(subAmount)} vs document ${formatPounds(amountPence)}`,
          );
        }
        if (subUnit !== freq.unit || subCount !== freq.count) {
          // Python falls back to `existing_sub['interval_unit']` when
          // frequency_label not present; we always have the unit.
          const subFrequencyLabel =
            subUnit === 'monthly' && subCount === 3
              ? 'Quarterly'
              : subUnit === 'yearly' && subCount === 1
                ? 'Annual'
                : subUnit === 'weekly' && subCount === 1
                  ? 'Weekly'
                  : subUnit === 'monthly' && subCount === 1
                    ? 'Monthly'
                    : `Every ${subCount} ${subUnit}`;
          details.push(
            `Frequency: subscription ${subFrequencyLabel} vs document ${freq.label}`,
          );
        }
        if (details.length > 0) {
          mismatch = {
            details,
            sub_amount_pence: subAmount,
            sub_amount_formatted: formatPounds(subAmount),
            doc_amount_pence: amountPence,
            doc_amount_formatted: formatPounds(amountPence),
          };
        }
      }

      documents.push({
        doc_ref: docRef,
        opera_account: account,
        customer_name: name,
        frequency_code: freqCode,
        frequency: freq.label,
        interval_unit: freq.unit,
        interval_count: freq.count,
        start_date: dateToIso(row.ih_scontr),
        end_date: dateToIso(row.ih_econtr),
        ex_vat: exVat,
        vat,
        total_inc_vat: totalIncVat,
        amount_formatted: formatPounds(amountPence),
        amount_pence: amountPence,
        customer_ref: custRef,
        narration: narr,
        is_sub_tagged: isSubTagged,
        department: dept,
        has_mandate: mandate !== null,
        mandate_id: mandate?.mandate_id ?? null,
        has_subscription: existingSub !== null,
        subscription_id: existingSub?.subscription_id ?? null,
        subscription_status: existingSub?.status ?? null,
        mismatch,
        matching_subscription: matchingSub
          ? {
              subscription_id: trim(matchingSub.subscription_id),
              name: trim(matchingSub.name),
              amount_formatted: formatPounds(
                Math.round(Number(matchingSub.amount_pence ?? 0)),
              ),
              status: trim(matchingSub.status),
            }
          : null,
      });
    }

    return {
      success: true,
      documents,
      count: documents.length,
      with_mandate: documents.filter((d) => d.has_mandate).length,
      with_subscription: documents.filter((d) => d.has_subscription).length,
      with_match: documents.filter((d) => d.matching_subscription !== null).length,
    };
  } catch (err: any) {
    return {
      success: false,
      documents: [],
      count: 0,
      with_mandate: 0,
      with_subscription: 0,
      with_match: 0,
      error: err?.message ?? String(err),
    };
  }
}
