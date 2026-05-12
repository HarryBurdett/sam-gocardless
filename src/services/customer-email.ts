/**
 * GoCardless customer-email lookup.
 *
 * Faithful port of get_customer_email_for_mandate
 * (apps/gocardless/api/routes.py:7189-7217). Reads sname for the
 * given account and returns the email + name + contact, used by
 * the mandate setup form to pre-fill customer details.
 *
 * Returns success=true with empty fields when the customer cannot
 * be found (the Python source preserves this graceful-empty
 * behaviour so the form still loads).
 */
import type { Knex } from 'knex';

export interface CustomerEmailResponse {
  success: boolean;
  email: string;
  name: string;
  contact?: string;
  error?: string;
}

export async function getCustomerEmail(
  operaDb: Knex,
  account: string,
): Promise<CustomerEmailResponse> {
  const acct = (account ?? '').trim();
  if (!acct) {
    return { success: true, email: '', name: '' };
  }
  try {
    const row = (await operaDb('sname')
      .whereRaw('LTRIM(RTRIM(sn_account)) = ?', [acct])
      .select(
        operaDb.raw('RTRIM(sn_name) AS name'),
        operaDb.raw('RTRIM(sn_email) AS email'),
        operaDb.raw('RTRIM(sn_contact) AS contact'),
      )
      .first()) as unknown as
      | { name: string | null; email: string | null; contact: string | null }
      | undefined;
    if (!row) {
      return { success: true, email: '', name: '' };
    }
    return {
      success: true,
      email: (row.email ?? '').trim(),
      name: (row.name ?? '').trim(),
      contact: (row.contact ?? '').trim(),
    };
  } catch (err: any) {
    return {
      success: false,
      email: '',
      name: '',
      error: err?.message ?? String(err),
    };
  }
}
