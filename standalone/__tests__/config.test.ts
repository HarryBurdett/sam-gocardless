import { describe, it, expect, beforeEach, afterEach, afterAll } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../config.js';

const originalEnv = { ...process.env };
let tmpHome: string;

beforeEach(() => {
  process.env = { ...originalEnv };
  // Wipe vars under test
  delete process.env.PORT;
  delete process.env.DATA_ROOT;
  delete process.env.LEGACY_DATA_ROOT;
  delete process.env.LOGIN_PASSWORD;
  delete process.env.SESSION_SECRET;
  delete process.env.OPERA_ADAPTER;
  delete process.env.OPERA_SQL_HOST;
  delete process.env.OPERA_SQL_PORT;
  delete process.env.OPERA_SQL_USER;
  delete process.env.OPERA_SQL_PASSWORD;
  delete process.env.OPERA_SQL_TRUST_CERT;
  delete process.env.OPERA_SQL_ENCRYPT;
  delete process.env.LEGACY_COMPANIES_DIR;
  delete process.env.TRUST_PROXY;
  tmpHome = mkdtempSync(join(tmpdir(), 'sgc-config-'));
});

afterEach(() => {
  rmSync(tmpHome, { recursive: true, force: true });
});

afterAll(() => {
  process.env = originalEnv;
});

describe('loadConfig', () => {
  it('throws when LOGIN_PASSWORD is unset', () => {
    expect(() => loadConfig({ dataDir: tmpHome })).toThrow(/LOGIN_PASSWORD/);
  });

  it('throws when LOGIN_PASSWORD is empty', () => {
    process.env.LOGIN_PASSWORD = '';
    expect(() => loadConfig({ dataDir: tmpHome })).toThrow(/LOGIN_PASSWORD/);
  });

  it('returns defaults when only LOGIN_PASSWORD is set', () => {
    process.env.LOGIN_PASSWORD = 'secret';
    process.env.DATA_ROOT = tmpHome;
    const cfg = loadConfig({ dataDir: tmpHome });
    expect(cfg.port).toBe(3000);
    expect(cfg.dataRoot).toBe(tmpHome);
    expect(cfg.legacyDataRoot).toBeNull();
    expect(cfg.legacyCompaniesDir).toBeNull();
    expect(cfg.loginPassword).toBe('secret');
    expect(cfg.operaAdapter).toBe('noop');
    expect(cfg.mssql).toBeNull();
    expect(cfg.trustProxy).toBe('loopback, linklocal, uniquelocal');
    expect(cfg.sessionSecret).toMatch(/^[0-9a-f]{64}$/);
  });

  it('throws when OPERA_ADAPTER=mssql without connection env vars', () => {
    process.env.LOGIN_PASSWORD = 'secret';
    process.env.OPERA_ADAPTER = 'mssql';
    expect(() => loadConfig({ dataDir: tmpHome })).toThrow(/OPERA_SQL_HOST/);
  });

  it('loads MSSQL env when OPERA_ADAPTER=mssql', () => {
    process.env.LOGIN_PASSWORD = 'secret';
    process.env.OPERA_ADAPTER = 'mssql';
    process.env.OPERA_SQL_HOST = 'opera.example.com';
    process.env.OPERA_SQL_USER = 'sa';
    process.env.OPERA_SQL_PASSWORD = 'secret-pw';
    process.env.OPERA_SQL_PORT = '1434';
    process.env.OPERA_SQL_TRUST_CERT = 'true';
    process.env.OPERA_SQL_ENCRYPT = 'false';
    const cfg = loadConfig({ dataDir: tmpHome });
    expect(cfg.operaAdapter).toBe('mssql');
    expect(cfg.mssql).toEqual({
      host: 'opera.example.com',
      user: 'sa',
      password: 'secret-pw',
      port: 1434,
      trustServerCertificate: true,
      encrypt: false,
    });
  });

  it('defaults legacyCompaniesDir to <LEGACY_DATA_ROOT>/../companies', () => {
    process.env.LOGIN_PASSWORD = 'secret';
    process.env.LEGACY_DATA_ROOT = '/abs/path/data';
    const cfg = loadConfig({ dataDir: tmpHome });
    expect(cfg.legacyCompaniesDir).toBe('/abs/path/companies');
  });

  it('respects PORT, OPERA_ADAPTER, and LEGACY_DATA_ROOT overrides', () => {
    process.env.LOGIN_PASSWORD = 'secret';
    process.env.PORT = '4000';
    process.env.OPERA_ADAPTER = 'noop';
    process.env.DATA_ROOT = tmpHome;
    process.env.LEGACY_DATA_ROOT = '/tmp/legacy-data';
    const cfg = loadConfig({ dataDir: tmpHome });
    expect(cfg.port).toBe(4000);
    expect(cfg.operaAdapter).toBe('noop');
    expect(cfg.legacyDataRoot).toBe('/tmp/legacy-data');
  });

  it('respects TRUST_PROXY override', () => {
    process.env.LOGIN_PASSWORD = 'secret';
    process.env.TRUST_PROXY = '1';
    const cfg = loadConfig({ dataDir: tmpHome });
    expect(cfg.trustProxy).toBe('1');
  });

  it('persists a generated SESSION_SECRET to disk', () => {
    process.env.LOGIN_PASSWORD = 'secret';
    const cfg1 = loadConfig({ dataDir: tmpHome });
    const secretFile = join(tmpHome, '.session-secret');
    expect(existsSync(secretFile)).toBe(true);
    expect(readFileSync(secretFile, 'utf8').trim()).toBe(cfg1.sessionSecret);

    // Loading again returns the same secret
    const cfg2 = loadConfig({ dataDir: tmpHome });
    expect(cfg2.sessionSecret).toBe(cfg1.sessionSecret);
  });

  it('uses SESSION_SECRET env var if provided', () => {
    process.env.LOGIN_PASSWORD = 'secret';
    process.env.SESSION_SECRET = 'explicit-secret';
    const cfg = loadConfig({ dataDir: tmpHome });
    expect(cfg.sessionSecret).toBe('explicit-secret');
  });

});
