import { describe, it, expect } from 'vitest';
import {
  listMandateSetups,
  cancelMandateSetup,
  createMandateSetup,
  checkPendingMandateSetups,
} from '../src/services/mandate-setups.js';

interface SetupRow {
  id: number;
  opera_account: string;
  opera_name: string;
  customer_email: string;
  billing_request_id: string;
  billing_request_flow_id: string;
  authorisation_url: string;
  mandate_id: string;
  gocardless_customer_id: string;
  status: string;
  status_detail: string;
  email_sent_at: string | null;
  mandate_active_at: string | null;
  created_at: string;
  updated_at: string;
}

interface MockState {
  rows: SetupRow[];
}

function makeAppDb(state: MockState): any {
  const db: any = (table: string) => {
    if (table !== 'mandate_setup_requests') {
      throw new Error(`Unexpected table: ${table}`);
    }
    let conds: Record<string, unknown> = {};
    let order: { col: string; dir: 'asc' | 'desc' } | null = null;
    const builder: any = {
      where: (cond: Record<string, unknown>) => {
        Object.assign(conds, cond);
        return builder;
      },
      orderBy: (col: string, dir: 'asc' | 'desc' = 'asc') => {
        order = { col, dir };
        return builder;
      },
      first: () => {
        const found = state.rows.find((r) =>
          Object.entries(conds).every(([k, v]) => (r as any)[k] === v),
        );
        return Promise.resolve(found);
      },
      update: (data: Record<string, unknown>) => {
        let count = 0;
        for (const r of state.rows) {
          if (
            Object.entries(conds).every(([k, v]) => (r as any)[k] === v)
          ) {
            Object.assign(r, data);
            count++;
          }
        }
        return Promise.resolve(count);
      },
      insert: (row: Record<string, unknown>) => {
        const id = (state.rows[state.rows.length - 1]?.id ?? 0) + 1;
        state.rows.push({
          id,
          opera_account: '',
          opera_name: '',
          customer_email: '',
          billing_request_id: '',
          billing_request_flow_id: '',
          authorisation_url: '',
          mandate_id: '',
          gocardless_customer_id: '',
          status: 'pending',
          status_detail: '',
          email_sent_at: null,
          mandate_active_at: null,
          created_at: '2026-04-15',
          updated_at: '2026-04-15',
          ...(row as Partial<SetupRow>),
        });
        return {
          returning: async () => [{ id }],
        };
      },
      then: (cb: (rows: SetupRow[]) => unknown) => {
        let rows = state.rows.filter((r) =>
          Object.entries(conds).every(([k, v]) => (r as any)[k] === v),
        );
        if (order) {
          rows = [...rows].sort((a, b) => {
            const cmp = String((a as any)[order!.col]).localeCompare(
              String((b as any)[order!.col]),
            );
            return order!.dir === 'desc' ? -cmp : cmp;
          });
        }
        return Promise.resolve(cb(rows));
      },
    };
    return builder;
  };
  db.fn = { now: () => new Date() };
  return db;
}

function emptySetup(over: Partial<SetupRow> = {}): SetupRow {
  return {
    id: 1,
    opera_account: 'CUST01',
    opera_name: 'Acme Ltd',
    customer_email: 'a@a.com',
    billing_request_id: 'BR1',
    billing_request_flow_id: '',
    authorisation_url: '',
    mandate_id: '',
    gocardless_customer_id: '',
    status: 'pending',
    status_detail: '',
    email_sent_at: null,
    mandate_active_at: null,
    created_at: '2026-04-15',
    updated_at: '2026-04-15',
    ...over,
  };
}

describe('listMandateSetups', () => {
  it('returns rows in id-desc order', async () => {
    const state: MockState = {
      rows: [
        emptySetup({ id: 1 }),
        emptySetup({ id: 2 }),
        emptySetup({ id: 3 }),
      ],
    };
    const result = await listMandateSetups(makeAppDb(state));
    expect(result.success).toBe(true);
    expect(result.setups[0]?.id).toBe(3);
  });

  it('counts pending (excludes completed/failed/cancelled)', async () => {
    const state: MockState = {
      rows: [
        emptySetup({ id: 1, status: 'pending' }),
        emptySetup({ id: 2, status: 'completed' }),
        emptySetup({ id: 3, status: 'cancelled' }),
        emptySetup({ id: 4, status: 'pending' }),
        emptySetup({ id: 5, status: 'failed' }),
      ],
    };
    const result = await listMandateSetups(makeAppDb(state));
    expect(result.pending_count).toBe(2);
  });
});

