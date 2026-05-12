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

export type SubscriptionTagsResponse =
  | SubscriptionTagsPreviewResponse
  | SubscriptionTagsApplyResponse;

const FREQ_LABELS: Record<string, string> = {
  W: 'Weekly',
  F: 'Fortnightly',
  M: 'Monthly',
  B: 'Bi-monthly',
  Q: 'Quarterly',
  H: 'Half-yearly',
  A: 'Annual',
};

interface IheadRow {
  ih_doc: string | null;
  ih_account: string | null;
  ih_name: string | null;
  ih_ignore: string | null;
  ih_analsys: string | null;
}

/**
 * Run the preview / apply flow.
 */
export async function updateSubscriptionTags(
  operaDb: Knex,
  config: { subscription_tag: string; subscription_frequencies: string[] },
  req: SubscriptionTagsRequest = {},
): Promise<SubscriptionTagsResponse> {
  const mode: SubscriptionTagMode = req.mode === 'apply' ? 'apply' : 'preview';
  const overwrite = !!req.overwrite;

  const tag = (config.subscription_tag ?? '').trim();
  const frequencies = (config.subscription_frequencies ?? []).filter(
    (f) => typeof f === 'string' && f.length > 0,
  );

  if (!tag) {
    return { success: false, error: 'Subscription tag is not configured' };
  }
  if (frequencies.length === 0) {
    return { success: false, error: 'No frequency filters selected' };
  }

  try {
    const freqPlaceholders = frequencies.map(() => '?').join(',');
    const rows = (await operaDb('ihead')
      .select(
        'ih_doc',
        'ih_account',
        'ih_name',
        'ih_ignore',
        'ih_analsys',
      )
      .where('ih_docstat', 'U')
      .andWhere((qb) => {
        qb.whereNull('ih_econtr').orWhereRaw('ih_econtr >= GETDATE()');
      })
      .whereRaw(`RTRIM(ih_ignore) IN (${freqPlaceholders})`, frequencies)
      .orderBy('ih_account', 'asc')
      .orderBy('ih_doc', 'asc')) as unknown as IheadRow[];

    const documents: SubscriptionTagDocument[] = [];
    let alreadyTagged = 0;
    let willTag = 0;
    let hasDifferent = 0;

    for (const row of rows) {
      const docRef = (row.ih_doc ?? '').trim();
      const account = (row.ih_account ?? '').trim();
      const name = (row.ih_name ?? '').trim();
      const freqCode = (row.ih_ignore ?? '').trim();
      const currentAnalsys = (row.ih_analsys ?? '').trim();

      let status: SubscriptionTagDocument['status'];
      if (currentAnalsys === tag) {
        alreadyTagged++;
        status = 'already_tagged';
      } else if (!currentAnalsys) {
        willTag++;
        status = 'will_tag';
      } else {
        hasDifferent++;
        status = 'has_different';
      }

      documents.push({
        doc_ref: docRef,
        account,
        name,
        frequency: FREQ_LABELS[freqCode] ?? freqCode,
        frequency_code: freqCode,
        current_analsys: currentAnalsys,
        status,
      });
    }

    if (mode === 'preview') {
      return {
        success: true,
        tag,
        total_matching: documents.length,
        already_tagged: alreadyTagged,
        will_tag: willTag,
        has_different: hasDifferent,
        documents,
      };
    }

    // Apply mode — query-builder form so rowsAffected is real on
    // every driver (mssql/foxpro/sqlite). Faithful to legacy filter
    // semantics in apps/gocardless/api/routes.py.
    const placeholders = frequencies.map(() => '?').join(',');
    let baseQuery = operaDb('ihead')
      .where('ih_docstat', 'U')
      .andWhere(function notExpired(this: Knex.QueryBuilder) {
        this.whereNull('ih_econtr').orWhereRaw('ih_econtr >= GETDATE()');
      })
      .whereRaw(`RTRIM(ih_ignore) IN (${placeholders})`, frequencies);

    if (overwrite) {
      baseQuery = baseQuery.andWhere(function differentTag(this: Knex.QueryBuilder) {
        this.whereRaw('RTRIM(ih_analsys) != ?', [tag])
          .orWhereNull('ih_analsys')
          .orWhereRaw("RTRIM(ih_analsys) = ''");
      });
    } else {
      baseQuery = baseQuery.andWhere(function unset(this: Knex.QueryBuilder) {
        this.whereNull('ih_analsys').orWhereRaw("RTRIM(ih_analsys) = ''");
      });
    }

    const updated = Number(
      await baseQuery.update({
        ih_analsys: tag,
        datemodified: operaDb.raw('GETDATE()'),
      }),
    );

    return {
      success: true,
      updated,
      tag,
      overwrite,
    };
  } catch (err: any) {
    return { success: false, error: err?.message ?? String(err) };
  }
}
