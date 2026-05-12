/**
 * GoCardless mandate listing.
 *
 * Faithful port of:
 *   - list_gocardless_mandates       (apps/gocardless/api/routes.py:6404-6425)
 *   - list_unlinked_gocardless_mandates (routes.py:6428-6447)
 *
 * Reads the per-app DB's `gocardless_mandates` table.
 * `opera_account = '__UNLINKED__'` is the sentinel for mandates synced
 * from the GoCardless API but not yet linked to an Opera customer —
 * they appear in /unlinked endpoint for manual linking.
 *
 * The main /mandates list filters out __UNLINKED__ entries when there's
 * a linked version of the same mandate_id (deduplication for the case
 * where a sync creates an unlinked row and a later operator action
 * links it without removing the placeholder).
 */
import type { Knex } from 'knex';

export interface Mandate {
  id: number;
  mandate_id: string;
  opera_account: string;
  opera_name: string;
  gocardless_name: string;
  gocardless_customer_id: string;
  mandate_status: string;
  scheme: string;
  email: string;
  created_at: string;
  updated_at: string;
}

export interface ListMandatesOptions {
  status?: string | null;
  operaAccount?: string | null;
}

export interface ListMandatesResponse {
  success: boolean;
  mandates: Mandate[];
  count: number;
  error?: string;
}

function dateToIso(d: Date | string | null): string {
  if (!d) return '';
  if (d instanceof Date) {
    if (Number.isNaN(d.getTime())) return '';
    return d.toISOString();
  }
  return String(d);
}

interface MandateRow {
  id: number;
  mandate_id: string | null;
  opera_account: string | null;
  opera_name: string | null;
  gocardless_name: string | null;
  gocardless_customer_id: string | null;
  mandate_status: string | null;
  scheme: string | null;
  email: string | null;
  created_at: Date | string | null;
  updated_at: Date | string | null;
}

function rowToMandate(r: MandateRow): Mandate {
  return {
    id: r.id,
    mandate_id: r.mandate_id ?? '',
    opera_account: r.opera_account ?? '',
    opera_name: r.opera_name ?? '',
    gocardless_name: r.gocardless_name ?? '',
    gocardless_customer_id: r.gocardless_customer_id ?? '',
    mandate_status: r.mandate_status ?? '',
    scheme: r.scheme ?? '',
    email: r.email ?? '',
    created_at: dateToIso(r.created_at),
    updated_at: dateToIso(r.updated_at),
  };
}

export async function listMandates(
  appDb: Knex,
  opts: ListMandatesOptions = {},
): Promise<ListMandatesResponse> {
  try {
    let query = appDb('gocardless_mandates');
    if (opts.status) {
      query = query.where({ mandate_status: opts.status });
    }
    if (opts.operaAccount) {
      query = query.where({ opera_account: opts.operaAccount });
    }
    const rows = (await query) as unknown as MandateRow[];

    // Dedup __UNLINKED__ entries when a linked version of the same
    // mandate_id exists. Same as Python.
    const linkedIds = new Set<string>();
    for (const r of rows) {
      if (r.opera_account && r.opera_account !== '__UNLINKED__') {
        linkedIds.add((r.mandate_id ?? '').trim());
      }
    }
    const filtered = rows.filter(
      (r) =>
        r.opera_account !== '__UNLINKED__' ||
        !linkedIds.has((r.mandate_id ?? '').trim()),
    );

    // Sort by opera_name (case-insensitive)
    filtered.sort((a, b) =>
      (a.opera_name ?? '').toLowerCase().localeCompare(
        (b.opera_name ?? '').toLowerCase(),
      ),
    );

    const mandates = filtered.map(rowToMandate);
    return { success: true, mandates, count: mandates.length };
  } catch (err: any) {
    return {
      success: false,
      mandates: [],
      count: 0,
      error: err?.message ?? String(err),
    };
  }
}

// ---------------------------------------------------------------------
// link — upsert (opera_account, mandate_id) row
// ---------------------------------------------------------------------

export interface LinkMandateInput {
  operaAccount: string;
  mandateId: string;
  operaName?: string | null;
  gocardlessName?: string | null;
  gocardlessCustomerId?: string | null;
  mandateStatus?: string;
  scheme?: string;
  email?: string | null;
}

