/**
 * Opera DB adapter for the standalone host.
 *
 * Two adapters ship today:
 *   - `noop`  — every getCompanyDb() call returns null. Lets the
 *               server boot without an Opera connection. The plugin
 *               surfaces its own "Opera not connected" error path.
 *   - `mssql` — opera-se (SQL Server) via the `tedious` driver.
 *               Connection params come from env vars; per-company
 *               Opera-database mappings come from per-company
 *               opera.json files.
 *
 * FoxPro (opera-3) is not yet supported; the legacy Python app uses an
 * out-of-process agent for that and we'd mirror it.
 */
import type { Knex } from 'knex';
import type { AppLogger } from '../src/app-context.js';

export type OperaType = 'opera-se' | 'opera-3' | null;

export interface OperaAdapter {
  getCompanyDb(code: string): Knex | null;
  operaType: OperaType;
  /**
   * Release any per-adapter resources (pools, file handles).
   * Always present; the noop adapter is a no-op.
   */
  destroy?: () => Promise<void>;
  /**
   * Invalidate cached state for a single company. Called by the
   * standalone host after the operator edits the per-company
   * opera.json so the next getCompanyDb(code) call rebuilds the
   * pool against the new database / Opera version.
   *
   * `mapping` is the latest opera.json contents; null clears the
   * mapping entirely (the company becomes inaccessible until
   * mapped again).
   */
  invalidateCompany?: (
    code: string,
    mapping: { database: string; operaVersion?: string } | null,
  ) => Promise<void>;
}

export const noOpAdapter: OperaAdapter = {
  getCompanyDb: () => null,
  operaType: null,
};

export interface SelectAdapterOptions {
  name: string;
  mssql?: {
    host: string;
    port: number;
    user: string;
    password: string;
    trustServerCertificate: boolean;
    encrypt: boolean;
    /** companyCode → { database, operaVersion } */
    companies: ReadonlyMap<string, { database: string; operaVersion?: string }>;
  };
  logger: AppLogger;
}

export async function selectAdapter(opts: SelectAdapterOptions): Promise<OperaAdapter> {
  if (opts.name === 'noop') return noOpAdapter;
  if (opts.name === 'mssql') {
    if (!opts.mssql) {
      throw new Error(
        'OPERA_ADAPTER=mssql requires OPERA_SQL_HOST, OPERA_SQL_USER, OPERA_SQL_PASSWORD (see README).',
      );
    }
    if (opts.mssql.companies.size === 0) {
      throw new Error(
        'OPERA_ADAPTER=mssql requires per-company opera.json files with a "database" field. ' +
          'Add <DATA_ROOT>/<company>/opera.json (or set LEGACY_DATA_ROOT to auto-seed from the ' +
          'legacy companies/ directory).',
      );
    }
    const { buildMssqlAdapter } = await import('./opera-adapter-mssql.js');
    return buildMssqlAdapter({ ...opts.mssql, logger: opts.logger });
  }
  throw new Error(`Unknown OPERA_ADAPTER: ${opts.name}`);
}
