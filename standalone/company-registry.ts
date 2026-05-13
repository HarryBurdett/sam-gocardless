/**
 * Multi-company plugin loader for the standalone host.
 *
 * Each "company" is a top-level subdirectory under DATA_ROOT
 * (e.g., ./data/intsys, ./data/cloudsis, ./data/z_demo). Each gets:
 *   - its own SQLite file at <root>/<code>/gocardless.sqlite
 *   - its own Knex pool
 *   - its own AppContext + plugin Router instance
 *
 * This mirrors the legacy Python layout (data/<company>/gocardless/…)
 * while keeping the SAM plugin contract untouched: SAM-plugged mode
 * still boots one plugin instance per SAM tenant, just like before;
 * `company-registry.ts` is standalone-only code.
 */
import knex, { type Knex } from 'knex';
import { existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { Router } from 'express';
import { runMigrations } from './migrate.js';
import { selectAdapter, type OperaAdapter } from './opera-adapter.js';
import type {
  AppContext,
  AppBackendFactory,
  AppLogger,
} from '../src/app-context.js';

export interface CompanyInstance {
  code: string;
  ctx: AppContext;
  router: Router;
  appDb: Knex;
  samDb: Knex;
}

export interface LoadOptions {
  dataRoot: string;
  legacyDataRoot: string | null;
  operaAdapter: OperaAdapter;
  logger: AppLogger;
  factory: AppBackendFactory;
}

/**
 * Return the sorted list of company codes discovered under dataRoot
 * (plus any new ones bootstrapped from legacyDataRoot). Skips hidden
 * dirs and non-directory entries.
 */
export function discoverCompanies(
  dataRoot: string,
  legacyDataRoot: string | null,
): string[] {
  mkdirSync(dataRoot, { recursive: true });

  if (legacyDataRoot && existsSync(legacyDataRoot)) {
    for (const entry of readdirSync(legacyDataRoot, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
      const legacyGc = join(legacyDataRoot, entry.name, 'gocardless');
      if (!existsSync(legacyGc)) continue;
      const newDir = join(dataRoot, entry.name);
      if (!existsSync(newDir)) mkdirSync(newDir, { recursive: true });
    }
  }

  return readdirSync(dataRoot, { withFileTypes: true })
    .filter((d) => d.isDirectory() && !d.name.startsWith('.'))
    .map((d) => d.name)
    .sort();
}

/**
 * Build per-company AppContext + plugin Router. Runs migrations on the
 * per-company SQLite. If the settings table is empty and a legacy
 * gocardless_settings.json exists, seeds the table from it.
 */
export async function loadCompany(
  code: string,
  opts: LoadOptions,
): Promise<CompanyInstance> {
  const companyDir = join(opts.dataRoot, code);
  mkdirSync(companyDir, { recursive: true });
  const dbPath = join(companyDir, 'gocardless.sqlite');

  let appDb: Knex | undefined;
  let samDb: Knex | undefined;
  try {
    appDb = knex({
      client: 'sqlite3',
      connection: { filename: dbPath },
      useNullAsDefault: true,
      pool: { min: 1, max: 1 },
    });
    await runMigrations(appDb);
    await seedFromLegacyIfEmpty(appDb, opts.legacyDataRoot, code, opts.logger);

    samDb = knex({
      client: 'sqlite3',
      connection: { filename: ':memory:' },
      useNullAsDefault: true,
      pool: { min: 1, max: 1 },
    });

    const ctx: AppContext = {
      appId: 'gocardless',
      tenantId: `standalone:${code}`,
      config: { mailboxes: [] },
      operaType: opts.operaAdapter.operaType,
      db: {
        sam: samDb,
        app: appDb,
        operaSystem: null,
        getCompanyDb: (c) => opts.operaAdapter.getCompanyDb(c),
      },
      logger: opts.logger,
    };

    const router = await opts.factory(ctx);
    return { code, ctx, router, appDb, samDb };
  } catch (err) {
    if (samDb) await samDb.destroy().catch(() => {});
    if (appDb) await appDb.destroy().catch(() => {});
    throw err;
  }
}

/**
 * Seed the settings table from <legacy>/<code>/gocardless/gocardless_settings.json
 * if it exists and the settings table is empty.
 *
 * The plugin's settings service stores the whole dict as a single row keyed
 * `gocardless_settings` with a stringified JSON value (see
 * src/services/settings.ts), so we mirror that — one row, JSON-encoded body.
 */
const SETTINGS_KEY = 'gocardless_settings';

async function seedFromLegacyIfEmpty(
  appDb: Knex,
  legacyDataRoot: string | null,
  code: string,
  logger: AppLogger,
): Promise<void> {
  if (!legacyDataRoot) return;
  const legacyFile = resolve(legacyDataRoot, code, 'gocardless', 'gocardless_settings.json');
  if (!existsSync(legacyFile)) return;

  const existing = await appDb('settings').where({ key: SETTINGS_KEY }).first();
  if (existing) return;

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(legacyFile, 'utf8'));
  } catch (err) {
    logger.warn(`[${code}] legacy settings file unreadable: ${(err as Error).message}`);
    return;
  }

  await appDb('settings').insert({
    key: SETTINGS_KEY,
    value: JSON.stringify(parsed),
  });
  logger.info(`[${code}] seeded settings from legacy file`);
}
