import { describe, it, expect } from 'vitest';
import { updateSubscriptionTags } from '../src/services/subscription-tags.js';

interface IheadRow {
  ih_doc: string;
  ih_account: string;
  ih_name: string;
  ih_ignore: string;
  ih_analsys: string | null;
  ih_docstat?: string;
  ih_econtr?: Date | null;
}

interface MockState {
  rows: IheadRow[];
  // Captured raw query info for assertions on the apply path
  lastRawSql?: string;
  lastRawParams?: unknown[];
  // The number rowCount the next .raw() call should report
  applyRowCount?: number;
}

function makeOperaDb(state: MockState): any {
  const rawFn: any = (sql: string, _params?: unknown[]) => sql;

  const db: any = (table: string) => {
    if (table !== 'ihead') {
      throw new Error(`Unexpected table: ${table}`);
    }
    let docstatFilter: string | null = null;
    let frequencies: string[] = [];

    const builder: any = {
      select: () => builder,
      where: (col: string, val: string) => {
        if (col === 'ih_docstat') docstatFilter = val;
        return builder;
      },
      andWhere: (_cb: (qb: unknown) => void) => builder,
      whereRaw: (sql: string, params: unknown[]) => {
        if (sql.includes('RTRIM(ih_ignore)')) {
          frequencies = (params as string[]).slice();
        }
        return builder;
      },
      orderBy: () => builder,
      then: (cb: (rows: IheadRow[]) => unknown) => {
        let rows = state.rows;
        if (docstatFilter) {
          rows = rows.filter((r) => (r.ih_docstat ?? 'U') === docstatFilter);
        }
        if (frequencies.length) {
          rows = rows.filter((r) =>
            frequencies.includes((r.ih_ignore ?? '').trim()),
          );
        }
        return Promise.resolve(cb(rows));
      },
    };
    return builder;
  };

  db.raw = (sql: string, params?: unknown[]) => {
    state.lastRawSql = sql;
    state.lastRawParams = params;
    // Mimic the mssql Knex shape: an object with rowCount
    return Promise.resolve({ rowCount: state.applyRowCount ?? 0 });
  };
  // Allow operaDb.raw inside whereIn (not used after refactor, but keep)
  db.fn = { now: () => 'NOW()' };
  return db;
}

describe('updateSubscriptionTags - preview', () => {
  it('rejects empty tag', async () => {
    const db = makeOperaDb({ rows: [] });
    const result = await updateSubscriptionTags(
      db,
      { subscription_tag: '', subscription_frequencies: ['M'] },
      { mode: 'preview' },
    );
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/tag is not configured/);
  });

  it('rejects empty frequencies', async () => {
    const db = makeOperaDb({ rows: [] });
    const result = await updateSubscriptionTags(
      db,
      { subscription_tag: 'SUB', subscription_frequencies: [] },
      { mode: 'preview' },
    );
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/No frequency filters/);
  });

  it('classifies docs into already_tagged / will_tag / has_different', async () => {
    const state: MockState = {
      rows: [
        { ih_doc: 'D001', ih_account: 'C1', ih_name: 'Cust 1',
          ih_ignore: 'M', ih_analsys: 'SUB' },
        { ih_doc: 'D002', ih_account: 'C2', ih_name: 'Cust 2',
          ih_ignore: 'M', ih_analsys: '' },
        { ih_doc: 'D003', ih_account: 'C3', ih_name: 'Cust 3',
          ih_ignore: 'M', ih_analsys: null },
        { ih_doc: 'D004', ih_account: 'C4', ih_name: 'Cust 4',
          ih_ignore: 'M', ih_analsys: 'OLD' },
        // Frequency-filtered out
        { ih_doc: 'D005', ih_account: 'C5', ih_name: 'Cust 5',
          ih_ignore: 'Q', ih_analsys: '' },
      ],
    };
    const db = makeOperaDb(state);

    const result = await updateSubscriptionTags(
      db,
      { subscription_tag: 'SUB', subscription_frequencies: ['M'] },
      { mode: 'preview' },
    );

    expect(result.success).toBe(true);
    if ('total_matching' in result) {
      expect(result.total_matching).toBe(4);
      expect(result.already_tagged).toBe(1);
      expect(result.will_tag).toBe(2);
      expect(result.has_different).toBe(1);
      expect(result.documents).toHaveLength(4);
      const statuses = result.documents!.map((d) => d.status).sort();
      expect(statuses).toEqual(['already_tagged', 'has_different', 'will_tag', 'will_tag']);
      // Frequency label populated from code
      expect(result.documents![0]?.frequency).toBe('Monthly');
    }
  });

  it('preview does not touch the DB', async () => {
    const state: MockState = { rows: [] };
    const db = makeOperaDb(state);
    await updateSubscriptionTags(
      db,
      { subscription_tag: 'SUB', subscription_frequencies: ['M', 'A'] },
      { mode: 'preview' },
    );
    expect(state.lastRawSql).toBeUndefined();
  });
});

describe('updateSubscriptionTags - apply', () => {
  it('apply without overwrite: SQL only matches blank/null analsys', async () => {
    const state: MockState = { rows: [], applyRowCount: 5 };
    const db = makeOperaDb(state);
    const result = await updateSubscriptionTags(
      db,
      { subscription_tag: 'SUB', subscription_frequencies: ['W', 'M', 'A'] },
      { mode: 'apply', overwrite: false },
    );

    expect(result.success).toBe(true);
    if ('updated' in result) {
      expect(result.updated).toBe(5);
      expect(result.tag).toBe('SUB');
      expect(result.overwrite).toBe(false);
    }

    // SQL should use ROWLOCK + analsys-blank predicate, NOT the != tag predicate
    expect(state.lastRawSql).toMatch(/UPDATE ihead WITH \(ROWLOCK\)/);
    expect(state.lastRawSql).toMatch(/ih_analsys IS NULL OR RTRIM\(ih_analsys\) = ''/);
    expect(state.lastRawSql).not.toMatch(/RTRIM\(ih_analsys\) != /);
    // Params: tag, then 3 frequencies
    expect(state.lastRawParams).toEqual(['SUB', 'W', 'M', 'A']);
  });

  it('apply with overwrite: SQL also matches docs with different analsys', async () => {
    const state: MockState = { rows: [], applyRowCount: 12 };
    const db = makeOperaDb(state);
    const result = await updateSubscriptionTags(
      db,
      { subscription_tag: 'SUB', subscription_frequencies: ['M'] },
      { mode: 'apply', overwrite: true },
    );

    expect(result.success).toBe(true);
    if ('updated' in result) {
      expect(result.updated).toBe(12);
      expect(result.overwrite).toBe(true);
    }

    expect(state.lastRawSql).toMatch(/UPDATE ihead WITH \(ROWLOCK\)/);
    expect(state.lastRawSql).toMatch(/RTRIM\(ih_analsys\) != \?/);
    // Params: tag, freq, tag (the != comparison)
    expect(state.lastRawParams).toEqual(['SUB', 'M', 'SUB']);
  });
});
