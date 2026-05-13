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
import { join, resolve } from 'node:path';

export interface StandaloneConfig {
  port: number;
  /**
   * Parent directory under which each company's per-company SQLite
   * file lives at `<dataRoot>/<companyCode>/gocardless.sqlite`.
   */
  dataRoot: string;
  /**
   * Optional second directory scanned for legacy company layouts
   * (`<root>/<companyCode>/gocardless/gocardless_settings.json`).
   * When set, companies present in the legacy root but missing in
   * `dataRoot` are auto-created with stub directories, and any new
   * company whose settings table is empty gets seeded from the
   * legacy JSON file. Null disables legacy migration entirely.
   */
  legacyDataRoot: string | null;
  loginPassword: string;
  sessionSecret: string;
  operaAdapter: string;
  /** Internal dir for .session-secret etc. (separate from per-company data). */
  dataDir: string;
  /**
   * Value passed verbatim to Express's `app.set('trust proxy', …)`.
   * Default `'loopback, linklocal, uniquelocal'` covers local-network
   * reverse proxies. Set to e.g. `'1'` or a public CIDR when the
   * server sits behind a public-IP TLS terminator, otherwise
   * `req.protocol` stays `'http'` and the Secure cookie flag is
   * never applied.
   */
  trustProxy: string;
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

  const dataRoot = process.env.DATA_ROOT
    ? resolve(process.env.DATA_ROOT)
    : resolve(process.cwd(), 'data');
  mkdirSync(dataRoot, { recursive: true });

  const legacyDataRoot =
    process.env.LEGACY_DATA_ROOT && process.env.LEGACY_DATA_ROOT.length > 0
      ? resolve(process.env.LEGACY_DATA_ROOT)
      : null;

  const sessionSecret = resolveSessionSecret(dataDir);
  const operaAdapter = process.env.OPERA_ADAPTER ?? 'noop';
  const trustProxy =
    process.env.TRUST_PROXY && process.env.TRUST_PROXY.length > 0
      ? process.env.TRUST_PROXY
      : 'loopback, linklocal, uniquelocal';

  return {
    port,
    dataRoot,
    legacyDataRoot,
    loginPassword,
    sessionSecret,
    operaAdapter,
    dataDir,
    trustProxy,
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
