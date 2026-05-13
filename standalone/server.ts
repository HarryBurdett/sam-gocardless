/**
 * Standalone host entry point.
 *
 * Multi-company:
 *   - For each subdirectory of DATA_ROOT (auto-discovered, optionally
 *     bootstrapped from LEGACY_DATA_ROOT), boot a dedicated plugin
 *     instance from dist/index.js, backed by its own SQLite at
 *     <DATA_ROOT>/<companyCode>/gocardless.sqlite.
 *   - A dispatcher router at /api/apps/gocardless inspects the session
 *     cookie to forward each request to the right per-company router.
 *   - Login form picks the company (alongside the shared password) and
 *     bakes companyCode into the signed session cookie.
 *
 * SAM contract is untouched — `standalone/` is sibling to the SAM
 * plugin contract; SAM-plugged mode runs dist/index.js with SAM's own
 * AppContext and never imports this module.
 */
import express, { type Express, type Router, type Request, type Response, type NextFunction } from 'express';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { loadConfig, type StandaloneConfig } from './config.js';
import { loginRouter, requireAuth } from './auth.js';
import { selectAdapter, type OperaAdapter } from './opera-adapter.js';
import {
  discoverCompanies,
  loadCompany,
  loadOperaConfig,
  type CompanyInstance,
} from './company-registry.js';
import type {
  AppBackendFactory,
  AppLogger,
} from '../src/app-context.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..');
const DIST_ENTRY = resolve(repoRoot, 'dist', 'index.js');
const FRONTEND_DIST = resolve(repoRoot, 'frontend', 'dist');
const PUBLIC_DIR = resolve(__dirname, 'public');

const consoleLogger: AppLogger = {
  info: (msg, ...args) => console.log(`[info] ${msg}`, ...args),
  warn: (msg, ...args) => console.warn(`[warn] ${msg}`, ...args),
  error: (msg, ...args) => console.error(`[error] ${msg}`, ...args),
  debug: (msg, ...args) => console.log(`[debug] ${msg}`, ...args),
};

export interface BuildAppOptions {
  dataDir?: string;
}

export interface BuiltApp {
  app: Express;
  config: StandaloneConfig;
  companies: Map<string, CompanyInstance>;
  operaAdapter: OperaAdapter;
}

export async function buildApp(opts: BuildAppOptions = {}): Promise<BuiltApp> {
  if (!existsSync(DIST_ENTRY)) {
    throw new Error(
      `${DIST_ENTRY} not found — run \`npm run build\` first.`,
    );
  }

  const config = loadConfig({ dataDir: opts.dataDir });
  const pluginMod = (await import(DIST_ENTRY)) as { default: AppBackendFactory };

  const codes = discoverCompanies(config.dataRoot, config.legacyDataRoot);
  if (codes.length === 0) {
    throw new Error(
      `No companies found under ${config.dataRoot}. Create a subdirectory ` +
        `per company (e.g., ${config.dataRoot}/intsys/) or set LEGACY_DATA_ROOT ` +
        `to bootstrap from an existing data tree.`,
    );
  }

  // Build the standalone-company → Opera-database map by reading each
  // company's opera.json (seeding from legacy on first run if available).
  const operaCompanies = new Map<string, string>();
  for (const code of codes) {
    const cfg = loadOperaConfig(
      config.dataRoot,
      config.legacyCompaniesDir,
      code,
      consoleLogger,
    );
    if (cfg) operaCompanies.set(code, cfg.database);
  }

  const operaAdapter = await selectAdapter({
    name: config.operaAdapter,
    logger: consoleLogger,
    mssql: config.mssql
      ? { ...config.mssql, companies: operaCompanies }
      : undefined,
  });

  const companies = new Map<string, CompanyInstance>();
  try {
    for (const code of codes) {
      consoleLogger.info(`loading company "${code}"`);
      const instance = await loadCompany(code, {
        dataRoot: config.dataRoot,
        legacyDataRoot: config.legacyDataRoot,
        operaAdapter,
        logger: consoleLogger,
        factory: pluginMod.default,
      });
      companies.set(code, instance);
    }
  } catch (err) {
    for (const c of companies.values()) {
      await c.samDb.destroy().catch(() => {});
      await c.appDb.destroy().catch(() => {});
    }
    if (operaAdapter.destroy) await operaAdapter.destroy().catch(() => {});
    throw err;
  }

  const app = express();
  // Trust upstream proxies so req.protocol honors X-Forwarded-Proto
  // when behind TLS termination. Required for the auth middleware
  // to set Secure on cookies. Operators behind a public-IP proxy
  // must widen this via TRUST_PROXY (see README) — the loopback
  // default does not match public IPs.
  app.set('trust proxy', config.trustProxy);

  app.use(express.json({ limit: '10mb' }));

  // /login.html — explicit, before auth.
  app.get('/login.html', (_req, res) => {
    res.sendFile(resolve(PUBLIC_DIR, 'login.html'));
  });

  // /auth/* — login + logout + companies (no auth).
  app.use('/auth', loginRouter(config, () => Array.from(companies.keys())));

  // Everything below requires auth.
  app.use(requireAuth(config));

  // Authenticated /auth/me — caller can read which company the session selected.
  app.get('/auth/me', (req: Request, res: Response) => {
    res.json({
      user: req.user,
      company: req.standaloneCompany ?? null,
    });
  });

  // Frontend static bundle.
  app.use(
    '/api/apps/gocardless/static',
    express.static(FRONTEND_DIST),
  );

  // Dispatcher: forward /api/apps/gocardless/* to the per-company router.
  app.use('/api/apps/gocardless', makeDispatcher(companies));

  // App shell + any other authenticated static assets.
  app.use(express.static(PUBLIC_DIR));

  // Catch-all error handler.
  app.use(
    (
      err: Error,
      _req: Request,
      res: Response,
      _next: NextFunction,
    ) => {
      consoleLogger.error('unhandled:', err);
      res.status(500).json({ error: err.message });
    },
  );

  return { app, config, companies, operaAdapter };
}

function makeDispatcher(companies: Map<string, CompanyInstance>): Router {
  const dispatch = express.Router();
  dispatch.use((req: Request, res: Response, next: NextFunction) => {
    const code = req.standaloneCompany;
    if (!code) {
      res.status(400).json({ error: 'no company in session' });
      return;
    }
    const instance = companies.get(code);
    if (!instance) {
      res.status(404).json({ error: `unknown company: ${code}` });
      return;
    }
    instance.router(req, res, next);
  });
  return dispatch;
}

async function main(): Promise<void> {
  const { app, config, companies } = await buildApp();
  app.listen(config.port, () => {
    console.log(`\n[standalone] listening on http://localhost:${config.port}`);
    console.log(`[standalone] data root:  ${config.dataRoot}`);
    if (config.legacyDataRoot) {
      console.log(`[standalone] legacy root: ${config.legacyDataRoot}`);
    }
    if (config.legacyCompaniesDir) {
      console.log(`[standalone] legacy companies: ${config.legacyCompaniesDir}`);
    }
    console.log(`[standalone] companies:  ${Array.from(companies.keys()).join(', ')}`);
    console.log(`[standalone] adapter:    ${config.operaAdapter}`);
    if (config.mssql) {
      console.log(`[standalone] mssql:      ${config.mssql.user}@${config.mssql.host}:${config.mssql.port}`);
    }
  });
}

// Run only when invoked as the entry point, not when imported by tests.
const invokedDirectly =
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  main().catch((err) => {
    console.error('[standalone] failed to start:', err);
    process.exit(1);
  });
}