export interface LinkMandateResult {
  success: boolean;
  /** Set when re-linking — caller should also clear sn_analsys on this account. */
  oldOperaAccount?: string | null;
  /** GC's stored opera_name when this mandate was previously linked. */
  gcMandateName?: string | null;
  /** True when caller didn't pass `confirm=true` and a re-link was detected. */
  needsConfirm?: boolean;
  /** Local DB row after the upsert. */
  mandate?: Mandate;
  message?: string;
  error?: string;
}

async function detectRelink(
  appDb: Knex,
  mandateId: string,
  newOperaAccount: string,
): Promise<{ oldAccount: string | null; gcName: string | null }> {
  const rows = (await appDb('gocardless_mandates')
    .where({ mandate_id: mandateId })
    .select('opera_account', 'opera_name')) as unknown as Array<{
    opera_account: string | null;
    opera_name: string | null;
  }>;
  let oldAccount: string | null = null;
  let gcName: string | null = null;
  for (const r of rows ?? []) {
    const acct = (r.opera_account ?? '').trim();
    const nm = (r.opera_name ?? '').trim();
    if (nm) gcName = nm;
    if (acct && acct !== '__UNLINKED__' && acct !== newOperaAccount) {
      oldAccount = acct;
    }
  }
  return { oldAccount, gcName };
}

/**
 * Upsert a (opera_account, mandate_id) link in `gocardless_mandates`.
 * Faithful port of payments_db.link_mandate
 * (sql_rag/gocardless_payments.py:415-482) plus the route-side
 * relink confirmation guard from
 * apps/gocardless/api/routes.py:6657-6792.
 *
 * Behaviour:
 *   - When the same mandate is currently linked to a *different*
 *     non-__UNLINKED__ account, requires `confirm=true` to proceed.
 *   - On confirmed relink, removes the old row first, then upserts.
 *   - Always removes any __UNLINKED__ placeholder for this mandate.
 *   - Updates an existing (account, mandate) row if one exists; else
 *     inserts. COALESCE-style: optional fields preserved when not
 *     supplied.
 */
export async function linkMandate(
  appDb: Knex,
  input: LinkMandateInput & { confirm?: boolean },
): Promise<LinkMandateResult> {
  const operaAccount = (input.operaAccount ?? '').trim();
  const mandateId = (input.mandateId ?? '').trim();
  if (!operaAccount || !mandateId) {
    return { success: false, error: 'opera_account and mandate_id are required' };
  }

  // 1. Detect re-link
  const { oldAccount, gcName } = await detectRelink(appDb, mandateId, operaAccount);
  if (oldAccount && !input.confirm) {
    return {
      success: false,
      needsConfirm: true,
      oldOperaAccount: oldAccount,
      gcMandateName: gcName,
      error:
        `This mandate is currently linked to ${oldAccount}. ` +
        `Are you sure you want to reassign it to ${operaAccount}?`,
    };
  }

  try {
    // 2. Drop the old (different-account) row when re-linking
    if (oldAccount) {
      await appDb('gocardless_mandates')
        .where({ mandate_id: mandateId, opera_account: oldAccount })
        .delete();
    }

    // 3. Remove __UNLINKED__ placeholder for this mandate
    if (operaAccount !== '__UNLINKED__') {
      await appDb('gocardless_mandates')
        .where({ mandate_id: mandateId, opera_account: '__UNLINKED__' })
        .delete();
    }

    // 4. Upsert (opera_account, mandate_id)
    const existing = (await appDb('gocardless_mandates')
      .where({ opera_account: operaAccount, mandate_id: mandateId })
      .first()) as unknown as { id: number | null } | undefined;

    const baseFields: Record<string, unknown> = {
      mandate_status: input.mandateStatus ?? 'active',
      scheme: input.scheme ?? 'bacs',
      updated_at: appDb.fn.now(),
    };
    if (input.operaName !== undefined && input.operaName !== null) {
      baseFields.opera_name = input.operaName;
    }
    if (input.gocardlessName !== undefined && input.gocardlessName !== null) {
      baseFields.gocardless_name = input.gocardlessName;
    }
    if (
      input.gocardlessCustomerId !== undefined &&
      input.gocardlessCustomerId !== null
    ) {
      baseFields.gocardless_customer_id = input.gocardlessCustomerId;
    }
    if (input.email !== undefined && input.email !== null) {
      baseFields.email = input.email;
    }

    if (existing) {
      await appDb('gocardless_mandates')
        .where({ id: existing.id })
        .update(baseFields);
    } else {
      await appDb('gocardless_mandates').insert({
        opera_account: operaAccount,
        mandate_id: mandateId,
        opera_name: input.operaName ?? null,
        gocardless_name: input.gocardlessName ?? null,
        gocardless_customer_id: input.gocardlessCustomerId ?? null,
        mandate_status: input.mandateStatus ?? 'active',
        scheme: input.scheme ?? 'bacs',
        email: input.email ?? null,
      });
    }

    const fresh = (await appDb('gocardless_mandates')
      .where({ opera_account: operaAccount, mandate_id: mandateId })
      .first()) as unknown as MandateRow | undefined;
    return {
      success: true,
      oldOperaAccount: oldAccount,
      gcMandateName: gcName,
      message: `Mandate ${mandateId} linked to Opera customer ${operaAccount}`,
      mandate: fresh ? rowToMandate(fresh) : undefined,
    };
  } catch (err: any) {
    return { success: false, error: err?.message ?? String(err) };
  }
}

