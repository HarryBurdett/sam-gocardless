import { describe, it, expect, beforeEach, afterAll } from 'vitest';
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
  delete process.env.DATABASE_PATH;
  delete process.env.LOGIN_PASSWORD;
  delete process.env.SESSION_SECRET;
  delete process.env.OPERA_ADAPTER;
  tmpHome = mkdtempSync(join(tmpdir(), 'sgc-config-'));
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
    const cfg = loadConfig({ dataDir: tmpHome });
    expect(cfg.port).toBe(3000);
    expect(cfg.databasePath).toBe(join(tmpHome, 'gocardless.sqlite'));
    expect(cfg.loginPassword).toBe('secret');
    expect(cfg.operaAdapter).toBe('noop');
    expect(cfg.sessionSecret).toMatch(/^[0-9a-f]{64}$/);
  });

  it('respects PORT and OPERA_ADAPTER overrides', () => {
    process.env.LOGIN_PASSWORD = 'secret';
    process.env.PORT = '4000';
    process.env.OPERA_ADAPTER = 'noop';
    const cfg = loadConfig({ dataDir: tmpHome });
    expect(cfg.port).toBe(4000);
    expect(cfg.operaAdapter).toBe('noop');
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

  it('cleans up tmp dirs', () => {
    rmSync(tmpHome, { recursive: true, force: true });
  });
});
