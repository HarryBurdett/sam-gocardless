import { describe, it, expect } from 'vitest';
import { getCustomerEmail } from '../src/services/customer-email.js';

interface SnameRow {
  sn_account: string;
  name?: string | null;
  email?: string | null;
  contact?: string | null;
}

function makeOperaDb(rows: SnameRow[]): any {
  const db: any = (table: string) => {
    if (table !== 'sname') throw new Error(`Unexpected table: ${table}`);
    let acct: string | null = null;
    const builder: any = {
      whereRaw: (_sql: string, args: any[]) => {
        acct = args?.[0] ?? null;
        return builder;
      },
      select: (..._cols: any[]) => builder,
      first: async () => {
        const match = rows.find((r) => r.sn_account.trim() === acct);
        if (!match) return undefined;
        return {
          name: match.name ?? null,
          email: match.email ?? null,
          contact: match.contact ?? null,
        };
      },
    };
    return builder;
  };
  db.raw = (s: string) => s;
  return db;
}

describe('getCustomerEmail', () => {
  it('returns email + name + contact for a matching account', async () => {
    const operaDb = makeOperaDb([
      {
        sn_account: 'CUST01',
        name: 'Acme Ltd ',
        email: 'a@example.com  ',
        contact: 'Jane Doe',
      },
    ]);
    const result = await getCustomerEmail(operaDb, 'CUST01');
    expect(result.success).toBe(true);
    expect(result.name).toBe('Acme Ltd');
    expect(result.email).toBe('a@example.com');
    expect(result.contact).toBe('Jane Doe');
  });

  it('returns success=true with empty fields when no row matches', async () => {
    const operaDb = makeOperaDb([]);
    const result = await getCustomerEmail(operaDb, 'NOPE');
    expect(result.success).toBe(true);
    expect(result.email).toBe('');
    expect(result.name).toBe('');
  });

  it('handles null email/name gracefully', async () => {
    const operaDb = makeOperaDb([
      { sn_account: 'CUST01', name: null, email: null, contact: null },
    ]);
    const result = await getCustomerEmail(operaDb, 'CUST01');
    expect(result.success).toBe(true);
    expect(result.email).toBe('');
    expect(result.name).toBe('');
    expect(result.contact).toBe('');
  });

  it('returns empty for empty account input', async () => {
    const operaDb = makeOperaDb([{ sn_account: 'CUST01', email: 'x@y.com' }]);
    const result = await getCustomerEmail(operaDb, '   ');
    expect(result.success).toBe(true);
    expect(result.email).toBe('');
  });

  it('reports DB errors', async () => {
    const operaDb: any = (_table: string) => {
      const builder: any = {
        whereRaw: () => builder,
        select: () => builder,
        first: () => Promise.reject(new Error('Connection refused')),
      };
      return builder;
    };
    operaDb.raw = (s: string) => s;
    const result = await getCustomerEmail(operaDb, 'CUST01');
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/Connection refused/);
  });
});
