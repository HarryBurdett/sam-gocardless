/**
 * Tests for buildOperaAwareImportLock.
 *
 * The MSSQL applock path needs a real SQL Server to be exercised
 * end-to-end (sp_getapplock isn't a SQLite construct), so the cases
 * here cover:
 *   - the in-memory fallback when getOperaDb() returns null (the
 *     opera-3 / noop path);
 *   - the basic acquire/release contract (acquire then release;
 *     double-acquire returns false; release-without-acquire is a
 *     no-op);
 *   - the result-parser that pulls the sp_getapplock return value
 *     out of Knex+tedious's response shape.
 *
 * The MSSQL path is verified manually against the live Opera SQL
 * Server (see README → "Behind a reverse proxy" / smoke-test).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  buildOperaAwareImportLock,
  parseApplockResult,
  _resetFallbackLocksForTests,
} from '../import-lock-mssql.js';

const silentLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
};

beforeEach(() => {
  _resetFallbackLocksForTests();
});

describe('buildOperaAwareImportLock — in-memory fallback', () => {
  it('acquires successfully when no Opera DB is configured', async () => {
    const lock = buildOperaAwareImportLock('intsys', () => null, silentLogger);
    expect(await lock.acquire('gocardless:BC010', 'tester')).toBe(true);
  });

  it('refuses a second acquire for the same key before release', async () => {
    const lock = buildOperaAwareImportLock('intsys', () => null, silentLogger);
    expect(await lock.acquire('gocardless:BC010', 'tester')).toBe(true);
    expect(await lock.acquire('gocardless:BC010', 'tester')).toBe(false);
  });

  it('releases the lock and a fresh acquire succeeds', async () => {
    const lock = buildOperaAwareImportLock('intsys', () => null, silentLogger);
    await lock.acquire('gocardless:BC010', 'tester');
    await lock.release('gocardless:BC010');
    expect(await lock.acquire('gocardless:BC010', 'tester')).toBe(true);
  });

  it('release without a matching acquire is a no-op', async () => {
    const lock = buildOperaAwareImportLock('intsys', () => null, silentLogger);
    await expect(lock.release('never-acquired')).resolves.toBeUndefined();
  });

  it('two adapter instances for the SAME company serialise on the same key', async () => {
    const a = buildOperaAwareImportLock('intsys', () => null, silentLogger);
    const b = buildOperaAwareImportLock('intsys', () => null, silentLogger);
    expect(await a.acquire('gocardless:BC010', 'a')).toBe(true);
    expect(await b.acquire('gocardless:BC010', 'b')).toBe(false);
    await a.release('gocardless:BC010');
    expect(await b.acquire('gocardless:BC010', 'b')).toBe(true);
  });

  it('two adapter instances for DIFFERENT companies do not collide on the same bank code', async () => {
    // intsys and z_demo both use BC010 in legacy data. With the
    // company-namespace prefix they should now be independent.
    const intsys = buildOperaAwareImportLock('intsys', () => null, silentLogger);
    const zDemo = buildOperaAwareImportLock('z_demo', () => null, silentLogger);
    expect(await intsys.acquire('gocardless:BC010', 'a')).toBe(true);
    expect(await zDemo.acquire('gocardless:BC010', 'b')).toBe(true);
    await intsys.release('gocardless:BC010');
    await zDemo.release('gocardless:BC010');
  });

  it('different keys do not collide', async () => {
    const lock = buildOperaAwareImportLock('intsys', () => null, silentLogger);
    expect(await lock.acquire('gocardless:BC010', 'a')).toBe(true);
    expect(await lock.acquire('gocardless:BC020', 'b')).toBe(true);
  });
});

describe('parseApplockResult', () => {
  it('reads { r: 0 } from a flat row array (granted immediately)', () => {
    expect(parseApplockResult([{ r: 0 }])).toBe(0);
  });

  it('reads { r: -1 } from a flat row array (would-block under @LockTimeout=0)', () => {
    expect(parseApplockResult([{ r: -1 }])).toBe(-1);
  });

  it('reads { r: 1 } from a wrapped recordset', () => {
    expect(parseApplockResult([[{ r: 1 }]])).toBe(1);
  });

  it('reads { r } from a tedious-style { recordset } object', () => {
    expect(parseApplockResult({ recordset: [{ r: 0 }] })).toBe(0);
  });

  it('returns -999 (treated as failure) when the shape is unrecognised', () => {
    expect(parseApplockResult(null)).toBe(-999);
    expect(parseApplockResult([])).toBe(-999);
    expect(parseApplockResult([{ wrong: 0 }])).toBe(-999);
  });
});
