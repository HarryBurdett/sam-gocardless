import { describe, it, expect } from 'vitest';
import { noOpAdapter, selectAdapter } from '../opera-adapter.js';

const silentLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
};

describe('opera-adapter', () => {
  describe('noOpAdapter', () => {
    it('returns null for any company code', () => {
      expect(noOpAdapter.getCompanyDb('ANY')).toBeNull();
      expect(noOpAdapter.getCompanyDb('')).toBeNull();
    });

    it('reports null operaType', () => {
      expect(noOpAdapter.operaType).toBeNull();
    });
  });

  describe('selectAdapter', () => {
    it('returns noOpAdapter for "noop"', async () => {
      const adapter = await selectAdapter({ name: 'noop', logger: silentLogger });
      expect(adapter).toBe(noOpAdapter);
    });

    it('throws for unknown names', async () => {
      await expect(
        selectAdapter({ name: 'unknown', logger: silentLogger }),
      ).rejects.toThrow(/Unknown OPERA_ADAPTER/);
    });

    it('throws when mssql is selected without an mssql config', async () => {
      await expect(
        selectAdapter({ name: 'mssql', logger: silentLogger }),
      ).rejects.toThrow(/OPERA_SQL_HOST/);
    });

    it('throws when mssql is selected with an empty company map', async () => {
      await expect(
        selectAdapter({
          name: 'mssql',
          logger: silentLogger,
          mssql: {
            host: 'localhost',
            port: 1433,
            user: 'u',
            password: 'p',
            trustServerCertificate: true,
            encrypt: true,
            companies: new Map(),
          },
        }),
      ).rejects.toThrow(/opera\.json/);
    });

    it('builds an mssql adapter that returns null for unknown codes and reports opera-se', async () => {
      const adapter = await selectAdapter({
        name: 'mssql',
        logger: silentLogger,
        mssql: {
          host: 'localhost',
          port: 1433,
          user: 'u',
          password: 'p',
          trustServerCertificate: true,
          encrypt: true,
          companies: new Map([['intsys', 'Opera3SECompany00I']]),
        },
      });
      expect(adapter.operaType).toBe('opera-se');
      expect(typeof adapter.getCompanyDb).toBe('function');
      expect(adapter.getCompanyDb('unknown')).toBeNull();
      if (adapter.destroy) await adapter.destroy();
    });
  });
});
