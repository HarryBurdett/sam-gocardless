import { describe, it, expect } from 'vitest';
import { noOpAdapter, selectAdapter } from '../opera-adapter.js';

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
    it('returns noOpAdapter for "noop"', () => {
      expect(selectAdapter('noop')).toBe(noOpAdapter);
    });

    it('throws for unknown names', () => {
      expect(() => selectAdapter('mssql')).toThrow(/Unknown OPERA_ADAPTER/);
    });
  });
});