describe('cancelMandateSetup', () => {
  it('cancels a pending setup', async () => {
    const state: MockState = {
      rows: [emptySetup({ id: 1, status: 'pending' })],
    };
    const result = await cancelMandateSetup(makeAppDb(state), 1);
    expect(result.success).toBe(true);
    expect(result.message).toMatch(/Acme Ltd/);
    expect(state.rows[0]?.status).toBe('cancelled');
    expect(state.rows[0]?.status_detail).toBe('Cancelled by user');
  });

  it('refuses to cancel a completed setup', async () => {
    const state: MockState = {
      rows: [emptySetup({ id: 1, status: 'completed' })],
    };
    const result = await cancelMandateSetup(makeAppDb(state), 1);
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/already completed/);
  });

  it('returns 404 when setup not found', async () => {
    const state: MockState = { rows: [] };
    const result = await cancelMandateSetup(makeAppDb(state), 999);
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/not found/);
  });

  it('rejects bad setup_id', async () => {
    const state: MockState = { rows: [] };
    const result = await cancelMandateSetup(makeAppDb(state), 0);
    expect(result.success).toBe(false);
  });

  it('falls back to opera_account when opera_name empty', async () => {
    const state: MockState = {
      rows: [emptySetup({ id: 1, opera_name: '', opera_account: 'CUST_X' })],
    };
    const result = await cancelMandateSetup(makeAppDb(state), 1);
    expect(result.message).toMatch(/CUST_X/);
  });
});

describe('createMandateSetup', () => {
  function okRemote(brId = 'BR1', flowId = 'FL1', authUrl = 'https://gocardless/x') {
    return {
      createBillingRequest: async () => ({ success: true, id: brId }),
      createBillingRequestFlow: async (_id: string) => ({
        success: true,
        flowId,
        authorisationUrl: authUrl,
      }),
    };
  }
  const okEmail = async () => ({ success: true });

  it('rejects empty opera_account', async () => {
    const state: MockState = { rows: [] };
    const result = await createMandateSetup(
      makeAppDb(state),
      { operaAccount: '', customerEmail: 'a@b.com' },
      okRemote(),
      okEmail,
    );
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/account/);
  });

  it('rejects empty customer_email', async () => {
    const state: MockState = { rows: [] };
    const result = await createMandateSetup(
      makeAppDb(state),
      { operaAccount: 'CUST01', customerEmail: '' },
      okRemote(),
      okEmail,
    );
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/email/);
  });

  it('rejects malformed email', async () => {
    const state: MockState = { rows: [] };
    const result = await createMandateSetup(
      makeAppDb(state),
      { operaAccount: 'CUST01', customerEmail: 'not-an-email' },
      okRemote(),
      okEmail,
    );
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/Invalid email/);
  });

  it('returns auth URL on success and persists tracking row', async () => {
    const state: MockState = { rows: [] };
    const result = await createMandateSetup(
      makeAppDb(state),
      {
        operaAccount: 'CUST01',
        operaName: 'Acme Ltd',
        customerEmail: 'a@b.com',
      },
      okRemote('BR_X', 'FL_X', 'https://gc/auth/X'),
      okEmail,
    );
    expect(result.success).toBe(true);
    expect(result.authorisation_url).toBe('https://gc/auth/X');
    expect(result.email_sent).toBe(true);
    expect(state.rows).toHaveLength(1);
    expect(state.rows[0]?.billing_request_id).toBe('BR_X');
    expect(state.rows[0]?.status).toBe('email_sent');
  });

  it('marks status=pending + status_detail when email send fails', async () => {
    const state: MockState = { rows: [] };
    const result = await createMandateSetup(
      makeAppDb(state),
      { operaAccount: 'CUST01', customerEmail: 'a@b.com' },
      okRemote(),
      async () => ({ success: false, error: 'SMTP refused connection' }),
    );
    expect(result.success).toBe(true);
    expect(result.email_sent).toBe(false);
    expect(result.email_error).toMatch(/SMTP refused/);
    expect(state.rows[0]?.status).toBe('pending');
    expect(state.rows[0]?.status_detail).toMatch(/SMTP refused/);
  });

  it('returns failure when billing-request creation fails', async () => {
    const state: MockState = { rows: [] };
    const result = await createMandateSetup(
      makeAppDb(state),
      { operaAccount: 'CUST01', customerEmail: 'a@b.com' },
      {
        createBillingRequest: async () => ({
          success: false,
          error: 'GC down',
        }),
        createBillingRequestFlow: async () => ({ success: false }),
      },
      okEmail,
    );
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/GC down/);
    expect(state.rows).toHaveLength(0);
  });

  it('returns failure when flow creation fails', async () => {
    const state: MockState = { rows: [] };
    const result = await createMandateSetup(
      makeAppDb(state),
      { operaAccount: 'CUST01', customerEmail: 'a@b.com' },
      {
        createBillingRequest: async () => ({ success: true, id: 'BR1' }),
        createBillingRequestFlow: async () => ({
          success: false,
          error: 'GC API timeout',
        }),
      },
      okEmail,
    );
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/GC API timeout/);
    expect(state.rows).toHaveLength(0);
  });

  it('substitutes {authorisation_url} placeholder in custom email body', async () => {
    const state: MockState = { rows: [] };
    let captured = { subject: '', body: '' };
    await createMandateSetup(
      makeAppDb(state),
      {
        operaAccount: 'CUST01',
        customerEmail: 'a@b.com',
        emailSubject: 'Custom subject',
        emailBodyHtml:
          '<p>Sign here: <a href="{authorisation_url}">link</a></p>',
      },
      okRemote('BR_X', 'FL_X', 'https://gc/auth/Z'),
      async (opts) => {
        captured.subject = opts.subject;
        captured.body = opts.bodyHtml;
        return { success: true };
      },
    );
    expect(captured.subject).toBe('Custom subject');
    expect(captured.body).toContain('https://gc/auth/Z');
    expect(captured.body).not.toContain('{authorisation_url}');
  });

  it('treats absent email sender as failure (status=pending)', async () => {
    const state: MockState = { rows: [] };
    const result = await createMandateSetup(
      makeAppDb(state),
      { operaAccount: 'CUST01', customerEmail: 'a@b.com' },
      okRemote(),
      undefined,
    );
    expect(result.success).toBe(true);
    expect(result.email_sent).toBe(false);
    expect(result.email_error).toMatch(/No email sender/);
    expect(state.rows[0]?.status).toBe('pending');
  });
});

