import { describe, it, expect } from 'vitest';
import { archiveGocardlessEmail } from '../src/services/archive-email.js';

interface ImportRow {
  id: number;
  email_id: number | null;
  target_system: string;
  bank_reference: string | null;
  gross_amount: number;
  net_amount: number;
  payment_count: number;
  source: string;
  imported_by: string | null;
  imported_at: string;
}

interface MockState {
  rows: ImportRow[];
  nextId: number;
  raiseOnInsert?: boolean;
}

function makeAppDb(state: MockState): any {
  const db: any = (table: string) => {
    if (table !== 'gocardless_imports') {
      throw new Error(`Unexpected table: ${table}`);
    }
    const builder: any = {
      insert: (row: Partial<ImportRow>) => {
        if (state.raiseOnInsert) {
          return Promise.reject(new Error('insert failed'));
        }
        const id = state.nextId++;
        state.rows.push({
          id,
          email_id: (row.email_id as number) ?? null,
          target_system: String(row.target_system ?? ''),
          bank_reference: (row.bank_reference as string) ?? null,
          gross_amount: Number(row.gross_amount ?? 0),
          net_amount: Number(row.net_amount ?? 0),
          payment_count: Number(row.payment_count ?? 0),
          source: String(row.source ?? 'email'),
          imported_by: (row.imported_by as string) ?? null,
          imported_at: new Date().toISOString(),
        });
        return Promise.resolve([id]);
      },
    };
    return builder;
  };
  db.fn = { now: () => new Date() };
  return db;
}

describe('archiveGocardlessEmail', () => {
  it('rejects missing email_id', async () => {
    const result = await archiveGocardlessEmail(
      makeAppDb({ rows: [], nextId: 1 }),
      { emailId: NaN as any },
    );
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/email_id/);
  });

  it('rejects email_id <= 0', async () => {
    const result = await archiveGocardlessEmail(
      makeAppDb({ rows: [], nextId: 1 }),
      { emailId: 0 },
    );
    expect(result.success).toBe(false);
  });

  it('records tracking row with target_system=archived', async () => {
    const state: MockState = { rows: [], nextId: 1 };
    const result = await archiveGocardlessEmail(makeAppDb(state), {
      emailId: 42,
    });
    expect(result.success).toBe(true);
    expect(result.email_id).toBe(42);
    expect(result.archive_status).toBe('not_attempted'); // no emailIngest passed
    expect(state.rows).toHaveLength(1);
    expect(state.rows[0]).toMatchObject({
      email_id: 42,
      target_system: 'archived',
      bank_reference: 'ARCHIVED',
      gross_amount: 0,
      net_amount: 0,
      payment_count: 0,
      source: 'email',
      imported_by: 'ARCHIVE',
    });
  });

  it('reports provider_not_available when emailIngest passed (no moveEmail today)', async () => {
    const state: MockState = { rows: [], nextId: 1 };
    const fakeIngest = {
      claimMailbox: () => Promise.resolve({}),
      releaseMailbox: () => Promise.resolve(),
      listMyMailboxes: () => Promise.resolve([]),
      registerHandler: () => () => {},
      fetchAttachment: () =>
        Promise.resolve({ bytes: Buffer.from(''), name: '', contentType: '' }),
      getAttachmentText: () =>
        Promise.resolve({ name: '', contentType: '', text: '', truncated: false }),
      onOwnershipChange: () => () => {},
      onActivityChange: () => () => {},
    };
    const result = await archiveGocardlessEmail(
      makeAppDb(state),
      { emailId: 99, archiveFolder: 'Archive/GoCardless' },
      fakeIngest,
    );
    expect(result.success).toBe(true);
    expect(result.archive_status).toBe('provider_not_available');
    expect(state.rows).toHaveLength(1);
  });

  it('returns error when DB insert fails AND no move attempted', async () => {
    const state: MockState = { rows: [], nextId: 1, raiseOnInsert: true };
    const result = await archiveGocardlessEmail(makeAppDb(state), {
      emailId: 99,
    });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/Could not record archive/);
  });
});