// ---------------------------------------------------------------------
// syncMandatesFromGocardless — pull every mandate via the API and
// auto-link to GC-tagged Opera customers by normalised name match.
// ---------------------------------------------------------------------

export interface RemoteMandate {
  id?: string;
  status?: string;
  scheme?: string;
  links?: { customer?: string };
  [k: string]: unknown;
}

export interface RemoteCustomerLite {
  company_name?: string;
  given_name?: string;
  family_name?: string;
  email?: string;
}

export interface OperaGcCustomer {
  account: string;
  name: string;
  email?: string | null;
}

export interface SyncMandatesPage {
  mandates: RemoteMandate[];
  after: string | null;
}

export interface SyncMandatesResponse {
  success: boolean;
  message?: string;
  synced_count?: number;
  new_count?: number;
  updated_count?: number;
  auto_linked_count?: number;
  error?: string;
}

const COMPANY_SUFFIXES = [
  ' LTD',
  ' LIMITED',
  ' PLC',
  ' INC',
  ' LLC',
  ' CO',
  ' COMPANY',
];

export function normaliseCompanyName(name: string | null | undefined): string {
  if (!name) return '';
  let n = String(name).toUpperCase().trim();
  for (const suffix of COMPANY_SUFFIXES) {
    if (n.endsWith(suffix)) {
      n = n.slice(0, n.length - suffix.length);
    }
  }
  return n.trim();
}

export function findOperaCustomerMatch(
  gcName: string | null | undefined,
  customers: OperaGcCustomer[],
): OperaGcCustomer | null {
  const normGc = normaliseCompanyName(gcName);
  if (!normGc) return null;
  for (const c of customers) {
    if (normaliseCompanyName(c.name) === normGc) return c;
  }
  for (const c of customers) {
    const normOpera = normaliseCompanyName(c.name);
    if (normOpera && (normGc.includes(normOpera) || normOpera.includes(normGc))) {
      return c;
    }
  }
  return null;
}

/**
 * Faithful port of sync_gocardless_mandates
 * (apps/gocardless/api/routes.py:6450-6654). For each remote mandate:
 *   - Fetch the GC customer (when there's a linked customer_id)
 *   - If we already have a row for this mandate_id:
 *       * linked → update status/scheme/email
 *       * unlinked (__UNLINKED__) → try auto-match; if matched, link;
 *         else update placeholder
 *   - Else (new):
 *       * Try auto-match; if matched, link; else insert __UNLINKED__
 *         placeholder.
 *
 * Cleanup pass at the end: drops any __UNLINKED__ row when a linked
 * row exists for the same mandate_id.
 */
