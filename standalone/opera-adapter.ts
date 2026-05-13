/**
 * Opera DB adapter for the standalone host.
 *
 * Real adapters (MSSQL, FoxPro) drop in here. The no-op shipped today
 * lets the standalone server boot without an Opera connection — every
 * call returns null, and the plugin's existing handlers surface their
 * normal "Opera not connected" error.
 */
import type { Knex } from 'knex';

export type OperaType = 'opera-se' | 'opera-3' | null;

export interface OperaAdapter {
  getCompanyDb(code: string): Knex | null;
  operaType: OperaType;
}

export const noOpAdapter: OperaAdapter = {
  getCompanyDb: () => null,
  operaType: null,
};

export function selectAdapter(name: string): OperaAdapter {
  if (name === 'noop') return noOpAdapter;
  throw new Error(`Unknown OPERA_ADAPTER: ${name}`);
}
