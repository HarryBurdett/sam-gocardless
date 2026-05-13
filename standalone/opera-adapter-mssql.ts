/**
 * MSSQL Opera adapter (opera-se).
 *
 * Builds a Knex pool per Opera company database, lazily. Each
 * standalone-company maps to one Opera-database name (legacy:
 * Opera3SECompany00X). The plugin's `ctx.db.getCompanyDb(code)` call
 * receives `code` from req.operaCompany — which the standalone host
 * sets to the standalone-company name unless the caller explicitly
 * sends an X-Opera-Company header.
 *
 * Connection params are server-wide (one MSSQL instance for all
 * companies, with the database name being the only per-company
 * variable — same pattern as the legacy Python implementation and
 * Opera's standard SE deployment).
 */
import knex, { type Knex } from 'knex';
import type { OperaAdapter } from './opera-adapter.js';
import type { AppLogger } from '../src/app-context.js';

export interface MssqlAdapterConfig {
  host: string;
  port: number;
  user: string;
  password: string;
  /** Set true for Opera servers that present self-signed certs (the default in legacy deployments). */
  trustServerCertificate: boolean;
  encrypt: boolean;
  /** Standalone-company code → Opera-database name on the server. */
  companies: ReadonlyMap<string, string>;
  logger: AppLogger;
}

export interface MssqlAdapter extends OperaAdapter {
  /** Destroy all per-database pools. Called at server shutdown. */
  destroy(): Promise<void>;
}

export function buildMssqlAdapter(config: MssqlAdapterConfig): MssqlAdapter {
  const pools = new Map<string, Knex>();

  function getCompanyDb(code: string): Knex | null {
    const database = config.companies.get(code);
    if (!database) {
      config.logger.warn(`[opera-mssql] no Opera database mapping for company "${code}"`);
      return null;
    }
    let pool = pools.get(code);
    if (!pool) {
      pool = knex({
        client: 'mssql',
        connection: {
          host: config.host,
          port: config.port,
          user: config.user,
          password: config.password,
          database,
          options: {
            encrypt: config.encrypt,
            trustServerCertificate: config.trustServerCertificate,
          },
        },
        pool: { min: 0, max: 5 },
      });
      pools.set(code, pool);
      config.logger.info(`[opera-mssql] created pool for "${code}" → ${database}`);
    }
    return pool;
  }

  async function destroy(): Promise<void> {
    for (const [code, pool] of pools.entries()) {
      try {
        await pool.destroy();
      } catch (err) {
        config.logger.warn(`[opera-mssql] error closing pool for ${code}: ${(err as Error).message}`);
      }
    }
    pools.clear();
  }

  return {
    operaType: 'opera-se',
    getCompanyDb,
    destroy,
  };
}