export async function syncMandatesFromGocardless(
  appDb: Knex,
  fetchPage: (cursor: string | null) => Promise<SyncMandatesPage>,
  fetchCustomer: (
    customerId: string,
  ) => Promise<RemoteCustomerLite | null>,
  operaCustomers: OperaGcCustomer[],
): Promise<SyncMandatesResponse> {
  try {
    let synced = 0;
    let newCount = 0;
    let updated = 0;
    let autoLinked = 0;

    let cursor: string | null = null;
    while (true) {
      const page = await fetchPage(cursor);
      if (!page.mandates || page.mandates.length === 0) break;
      for (const m of page.mandates) {
        const mandateId = (m.id ?? '').toString().trim();
        if (!mandateId) continue;
        const status = (m.status ?? 'active').toString();
        const scheme = (m.scheme ?? 'bacs').toString();
        const customerId = (m.links?.customer ?? '').toString().trim();
        let gcName: string | null = null;
        let gcEmail: string | null = null;
        if (customerId) {
          try {
            const cust = await fetchCustomer(customerId);
            if (cust) {
              gcName =
                cust.company_name ||
                `${cust.given_name ?? ''} ${cust.family_name ?? ''}`.trim() ||
                null;
              gcEmail = cust.email ?? null;
            }
          } catch {
            // Best-effort — match Python's behaviour
          }
        }

        // Lookup any existing row(s) for this mandate_id (prefer linked)
        const rows = (await appDb('gocardless_mandates')
          .where({ mandate_id: mandateId })
          .select('opera_account', 'opera_name')) as unknown as Array<{
          opera_account: string | null;
          opera_name: string | null;
        }>;
        let existingAccount: string | null = null;
        let existingName: string | null = null;
        for (const row of rows ?? []) {
          const acct = (row.opera_account ?? '').trim();
          if (acct && acct !== '__UNLINKED__') {
            existingAccount = acct;
            existingName = (row.opera_name ?? '').trim() || null;
            break;
          }
          if (acct === '__UNLINKED__' && existingAccount === null) {
            existingAccount = '__UNLINKED__';
            existingName = (row.opera_name ?? '').trim() || null;
          }
        }

        if (existingAccount && existingAccount !== '__UNLINKED__') {
          // Already linked — refresh status/scheme/email
          const r = await linkMandate(appDb, {
            operaAccount: existingAccount,
            mandateId,
            operaName: existingName,
            gocardlessName: gcName,
            gocardlessCustomerId: customerId || null,
            mandateStatus: status,
            scheme,
            email: gcEmail,
            confirm: true,
          });
          if (r.success) updated += 1;
        } else if (existingAccount === '__UNLINKED__') {
          // Existing placeholder — try to upgrade to a real link
          const match = findOperaCustomerMatch(gcName, operaCustomers);
          if (match) {
            const r = await linkMandate(appDb, {
              operaAccount: match.account,
              mandateId,
              operaName: match.name,
              gocardlessName: gcName,
              gocardlessCustomerId: customerId || null,
              mandateStatus: status,
              scheme,
              email: gcEmail ?? match.email ?? null,
              confirm: true,
            });
            if (r.success) {
              autoLinked += 1;
            }
          } else {
            // Stay unlinked — refresh metadata
            const r = await linkMandate(appDb, {
              operaAccount: '__UNLINKED__',
              mandateId,
              operaName: gcName,
              gocardlessName: gcName,
              gocardlessCustomerId: customerId || null,
              mandateStatus: status,
              scheme,
              email: gcEmail,
              confirm: true,
            });
            if (r.success) updated += 1;
          }
        } else {
          // No prior row — try auto-match, else placeholder
          const match = findOperaCustomerMatch(gcName, operaCustomers);
          if (match) {
            const r = await linkMandate(appDb, {
              operaAccount: match.account,
              mandateId,
              operaName: match.name,
              gocardlessName: gcName,
              gocardlessCustomerId: customerId || null,
              mandateStatus: status,
              scheme,
              email: gcEmail ?? match.email ?? null,
              confirm: true,
            });
            if (r.success) {
              autoLinked += 1;
              newCount += 1;
            }
          } else {
            const r = await linkMandate(appDb, {
              operaAccount: '__UNLINKED__',
              mandateId,
              operaName: gcName,
              gocardlessName: gcName,
              gocardlessCustomerId: customerId || null,
              mandateStatus: status,
              scheme,
              email: gcEmail,
              confirm: true,
            });
            if (r.success) newCount += 1;
          }
        }
        synced += 1;
      }
      if (!page.after) break;
      cursor = page.after;
    }

    // Cleanup: remove __UNLINKED__ duplicates where a linked row exists
    const allRows = (await appDb('gocardless_mandates').select(
      'id',
      'mandate_id',
      'opera_account',
    )) as unknown as Array<{
      id: number;
      mandate_id: string | null;
      opera_account: string | null;
    }>;
    const linkedSet = new Set<string>();
    for (const r of allRows ?? []) {
      const mid = (r.mandate_id ?? '').trim();
      const acct = (r.opera_account ?? '').trim();
      if (mid && acct && acct !== '__UNLINKED__') linkedSet.add(mid);
    }
    for (const r of allRows ?? []) {
      const mid = (r.mandate_id ?? '').trim();
      const acct = (r.opera_account ?? '').trim();
      if (mid && acct === '__UNLINKED__' && linkedSet.has(mid)) {
        await appDb('gocardless_mandates').where({ id: r.id }).delete();
      }
    }

    let message = `Synced ${synced} mandates from GoCardless`;
    if (autoLinked > 0) message += ` (${autoLinked} auto-linked to Opera)`;
    if (newCount > 0) message += `, ${newCount} new`;
    if (updated > 0) message += `, ${updated} updated`;

    return {
      success: true,
      message,
      synced_count: synced,
      new_count: newCount,
      updated_count: updated,
      auto_linked_count: autoLinked,
    };
  } catch (err: any) {
    return { success: false, error: err?.message ?? String(err) };
  }
}

