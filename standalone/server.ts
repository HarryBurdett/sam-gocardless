/**
 * Standalone host entry point.
 *
 * Boots the SAM plugin core (from dist/index.js) inside a self-hosted
 * Express server, with file-backed SQLite, no-op Opera adapter, and
 * cookie-session auth.
 */
import express, { type Express } from 'express';
import knex, { type Knex } from 'knex';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { loadConfig, type StandaloneConfig } from './config.js';
import { runMigrations } from './migrate.js';
import { loginRouter, requireAuth } from './auth.js';
import { selectAdapter } from './opera-adapter.js';
import type {
  AppContext,
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

export async function buildApp(
  opts: BuildAppOptions = {},
): Promise<{ app: Express; config: StandaloneConfig; appDb: Knex; samDb: Knex }> {
  if (!existsSync(DIST_ENTRY)) {
    throw new Error(
      `${DIST_ENTRY} not found — run \`npm run build\` first.`,
    );
  }

  const config = loadConfig({ dataDir: opts.dataDir });
  const adapter = selectAdapter(config.operaAdapter);

  let appDb: Knex | undefined;
  let samDb: Knex | undefined;
  try {
    appDb = knex({
      client: 'sqlite3',
      connection: { filename: config.databasePath },
      useNullAsDefault: true,
      pool: { min: 1, max: 1 },
    });
    await runMigrations(appDb);

    // db.sam is required by AppContext but unused by this plugin. A small
    // in-memory pool keeps the type honest without writing anywhere.
    samDb = knex({
      client: 'sqlite3',
      connection: { filename: ':memory:' },
      useNullAsDefault: true,
      pool: { min: 1, max: 1 },
    });

    const ctx: AppContext = {
      appId: 'gocardless',
      tenantId: 'standalone',
      config: { mailboxes: [] },
      operaType: adapter.operaType,
      db: {
        sam: samDb,
        app: appDb,
        operaSystem: null,
        getCompanyDb: (code) => adapter.getCompanyDb(code),
      },
      logger: consoleLogger,
    };

    const pluginMod = (await import(DIST_ENTRY)) as { default: AppBackendFactory };
    const pluginRouter = await pluginMod.default(ctx);

    const app = express();
    // Trust upstream proxies so req.protocol honors X-Forwarded-Proto
    // when behind TLS termination. Required for the auth middleware
    // to set Secure on cookies. Operators behind a public-IP proxy
    // must widen this via TRUST_PROXY (see README) — the loopback
    // default does not match public IPs.
    app.set('trust proxy', config.trustProxy);

    app.use(express.json({ limit: '10mb' }));

    // /login.html — explicit, before auth, so unauthenticated users can reach it.
    app.get('/login.html', (_req, res) => {
      res.sendFile(resolve(PUBLIC_DIR, 'login.html'));
    });

    // /auth/* — login + logout, no auth required.
    app.use('/auth', loginRouter(config));

    // Everything below requires auth.
    app.use(requireAuth(config));

    // Frontend static bundle.
    app.use(
      '/api/apps/gocardless/static',
      express.static(FRONTEND_DIST),
    );

    // Plugin API.
    app.use('/api/apps/gocardless', pluginRouter);

    // App shell + any other authenticated static assets.
    app.use(express.static(PUBLIC_DIR));

    // Catch-all error handler.
    app.use(
      (
        err: Error,
        _req: express.Request,
        res: express.Response,
        _next: express.NextFunction,
      ) => {
        consoleLogger.error('unhandled:', err);
        res.status(500).json({ error: err.message });
      },
    );

    return { app, config, appDb, samDb };
  } catch (err) {
    if (samDb) await samDb.destroy().catch(() => {});
    if (appDb) await appDb.destroy().catch(() => {});
    throw err;
  }
}

async function main(): Promise<void> {
  const { app, config } = await buildApp();
  app.listen(config.port, () => {
    console.log(`\n[standalone] listening on http://localhost:${config.port}`);
    console.log(`[standalone] database:    ${config.databasePath}`);
    console.log(`[standalone] adapter:     ${config.operaAdapter}`);
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
