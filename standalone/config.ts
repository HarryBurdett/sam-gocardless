/**
 * Standalone host configuration loaded from env vars.
 *
 * loadConfig() is pure-ish: it reads env vars + optionally generates a
 * SESSION_SECRET to disk. The `opts.dataDir` parameter exists so tests
 * can point at a tmp dir without touching the repo's ./data.
 */
import { randomBytes } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';

export interface StandaloneConfig {
  port: number;
  databasePath: string;
  loginPassword: string;
  sessionSecret: string;
  operaAdapter: string;
  dataDir: string;
}

export interface LoadConfigOptions {
  /** Defaults to ./data relative to cwd. Tests override this. */
  dataDir?: string;
}

export function loadConfig(opts: LoadConfigOptions = {}): StandaloneConfig {
  const dataDir = opts.dataDir ?? resolve(process.cwd(), 'data');
  mkdirSync(dataDir, { recursive: true });

  const loginPassword = process.env.LOGIN_PASSWORD;
  if (!loginPassword || loginPassword.length === 0) {
    throw new Error(
      'LOGIN_PASSWORD env var is required. Set it to a strong shared password.',
    );
  }

  const port = process.env.PORT ? Number.parseInt(process.env.PORT, 10) : 3000;
  if (!Number.isFinite(port) || port <= 0 || port > 65535) {
    throw new Error(`Invalid PORT: ${process.env.PORT}`);
  }

  const databasePath = process.env.DATABASE_PATH
    ? resolve(process.env.DATABASE_PATH)
    : join(dataDir, 'gocardless.sqlite');
  mkdirSync(dirname(databasePath), { recursive: true });

  const sessionSecret = resolveSessionSecret(dataDir);
  const operaAdapter = process.env.OPERA_ADAPTER ?? 'noop';

  return {
    port,
    databasePath,
    loginPassword,
    sessionSecret,
    operaAdapter,
    dataDir,
  };
}

function resolveSessionSecret(dataDir: string): string {
  if (process.env.SESSION_SECRET && process.env.SESSION_SECRET.length > 0) {
    return process.env.SESSION_SECRET;
  }
  const secretFile = join(dataDir, '.session-secret');
  const existing = tryReadSecret(secretFile);
  if (existing) return existing;

  const generated = randomBytes(32).toString('hex');
  try {
    writeFileSync(secretFile, generated, { mode: 0o600, flag: 'wx' });
    return generated;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
      const racedValue = tryReadSecret(secretFile);
      if (racedValue) return racedValue;
    }
    throw err;
  }
}

function tryReadSecret(path: string): string | null {
  if (!existsSync(path)) return null;
  const value = readFileSync(path, 'utf8').trim();
  return value.length > 0 ? value : null;
}