// ---------------------------------------------------------------------
// cancel — GoCardless API + local status update
// ---------------------------------------------------------------------

export interface CancelMandateResponse {
  success: boolean;
  message?: string;
  status?: string;
  error?: string;
}

export async function cancelMandate(
  appDb: Knex,
  mandateId: string,
  cancelRemote?: (
    id: string,
  ) => Promise<{ success: boolean; status?: string; error?: string; alreadyCancelled?: boolean }>,
): Promise<CancelMandateResponse> {
  const id = (mandateId ?? '').trim();
  if (!id) return { success: false, error: 'mandate_id is required' };

  // 1. Try GoCardless API cancel (when client passed). On failure
  //    don't update local — caller must retry.
  let gcStatus = 'cancelled';
  if (cancelRemote) {
    const r = await cancelRemote(id);
    if (!r.success) {
      return { success: false, error: r.error ?? 'Remote cancel failed' };
    }
    gcStatus = r.status ?? 'cancelled';
  }

  // 2. Update local mandate_status
  try {
    const updated = await appDb('gocardless_mandates')
      .where({ mandate_id: id })
      .update({
        mandate_status: gcStatus,
        updated_at: appDb.fn.now(),
      });
    if (!Number(updated)) {
      return { success: false, error: 'Mandate not found' };
    }
    return {
      success: true,
      message: `Mandate ${id} cancelled`,
      status: gcStatus,
    };
  } catch (err: any) {
    return { success: false, error: err?.message ?? String(err) };
  }
}

// ---------------------------------------------------------------------
// unlink — local-only, removes Opera linking
// ---------------------------------------------------------------------

export interface UnlinkMandateResponse {
  success: boolean;
  message?: string;
  error?: string;
}

export async function unlinkMandate(
  appDb: Knex,
  mandateId: string,
): Promise<UnlinkMandateResponse> {
  const id = (mandateId ?? '').trim();
  if (!id) return { success: false, error: 'mandate_id is required' };
  try {
    // Set opera_account to __UNLINKED__ to preserve the row's
    // existence (so future syncs don't try to re-create it). Don't
    // delete — mandate-level history matters for audit.
    const updated = await appDb('gocardless_mandates')
      .where({ mandate_id: id })
      .andWhere('opera_account', '!=', '__UNLINKED__')
      .update({
        opera_account: '__UNLINKED__',
        updated_at: appDb.fn.now(),
      });
    if (!Number(updated)) {
      return { success: false, error: 'Mandate not found' };
    }
    return { success: true, message: `Mandate ${id} unlinked` };
  } catch (err: any) {
    return { success: false, error: err?.message ?? String(err) };
  }
}

export async function listUnlinkedMandates(
  appDb: Knex,
): Promise<ListMandatesResponse> {
  try {
    const rows = (await appDb('gocardless_mandates').where({
      opera_account: '__UNLINKED__',
    })) as unknown as MandateRow[];

    rows.sort((a, b) =>
      (a.opera_name ?? '').toLowerCase().localeCompare(
        (b.opera_name ?? '').toLowerCase(),
      ),
    );

    const mandates = rows.map(rowToMandate);
    return { success: true, mandates, count: mandates.length };
  } catch (err: any) {
    return {
      success: false,
      mandates: [],
      count: 0,
      error: err?.message ?? String(err),
    };
  }
}