describe('checkPendingMandateSetups', () => {
  it('returns "No pending setups" message when nothing pending', async () => {
    const state: MockState = {
      rows: [
        emptySetup({
          id: 1,
          status: 'completed',
          billing_request_id: 'BR1',
        }),
      ],
    };
    const remote = {
      getBillingRequest: async () => ({ success: true }),
      getMandate: async () => ({ success: true }),
    };
    const result = await checkPendingMandateSetups(makeAppDb(state), remote);
    expect(result.success).toBe(true);
    expect(result.updates).toHaveLength(0);
    expect(result.message).toMatch(/No pending/);
  });

  it('marks setup completed + invokes completeSetup when mandate active', async () => {
    const state: MockState = {
      rows: [
        emptySetup({
          id: 1,
          status: 'email_sent',
          billing_request_id: 'BR1',
          opera_account: 'CUST01',
          opera_name: 'Acme Ltd',
        }),
      ],
    };
    let completeCalled: any = null;
    const remote = {
      getBillingRequest: async () => ({
        success: true,
        status: 'fulfilled',
        mandateId: 'MD_NEW',
        customerId: 'CU1',
      }),
      getMandate: async () => ({ success: true, status: 'active' }),
    };
    const completeSetup = async (input: any) => {
      completeCalled = input;
      return { success: true };
    };
    const result = await checkPendingMandateSetups(
      makeAppDb(state),
      remote,
      completeSetup,
    );
    expect(result.success).toBe(true);
    expect(state.rows[0]?.status).toBe('completed');
    expect(state.rows[0]?.mandate_id).toBe('MD_NEW');
    expect(state.rows[0]?.gocardless_customer_id).toBe('CU1');
    expect(completeCalled?.mandateId).toBe('MD_NEW');
    expect(result.updates[0]?.new_status).toBe('completed');
  });

  it('marks mandate_created when mandate is pending_customer_approval', async () => {
    const state: MockState = {
      rows: [emptySetup({ id: 1, status: 'email_sent', billing_request_id: 'BR1' })],
    };
    const remote = {
      getBillingRequest: async () => ({
        success: true,
        status: 'fulfilled',
        mandateId: 'MD1',
      }),
      getMandate: async () => ({
        success: true,
        status: 'pending_customer_approval',
      }),
    };
    const result = await checkPendingMandateSetups(makeAppDb(state), remote);
    expect(state.rows[0]?.status).toBe('mandate_created');
    expect(result.updates[0]?.new_status).toBe('mandate_created');
  });

  it('marks failed when mandate is cancelled/expired/failed', async () => {
    const state: MockState = {
      rows: [emptySetup({ id: 1, status: 'email_sent', billing_request_id: 'BR1' })],
    };
    const remote = {
      getBillingRequest: async () => ({
        success: true,
        status: 'fulfilled',
        mandateId: 'MD1',
      }),
      getMandate: async () => ({ success: true, status: 'expired' }),
    };
    const result = await checkPendingMandateSetups(makeAppDb(state), remote);
    expect(state.rows[0]?.status).toBe('failed');
    expect(result.updates[0]?.new_status).toBe('failed');
  });

  it('moves email_sent → authorisation_pending when brq still pending', async () => {
    const state: MockState = {
      rows: [emptySetup({ id: 1, status: 'email_sent', billing_request_id: 'BR1' })],
    };
    const remote = {
      getBillingRequest: async () => ({ success: true, status: 'pending' }),
      getMandate: async () => ({ success: true }),
    };
    const result = await checkPendingMandateSetups(makeAppDb(state), remote);
    expect(state.rows[0]?.status).toBe('authorisation_pending');
    expect(result.updates[0]?.new_status).toBe('authorisation_pending');
  });

  it('marks cancelled when brq itself was cancelled', async () => {
    const state: MockState = {
      rows: [emptySetup({ id: 1, status: 'email_sent', billing_request_id: 'BR1' })],
    };
    const remote = {
      getBillingRequest: async () => ({ success: true, status: 'cancelled' }),
      getMandate: async () => ({ success: true }),
    };
    const result = await checkPendingMandateSetups(makeAppDb(state), remote);
    expect(state.rows[0]?.status).toBe('cancelled');
  });

  it('reports per-row error without aborting the run', async () => {
    const state: MockState = {
      rows: [
        emptySetup({ id: 1, status: 'email_sent', billing_request_id: 'BR1' }),
        emptySetup({ id: 2, status: 'email_sent', billing_request_id: 'BR2' }),
      ],
    };
    let n = 0;
    const remote = {
      getBillingRequest: async () => {
        n++;
        if (n === 1) {
          return { success: false, error: 'GC API down' };
        }
        return { success: true, status: 'cancelled' };
      },
      getMandate: async () => ({ success: true }),
    };
    const result = await checkPendingMandateSetups(makeAppDb(state), remote);
    expect(result.success).toBe(true);
    expect(result.updates).toHaveLength(2);
    expect(result.updates[0]?.error).toMatch(/GC API down/);
    expect(result.updates[1]?.new_status).toBe('cancelled');
  });

  it('does not call completeSetup when remote completion fails (best-effort)', async () => {
    const state: MockState = {
      rows: [emptySetup({ id: 1, status: 'email_sent', billing_request_id: 'BR1' })],
    };
    const remote = {
      getBillingRequest: async () => ({
        success: true,
        status: 'fulfilled',
        mandateId: 'MD1',
      }),
      getMandate: async () => ({ success: true, status: 'active' }),
    };
    const completeSetup = async () => {
      throw new Error('Opera unreachable');
    };
    const result = await checkPendingMandateSetups(
      makeAppDb(state),
      remote,
      completeSetup,
    );
    // Status still marked completed even though Opera link failed
    expect(state.rows[0]?.status).toBe('completed');
    expect(result.success).toBe(true);
  });

  it('skips rows without a billing_request_id', async () => {
    const state: MockState = {
      rows: [emptySetup({ id: 1, status: 'pending', billing_request_id: '' })],
    };
    let called = 0;
    const remote = {
      getBillingRequest: async () => {
        called++;
        return { success: true };
      },
      getMandate: async () => ({ success: true }),
    };
    await checkPendingMandateSetups(makeAppDb(state), remote);
    expect(called).toBe(0);
  });
});
