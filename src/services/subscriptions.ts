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

// ---------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------

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
  // -- Opera-enrichment fields (legacy parity, frontend reads these) --
  linked_documents: OperaLinkedDocument[];
  linked_document_count: number;
  opera_amount_pence: number | null;
  opera_amount_formatted: string | null;
  opera_frequency: string | null;
  has_sub_tag: boolean | null;
  mismatch: { details: string[] } | null;
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

interface SubscriptionRow {
  id: number;
  subscription_id: string | null;
  mandate_id: string | null;
  opera_account: string | null;
  opera_name: string | null;
  source_doc: string | null;
  amount_pence: number | string | null;
  currency: string | null;
  interval_unit: string | null;
  interval_count: number | string | null;
  day_of_month: number | string | null;
  name: string | null;
  status: string | null;
  start_date: string | null;
  end_date: string | null;
  created_at: Date | string | null;
  updated_at: Date | string | null;
  synced_at: Date | string | null;
}

// ---------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------

function dateToIso(d: Date | string | null): string {
  if (!d) return '';
  if (d instanceof Date) {
    if (Number.isNaN(d.getTime())) return '';
    return d.toISOString();
  }
  return String(d);
}

function formatPounds(pence: number): string {
  const pounds = pence / 100;
  // Match Python's `f"£{x:,.2f}"`: thousands sep + 2dp.
  return `£${pounds.toLocaleString('en-GB', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

function frequencyLabel(unit: string, count: number): string {
  const u = (unit ?? 'monthly').toLowerCase();
  const c = count || 1;
  if (u === 'weekly' && c === 1) return 'Weekly';
  if (u === 'monthly' && c === 1) return 'Monthly';
  if (u === 'monthly' && c === 3) return 'Quarterly';
  if (u === 'yearly' && c === 1) return 'Annual';
  return `Every ${c} ${u}`;
}

function rowToSubscription(
  row: SubscriptionRow,
  sourceDocs: string[],
  mandateNameLookup: Map<string, string>,
  operaDocs: Map<string, OperaLinkedDocument>,
): Subscription {
  const operaAccount = (row.opera_account ?? '').trim();
  const operaName = (row.opera_name ?? '').trim();
  const intervalUnit = (row.interval_unit ?? 'monthly').toLowerCase();
  const intervalCount = Number(row.interval_count ?? 1) || 1;
  const amountPence = Math.round(Number(row.amount_pence ?? 0));
  const dayOfMonth =
    row.day_of_month === null || row.day_of_month === undefined
      ? null
      : Number(row.day_of_month);
  const customerName =
    operaName || mandateNameLookup.get(operaAccount) || operaAccount;

  // Build per-document enrichment for this subscription's linked docs.
  // Faithful to legacy lines 8953-8984.
  const linkedDocs: OperaLinkedDocument[] = [];
  let totalOperaPence = 0;
  for (const docRef of sourceDocs) {
    const opera = operaDocs.get(docRef);
    if (opera) {
      linkedDocs.push(opera);
      totalOperaPence += opera.amount_pence;
    }
  }

  let operaAmountPence: number | null = null;
  let operaAmountFormatted: string | null = null;
  let operaFrequency: string | null = null;
  let hasSubTag: boolean | null = null;
  let mismatchDetails: string[] = [];

  if (linkedDocs.length > 0) {
    operaAmountPence = totalOperaPence;
    operaAmountFormatted = formatPounds(totalOperaPence);
    operaFrequency = linkedDocs[0]!.frequency;
    hasSubTag = linkedDocs.every((d) => d.has_sub_tag);
    if (amountPence !== totalOperaPence) {
      mismatchDetails.push(
        `Amount: GC ${formatPounds(amountPence)} vs Opera ${formatPounds(totalOperaPence)} (${linkedDocs.length} doc${linkedDocs.length > 1 ? 's' : ''})`,
      );
    }
    if (
      intervalUnit !== linkedDocs[0]!.interval_unit ||
      intervalCount !== linkedDocs[0]!.interval_count
    ) {
      mismatchDetails.push(
        `Frequency: GC ${frequencyLabel(intervalUnit, intervalCount)} vs Opera ${linkedDocs[0]!.frequency}`,
      );
    }
  }

  return {
    id: row.id,
    subscription_id: row.subscription_id ?? '',
    mandate_id: row.mandate_id ?? '',
    opera_account: operaAccount,
    opera_name: operaName,
    source_doc: row.source_doc ?? '',
    source_docs: sourceDocs,
    amount_pence: amountPence,
    amount_pounds: amountPence / 100,
    amount_formatted: formatPounds(amountPence),
    currency: row.currency ?? 'GBP',
    interval_unit: intervalUnit,
    interval_count: intervalCount,
    frequency: frequencyLabel(intervalUnit, intervalCount),
    day_of_month: Number.isFinite(dayOfMonth as number) ? (dayOfMonth as number) : null,
    name: row.name ?? '',
    status: row.status ?? '',
    start_date: row.start_date ?? '',
    end_date: row.end_date ?? '',
    created_at: dateToIso(row.created_at),
    updated_at: dateToIso(row.updated_at),
    synced_at: dateToIso(row.synced_at),
    customer_name: customerName,
    linked_documents: linkedDocs,
    linked_document_count: sourceDocs.length,
    opera_amount_pence: operaAmountPence,
    opera_amount_formatted: operaAmountFormatted,
    opera_frequency: operaFrequency,
    has_sub_tag: hasSubTag,
    mismatch: mismatchDetails.length > 0 ? { details: mismatchDetails } : null,
  };
}

async function fetchSourceDocs(
  appDb: Knex,
  subscriptionIds: string[],
): Promise<Map<string, string[]>> {
  const map = new Map<string, string[]>();
  if (subscriptionIds.length === 0) return map;
  const rows = (await appDb('gocardless_subscription_documents')
    .whereIn('subscription_id', subscriptionIds)
    .orderBy('added_at', 'asc')
    .select('subscription_id', 'source_doc')) as unknown as Array<{
    subscription_id: string | null;
    source_doc: string | null;
  }>;
  for (const r of rows ?? []) {
    const sid = (r.subscription_id ?? '').trim();
    const doc = (r.source_doc ?? '').trim();
    if (!sid || !doc) continue;
    const arr = map.get(sid) ?? [];
    arr.push(doc);
    map.set(sid, arr);
  }
  return map;
}

/**
 * Look up the `subscription_tag` setting from the gocardless settings
 * row — defaults to 'SUB'. Used by the Opera-doc enrichment to flag
 * which documents are tagged for subscription auto-collection.
 */
async function loadSubscriptionTag(appDb: Knex): Promise<string> {
  try {
    const row = (await appDb('settings')
      .select('value')
      .where({ key: 'subscription_tag' })
      .first()) as { value?: string } | undefined;
    const v = (row?.value ?? '').trim();
    return v || 'SUB';
  } catch {
    return 'SUB';
  }
}

interface IheadRow {
  ih_doc: string | null;
  ih_ignore: string | null;
  ih_analsys: string | null;
  line_nett: number | string | null;
  line_vat: number | string | null;
}

/**
 * Fetch Opera document metadata (amount, frequency, has_sub_tag) for
 * the linked source-docs across a batch of subscriptions. Mirrors the
 * legacy `opera_docs` enrichment block (routes.py:8911-8951).
 *
 * Returns a map keyed by doc_ref → OperaLinkedDocument.
 */
async function fetchOperaDocs(
  operaDb: Knex | null,
  docRefs: string[],
  subscriptionTag: string,
): Promise<Map<string, OperaLinkedDocument>> {
  const map = new Map<string, OperaLinkedDocument>();
  const docs = Array.from(new Set(docRefs.map((d) => d.trim()).filter(Boolean)));
  if (docs.length === 0 || !operaDb) return map;

  // Frequency label table — mirrors legacy freq_labels.
  const FREQ_LABELS: Record<string, string> = {
    W: 'Weekly',
    F: 'Fortnightly',
    M: 'Monthly',
    B: 'Bi-monthly',
    Q: 'Quarterly',
    H: 'Half-yearly',
    A: 'Annual',
  };

  try {
    // Query ihead + itran summed by doc. Knex builder + subquery so the
    // SQL stays portable across mssql and foxpro drivers.
    const linesSub = operaDb('itran')
      .select('it_doc')
      .sum({ line_nett: 'it_exvat' })
      .sum({ line_vat: 'it_vatval' })
      .groupBy('it_doc')
      .as('lines');

    const rows = (await operaDb({ h: 'ihead' })
      .leftJoin(linesSub, 'lines.it_doc', 'h.ih_doc')
      .select(
        'h.ih_doc',
        'h.ih_ignore',
        'h.ih_analsys',
        operaDb.raw('COALESCE(lines.line_nett, 0) AS line_nett'),
        operaDb.raw('COALESCE(lines.line_vat, 0) AS line_vat'),
      )
      .whereIn('h.ih_doc', docs)
      .andWhere('h.ih_docstat', 'U')) as unknown as IheadRow[];

    for (const r of rows ?? []) {
      const docRef = (r.ih_doc ?? '').trim();
      if (!docRef) continue;
      const lineNettPence = Number(r.line_nett ?? 0);
      const lineVatPence = Number(r.line_vat ?? 0);
      const exVat = lineNettPence / 100;
      const vat = lineVatPence / 100;
      const total = exVat + vat;
      const freqCode = (r.ih_ignore ?? 'M').toString().trim() || 'M';
      const freqMap = FREQUENCY_MAP[freqCode] ?? { unit: 'monthly', count: 1 };
      map.set(docRef, {
        doc_ref: docRef,
        ex_vat: exVat,
        vat,
        total_inc_vat: total,
        amount_pence: Math.round(lineNettPence + lineVatPence),
        amount_formatted: formatPounds(Math.round(lineNettPence + lineVatPence)),
        frequency_code: freqCode,
        frequency: FREQ_LABELS[freqCode] ?? freqCode,
        interval_unit: freqMap.unit,
        interval_count: freqMap.count,
        has_sub_tag: (r.ih_analsys ?? '').toString().trim() === subscriptionTag,
      });
    }
  } catch {
    // best-effort — enrichment is non-essential
  }
  return map;
}

async function fetchMandateNames(
  appDb: Knex,
  operaAccounts: string[],
): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  if (operaAccounts.length === 0) return map;
  try {
    const rows = (await appDb('gocardless_mandates')
      .whereIn('opera_account', operaAccounts)
      .select('opera_account', 'opera_name')) as unknown as Array<{
      opera_account: string | null;
      opera_name: string | null;
    }>;
    for (const r of rows ?? []) {
      const acct = (r.opera_account ?? '').trim();
      if (acct) map.set(acct, (r.opera_name ?? '').trim());
    }
  } catch {
    // best-effort — mandate table may not exist in some test fixtures
  }
  return map;
}

// ---------------------------------------------------------------------
// listSubscriptions
// ---------------------------------------------------------------------

export async function listSubscriptions(
  appDb: Knex,
  opts: ListSubscriptionsOptions = {},
  operaDb: Knex | null = null,
): Promise<ListSubscriptionsResponse> {
  try {
    let query = appDb('gocardless_subscriptions').orderBy('created_at', 'desc');
    if (opts.limit !== undefined) {
      query = query.limit(opts.limit);
    }
    if (opts.status) {
      query = query.where({ status: opts.status });
    } else if (!opts.includeCancelled) {
      query = query.whereNot({ status: 'cancelled' });
    }
    if (opts.operaAccount) {
      query = query.where({ opera_account: opts.operaAccount });
    }
    const rows = (await query) as unknown as SubscriptionRow[];

    const subIds = rows
      .map((r) => (r.subscription_id ?? '').trim())
      .filter(Boolean);
    const accounts = Array.from(
      new Set(rows.map((r) => (r.opera_account ?? '').trim()).filter(Boolean)),
    );
    const subscriptionTag = await loadSubscriptionTag(appDb);

    const [docsBySub, mandateNames] = await Promise.all([
      fetchSourceDocs(appDb, subIds),
      fetchMandateNames(appDb, accounts),
    ]);

    // Collect all source-docs across all subscriptions for the
    // Opera lookup.
    const allDocs = new Set<string>();
    for (const docs of docsBySub.values()) {
      for (const d of docs) allDocs.add(d);
    }
    // Fall back to source_doc on the row when the docs join is empty.
    for (const r of rows) {
      const fallback = (r.source_doc ?? '').trim();
      if (fallback) allDocs.add(fallback);
    }
    const operaDocs = await fetchOperaDocs(
      operaDb,
      Array.from(allDocs),
      subscriptionTag,
    );

    const subscriptions = rows.map((r) =>
      rowToSubscription(
        r,
        docsBySub.get((r.subscription_id ?? '').trim()) ?? [],
        mandateNames,
        operaDocs,
      ),
    );
    const withMismatch = subscriptions.reduce(
      (n, s) => n + (s.mismatch ? 1 : 0),
      0,
    );
    return {
      success: true,
      subscriptions,
      count: subscriptions.length,
      with_mismatch: withMismatch,
    };
  } catch (err: any) {
    return {
      success: false,
      subscriptions: [],
      count: 0,
      error: err?.message ?? String(err),
    };
  }
}

// ---------------------------------------------------------------------
// getSubscription — single subscription with source_docs
// ---------------------------------------------------------------------

export async function getSubscription(
  appDb: Knex,
  subscriptionId: string,
  operaDb: Knex | null = null,
): Promise<GetSubscriptionResponse> {
  const id = (subscriptionId ?? '').trim();
  if (!id) return { success: false, error: 'subscription_id is required' };
  try {
    const row = (await appDb('gocardless_subscriptions')
      .where({ subscription_id: id })
      .first()) as unknown as SubscriptionRow | undefined;
    if (!row) {
      return { success: false, error: `Subscription ${id} not found` };
    }
    const account = (row.opera_account ?? '').trim();
    const subscriptionTag = await loadSubscriptionTag(appDb);
    const [docsBySub, mandateNames] = await Promise.all([
      fetchSourceDocs(appDb, [id]),
      fetchMandateNames(appDb, account ? [account] : []),
    ]);
    const linkedDocs = docsBySub.get(id) ?? [];
    const allDocs = new Set<string>(linkedDocs);
    if ((row.source_doc ?? '').trim()) {
      allDocs.add((row.source_doc ?? '').trim());
    }
    const operaDocs = await fetchOperaDocs(
      operaDb,
      Array.from(allDocs),
      subscriptionTag,
    );
    const subscription = rowToSubscription(
      row,
      linkedDocs,
      mandateNames,
      operaDocs,
    );
    return { success: true, subscription };
  } catch (err: any) {
    return { success: false, error: err?.message ?? String(err) };
  }
}

// ---------------------------------------------------------------------
// Status updates (local-only)
// ---------------------------------------------------------------------

export async function updateSubscriptionStatus(
  appDb: Knex,
  subscriptionId: string,
  status: string,
): Promise<boolean> {
  const id = (subscriptionId ?? '').trim();
  if (!id || !status) return false;
  const updated = await appDb('gocardless_subscriptions')
    .where({ subscription_id: id })
    .update({ status, updated_at: appDb.fn.now() });
  return Number(updated) > 0;
}

// ---------------------------------------------------------------------
// Lifecycle wrappers (pause / resume / cancel / update)
// ---------------------------------------------------------------------

async function runLifecycleAction(
  appDb: Knex,
  subscriptionId: string,
  fallbackStatus: string,
  remote: (id: string) => Promise<RemoteSubscriptionResult>,
): Promise<SubscriptionLifecycleResponse> {
  const id = (subscriptionId ?? '').trim();
  if (!id) return { success: false, error: 'subscription_id is required' };
  const r = await remote(id);
  if (!r.success) {
    return { success: false, error: r.error ?? 'Remote action failed' };
  }
  const remoteStatus =
    typeof r.subscription?.status === 'string' && r.subscription.status
      ? (r.subscription.status as string)
      : fallbackStatus;
  await updateSubscriptionStatus(appDb, id, remoteStatus);
  const fresh = await getSubscription(appDb, id);
  if (!fresh.success) {
    return { success: false, error: fresh.error };
  }
  return { success: true, subscription: fresh.subscription };
}

export async function pauseSubscription(
  appDb: Knex,
  subscriptionId: string,
  remote: (id: string) => Promise<RemoteSubscriptionResult>,
): Promise<SubscriptionLifecycleResponse> {
  return runLifecycleAction(appDb, subscriptionId, 'paused', remote);
}

export async function resumeSubscription(
  appDb: Knex,
  subscriptionId: string,
  remote: (id: string) => Promise<RemoteSubscriptionResult>,
): Promise<SubscriptionLifecycleResponse> {
  return runLifecycleAction(appDb, subscriptionId, 'active', remote);
}

export async function cancelSubscription(
  appDb: Knex,
  subscriptionId: string,
  remote: (id: string) => Promise<RemoteSubscriptionResult>,
): Promise<SubscriptionLifecycleResponse> {
  return runLifecycleAction(appDb, subscriptionId, 'cancelled', remote);
}

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
export async function updateSubscriptionDetails(
  appDb: Knex,
  subscriptionId: string,
  input: UpdateSubscriptionInput,
  remote: (
    id: string,
    opts: UpdateSubscriptionInput,
  ) => Promise<RemoteSubscriptionResult>,
): Promise<SubscriptionLifecycleResponse> {
  const id = (subscriptionId ?? '').trim();
  if (!id) return { success: false, error: 'subscription_id is required' };
  const r = await remote(id, input);
  if (!r.success) {
    return { success: false, error: r.error ?? 'Remote update failed' };
  }
  const local = (await appDb('gocardless_subscriptions')
    .where({ subscription_id: id })
    .first()) as unknown as SubscriptionRow | undefined;
  if (local) {
    const patch: Record<string, unknown> = { updated_at: appDb.fn.now() };
    if (typeof input.name === 'string' && input.name) {
      patch.name = input.name;
    }
    if (typeof input.amountPence === 'number' && Number.isFinite(input.amountPence)) {
      patch.amount_pence = Math.round(input.amountPence);
    }
    if (typeof r.subscription?.status === 'string' && r.subscription.status) {
      patch.status = r.subscription.status;
    }
    await appDb('gocardless_subscriptions')
      .where({ subscription_id: id })
      .update(patch);
  }
  const fresh = await getSubscription(appDb, id);
  if (!fresh.success) {
    return { success: false, error: fresh.error };
  }
  return { success: true, subscription: fresh.subscription };
}

// ---------------------------------------------------------------------
// createSubscription — from one or more Opera repeat documents
// ---------------------------------------------------------------------

const FREQUENCY_MAP: Record<string, { unit: string; count: number }> = {
  W: { unit: 'weekly', count: 1 },
  M: { unit: 'monthly', count: 1 },
  Q: { unit: 'monthly', count: 3 },
  A: { unit: 'yearly', count: 1 },
};

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
  fetchTaggedDocs: (
    sourceDocs: string[],
    subscriptionTag: string,
  ) => Promise<
    Array<{
      ih_doc: string;
      ih_account: string;
      ih_name: string;
      ih_ignore: string;
      ih_custref: string;
    }>
  >;
  /** Sum of it_exvat + it_vatval for all the supplied docs (pence). */
  sumLineTotals: (
    sourceDocs: string[],
  ) => Promise<{ lineNettPence: number; lineVatPence: number }>;
}

export interface CreateSubscriptionResponse {
  success: boolean;
  subscription?: Subscription;
  gc_response?: Record<string, unknown>;
  error?: string;
}

export async function createSubscription(
  appDb: Knex,
  input: CreateSubscriptionInput,
  operaReader: OperaRepeatDocReader,
  remote: CreateSubscriptionRemote,
  opts: { subscriptionTag?: string } = {},
): Promise<CreateSubscriptionResponse> {
  const subTag = opts.subscriptionTag ?? 'SUB';
  const sourceDocs = (input.sourceDocs ?? [])
    .map((s) => (s ?? '').toString().trim())
    .filter(Boolean);
  if (sourceDocs.length === 0) {
    return { success: false, error: 'source_doc or source_docs is required' };
  }

  // 1. Read repeat docs from Opera
  let docs;
  try {
    docs = await operaReader.fetchTaggedDocs(sourceDocs, subTag);
  } catch (err: any) {
    return { success: false, error: err?.message ?? String(err) };
  }
  if (!docs || docs.length === 0) {
    return {
      success: false,
      error: `No repeat documents found or not marked as ${subTag}`,
    };
  }

  // 2. Validate same customer
  const accounts = new Set<string>();
  const docRefs: string[] = [];
  for (const d of docs) {
    accounts.add((d.ih_account ?? '').trim());
    docRefs.push((d.ih_doc ?? '').trim());
  }
  if (accounts.size > 1) {
    return {
      success: false,
      error: `All documents must belong to the same customer. Found: ${Array.from(accounts).join(', ')}`,
    };
  }
  const account = accounts.values().next().value as string;

  // 3. Sum line totals
  let totals: { lineNettPence: number; lineVatPence: number };
  try {
    totals = await operaReader.sumLineTotals(docRefs);
  } catch (err: any) {
    return { success: false, error: err?.message ?? String(err) };
  }
  const totalAmountPence = Math.round(
    (totals.lineNettPence ?? 0) + (totals.lineVatPence ?? 0),
  );
  if (totalAmountPence <= 0) {
    return {
      success: false,
      error: `Invalid total amount: £${(totalAmountPence / 100).toFixed(2)}`,
    };
  }

  // 4. Frequency from first doc
  const first = docs[0]!;
  const freqCode = (first.ih_ignore ?? 'M').trim() || 'M';
  const freq = FREQUENCY_MAP[freqCode] ?? { unit: 'monthly', count: 1 };
  const customerName = (first.ih_name ?? '').trim();
  const custRef = (first.ih_custref ?? '').trim();
  const subName = custRef ? `${customerName} - ${custRef}` : customerName;

  // 5. Look up active mandate for the customer
  const mandate = (await appDb('gocardless_mandates')
    .where({ opera_account: account, mandate_status: 'active' })
    .orderBy('created_at', 'desc')
    .first()) as unknown as
    | { mandate_id: string | null; opera_name: string | null }
    | undefined;
  if (!mandate || !mandate.mandate_id) {
    return {
      success: false,
      error: `No active GoCardless mandate for customer ${account} (${customerName})`,
    };
  }

  // 6. Check no doc already linked to a different active subscription
  const linkedRows = (await appDb('gocardless_subscription_documents')
    .whereIn('source_doc', docRefs)
    .select('subscription_id', 'source_doc')) as unknown as Array<{
    subscription_id: string | null;
    source_doc: string | null;
  }>;
  if (linkedRows.length > 0) {
    const subIds = Array.from(
      new Set(
        linkedRows
          .map((r) => (r.subscription_id ?? '').trim())
          .filter(Boolean),
      ),
    );
    if (subIds.length > 0) {
      const existing = (await appDb('gocardless_subscriptions')
        .whereIn('subscription_id', subIds)
        .andWhereNot({ status: 'cancelled' })
        .select('subscription_id', 'status')) as unknown as Array<{
        subscription_id: string | null;
        status: string | null;
      }>;
      if (existing.length > 0) {
        const existingIds = new Set(
          existing.map((r) => (r.subscription_id ?? '').trim()),
        );
        for (const link of linkedRows) {
          const sid = (link.subscription_id ?? '').trim();
          const doc = (link.source_doc ?? '').trim();
          if (sid && existingIds.has(sid)) {
            const existingSub = existing.find(
              (e) => (e.subscription_id ?? '').trim() === sid,
            );
            return {
              success: false,
              error: `Document ${doc} already linked to subscription ${sid} (status: ${existingSub?.status ?? 'unknown'})`,
            };
          }
        }
      }
    }
  }

  // 7. Create subscription remotely
  const remoteResult = await remote({
    mandateId: mandate.mandate_id,
    amountPence: totalAmountPence,
    intervalUnit: freq.unit,
    interval: freq.count,
    dayOfMonth: input.dayOfMonth ?? null,
    name: subName,
    startDate: input.startDate ?? null,
    metadata: {
      opera_account: account,
      source_docs: docRefs.join(','),
    },
  });
  if (!remoteResult.success || !remoteResult.subscription) {
    return {
      success: false,
      error: remoteResult.error ?? 'Failed to create subscription remotely',
    };
  }
  const gcSub = remoteResult.subscription as Record<string, any>;
  const gcSubId = (gcSub.id as string | undefined) ?? '';
  if (!gcSubId) {
    return {
      success: false,
      error: 'GoCardless did not return a subscription id',
    };
  }

  // 8. Persist locally
  try {
    await appDb('gocardless_subscriptions').insert({
      subscription_id: gcSubId,
      mandate_id: mandate.mandate_id,
      opera_account: account,
      opera_name: customerName,
      source_doc: docRefs[0]!,
      amount_pence: totalAmountPence,
      currency: 'GBP',
      interval_unit: freq.unit,
      interval_count: freq.count,
      day_of_month:
        gcSub.day_of_month === null || gcSub.day_of_month === undefined
          ? null
          : Number(gcSub.day_of_month),
      name: subName,
      status: (gcSub.status as string | undefined) ?? 'active',
      start_date: (gcSub.start_date as string | undefined) ?? null,
      end_date: (gcSub.end_date as string | undefined) ?? null,
      synced_at: appDb.fn.now(),
    });

    // 9. Link all documents via junction table
    for (const doc of docRefs) {
      try {
        await appDb('gocardless_subscription_documents').insert({
          subscription_id: gcSubId,
          source_doc: doc,
          added_at: appDb.fn.now(),
        });
      } catch {
        // best-effort — duplicate would already be a link
      }
    }
  } catch (err: any) {
    return { success: false, error: err?.message ?? String(err) };
  }

  // 10. Return enriched local record
  const fresh = await getSubscription(appDb, gcSubId);
  return {
    success: true,
    subscription: fresh.subscription,
    gc_response: gcSub,
  };
}

// ---------------------------------------------------------------------
// syncSubscriptionsFromGocardless — pull every subscription via the API
// ---------------------------------------------------------------------

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
  links?: { mandate?: string };
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
  resolveAccount?: (
    mandateId: string,
  ) => Promise<{ opera_account: string | null; opera_name: string | null }>;
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
export async function syncSubscriptionsFromGocardless(
  appDb: Knex,
  fetchPage: (cursor: string | null) => Promise<PageResult>,
  opts: SyncOptions = {},
): Promise<SyncSubscriptionsResponse> {
  try {
    // Build mandate -> {opera_account, opera_name} lookup from local
    const mandates = (await appDb('gocardless_mandates').select(
      'mandate_id',
      'opera_account',
      'opera_name',
    )) as unknown as Array<{
      mandate_id: string | null;
      opera_account: string | null;
      opera_name: string | null;
    }>;
    const mandateLookup = new Map<
      string,
      { opera_account: string | null; opera_name: string | null }
    >();
    for (const m of mandates ?? []) {
      const mid = (m.mandate_id ?? '').trim();
      if (!mid) continue;
      const acct = (m.opera_account ?? '').trim();
      mandateLookup.set(mid, {
        opera_account: acct && acct !== '__UNLINKED__' ? acct : null,
        opera_name: (m.opera_name ?? '').trim() || null,
      });
    }

    let synced = 0;
    let updated = 0;
    let cursor: string | null = null;
    while (true) {
      const page = await fetchPage(cursor);
      if (!page.subscriptions || page.subscriptions.length === 0) break;
      for (const gc of page.subscriptions) {
        const subId = (gc.id ?? '').toString().trim();
        if (!subId) continue;
        const mandateId = (gc.links?.mandate ?? '').trim();
        let info = mandateLookup.get(mandateId) ?? {
          opera_account: null,
          opera_name: null,
        };
        if (!info.opera_name && mandateId && opts.resolveAccount) {
          try {
            const enriched = await opts.resolveAccount(mandateId);
            info = {
              opera_account: enriched.opera_account ?? info.opera_account,
              opera_name: enriched.opera_name ?? info.opera_name,
            };
          } catch {
            // best-effort
          }
        }

        const existing = (await appDb('gocardless_subscriptions')
          .where({ subscription_id: subId })
          .first()) as unknown as
          | {
              id: number;
              source_doc: string | null;
              opera_account: string | null;
              opera_name: string | null;
            }
          | undefined;

        const amountPence = Math.round(Number(gc.amount ?? 0));
        const intervalUnit = String(gc.interval_unit ?? 'monthly').toLowerCase();
        const intervalCount = Number(gc.interval ?? 1) || 1;
        const dayOfMonth =
          gc.day_of_month === null || gc.day_of_month === undefined
            ? null
            : Number(gc.day_of_month);
        const name = gc.name ?? null;
        const status = gc.status ?? 'active';
        const startDate = (gc.start_date ?? null) as string | null;
        const endDate = (gc.end_date ?? null) as string | null;

        if (existing) {
          await appDb('gocardless_subscriptions')
            .where({ subscription_id: subId })
            .update({
              mandate_id: mandateId,
              amount_pence: amountPence,
              interval_unit: intervalUnit,
              interval_count: intervalCount,
              day_of_month: Number.isFinite(dayOfMonth as number)
                ? (dayOfMonth as number)
                : null,
              name,
              status,
              start_date: startDate,
              end_date: endDate,
              opera_account: info.opera_account ?? existing.opera_account,
              opera_name: info.opera_name ?? existing.opera_name,
              updated_at: appDb.fn.now(),
              synced_at: appDb.fn.now(),
            });
          updated += 1;
        } else {
          await appDb('gocardless_subscriptions').insert({
            subscription_id: subId,
            mandate_id: mandateId,
            opera_account: info.opera_account,
            opera_name: info.opera_name,
            source_doc: null,
            amount_pence: amountPence,
            currency: 'GBP',
            interval_unit: intervalUnit,
            interval_count: intervalCount,
            day_of_month: Number.isFinite(dayOfMonth as number)
              ? (dayOfMonth as number)
              : null,
            name,
            status,
            start_date: startDate,
            end_date: endDate,
            synced_at: appDb.fn.now(),
          });
          synced += 1;
        }
      }
      if (!page.after) break;
      cursor = page.after;
    }

    return {
      success: true,
      synced,
      updated,
      total: synced + updated,
      message: `Synced ${synced} new, updated ${updated} existing subscriptions`,
    };
  } catch (err: any) {
    return { success: false, error: err?.message ?? String(err) };
  }
}

// ---------------------------------------------------------------------
// sync-from-opera — read itran totals for linked docs, push to GC
// ---------------------------------------------------------------------

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
export async function syncSubscriptionFromOpera(
  appDb: Knex,
  subscriptionId: string,
  readOperaDocAmount: (sourceDocs: string[]) => Promise<OperaDocAmount>,
  updateRemote: (id: string, amountPence: number) => Promise<RemoteSubscriptionResult>,
): Promise<SyncSubscriptionFromOperaResponse> {
  const id = (subscriptionId ?? '').trim();
  if (!id) return { success: false, error: 'subscription_id is required' };

  const local = await getSubscription(appDb, id);
  if (!local.success || !local.subscription) {
    return { success: false, error: local.error ?? `Subscription ${id} not found` };
  }
  const sourceDocs = local.subscription.source_docs ?? [];
  if (sourceDocs.length === 0) {
    return {
      success: false,
      error: 'Subscription is not linked to any Opera documents',
    };
  }

  let opera: OperaDocAmount;
  try {
    opera = await readOperaDocAmount(sourceDocs);
  } catch (err: any) {
    return { success: false, error: err?.message ?? String(err) };
  }
  if ((opera.lineNettPence ?? 0) === 0 && (opera.lineVatPence ?? 0) === 0) {
    return {
      success: false,
      error: 'Opera documents not found or have no lines',
    };
  }

  const newAmountPence = Math.round(
    (opera.lineNettPence ?? 0) + (opera.lineVatPence ?? 0),
  );
  const oldAmountPence = local.subscription.amount_pence;
  if (newAmountPence === oldAmountPence) {
    return { success: true, message: 'No change needed — amounts already match' };
  }

  const remote = await updateRemote(id, newAmountPence);
  if (!remote.success) {
    return { success: false, error: remote.error ?? 'Remote update failed' };
  }

  await appDb('gocardless_subscriptions')
    .where({ subscription_id: id })
    .update({
      amount_pence: newAmountPence,
      updated_at: appDb.fn.now(),
    });

  const fresh = await getSubscription(appDb, id);
  return {
    success: true,
    old_amount_pence: oldAmountPence,
    new_amount_pence: newAmountPence,
    old_amount_formatted: formatPounds(oldAmountPence),
    new_amount_formatted: formatPounds(newAmountPence),
    subscription: fresh.subscription,
  };
}

// ---------------------------------------------------------------------
// Subscription <-> Opera repeat-document linking
// ---------------------------------------------------------------------

export interface LinkSubscriptionInput {
  subscriptionId: string;
  sourceDoc: string;
}

export async function linkSubscriptionToDocument(
  appDb: Knex,
  input: LinkSubscriptionInput,
): Promise<SubscriptionLifecycleResponse> {
  const subId = (input.subscriptionId ?? '').trim();
  const doc = (input.sourceDoc ?? '').trim();
  if (!subId || !doc) {
    return {
      success: false,
      error: 'subscription_id and source_doc are required',
    };
  }
  // 1. The subscription itself must exist locally
  const sub = (await appDb('gocardless_subscriptions')
    .where({ subscription_id: subId })
    .first()) as unknown as SubscriptionRow | undefined;
  if (!sub) {
    return {
      success: false,
      error: `Subscription ${subId} not found locally. Sync first.`,
    };
  }
  // 2. The doc must not already be linked to a *different* subscription
  const existing = (await appDb('gocardless_subscription_documents')
    .where({ source_doc: doc })
    .select('subscription_id')) as unknown as Array<{
    subscription_id: string | null;
  }>;
  for (const row of existing ?? []) {
    const linked = (row.subscription_id ?? '').trim();
    if (linked && linked !== subId) {
      return {
        success: false,
        error: `Document ${doc} already linked to subscription ${linked}`,
      };
    }
  }
  // 3. Insert (subscription_id, source_doc) — duplicate-safe.
  const already = existing.some(
    (row) => (row.subscription_id ?? '').trim() === subId,
  );
  if (already) {
    return {
      success: false,
      error: `Document ${doc} is already linked to this subscription`,
    };
  }
  try {
    await appDb('gocardless_subscription_documents').insert({
      subscription_id: subId,
      source_doc: doc,
      added_at: appDb.fn.now(),
    });
  } catch (err: any) {
    return { success: false, error: err?.message ?? String(err) };
  }
  const fresh = await getSubscription(appDb, subId);
  if (!fresh.success) {
    return { success: false, error: fresh.error };
  }
  return { success: true, subscription: fresh.subscription };
}

export interface UnlinkSubscriptionInput {
  subscriptionId: string;
  sourceDoc?: string | null;
}

export async function unlinkSubscriptionFromDocument(
  appDb: Knex,
  input: UnlinkSubscriptionInput,
): Promise<SubscriptionLifecycleResponse> {
  const subId = (input.subscriptionId ?? '').trim();
  if (!subId) {
    return { success: false, error: 'subscription_id is required' };
  }
  const sub = (await appDb('gocardless_subscriptions')
    .where({ subscription_id: subId })
    .first()) as unknown as SubscriptionRow | undefined;
  if (!sub) {
    return { success: false, error: `Subscription ${subId} not found` };
  }
  const doc = (input.sourceDoc ?? '').trim();
  if (doc) {
    const removed = await appDb('gocardless_subscription_documents')
      .where({ subscription_id: subId, source_doc: doc })
      .delete();
    if (!Number(removed)) {
      return {
        success: false,
        error: `Document ${doc} is not linked to this subscription`,
      };
    }
  } else {
    await appDb('gocardless_subscription_documents')
      .where({ subscription_id: subId })
      .delete();
  }
  const fresh = await getSubscription(appDb, subId);
  if (!fresh.success) {
    return { success: false, error: fresh.error };
  }
  return { success: true, subscription: fresh.subscription };
}
