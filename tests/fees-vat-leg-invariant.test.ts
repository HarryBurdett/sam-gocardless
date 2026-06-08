/**
 * Tests for Bug 1 from the 2026-06-05 production audit:
 *
 * postFeesEntry must NOT post an unbalanced 2-leg fees journal when
 * the VAT amount is known but the VAT nominal account cannot be
 * resolved. Previously the code silently skipped the VAT leg while
 * still posting (NET fees DR) + (GROSS bank CR), leaving the journal
 * short on DR by the VAT amount.
 *
 * The fix: an explicit invariant assertion that throws a clear,
 * operator-actionable error whenever vatAmount > 0 but no VAT
 * nominal account can be resolved.
 */
import { describe, it, expect } from 'vitest';
import { assertVatLineCanBePosted } from '../src/services/batch-posting-executor.js';

describe('assertVatLineCanBePosted — fees journal balance invariant', () => {
  it('returns silently when vatAmount === 0 (no VAT line needed)', () => {
    expect(() => assertVatLineCanBePosted(0, '', 'Z0')).not.toThrow();
    // Even with no account configured, zero VAT is fine.
    expect(() => assertVatLineCanBePosted(0, 'V1100', 'S')).not.toThrow();
  });

  it('returns silently when vatAmount > 0 AND vatNominalAccount is set', () => {
    expect(() => assertVatLineCanBePosted(1.6, 'V1100', 'S')).not.toThrow();
    expect(() => assertVatLineCanBePosted(0.01, 'V1100', 'S5')).not.toThrow();
  });

  it('throws when vatAmount > 0 but vatNominalAccount is empty string (unconfigured)', () => {
    expect(() => assertVatLineCanBePosted(0.8, '', 'S')).toThrow(
      /VAT amount is £0\.80/,
    );
    expect(() => assertVatLineCanBePosted(0.8, '', 'S')).toThrow(/'S'/);
  });

  it('throws when vatAmount > 0 but vatNominalAccount is whitespace (also unconfigured)', () => {
    expect(() => assertVatLineCanBePosted(28.4, '   ', 'S20')).toThrow(
      /VAT amount is £28\.40/,
    );
  });

  it('error message names the unresolved VAT code so operators can fix the setup', () => {
    try {
      assertVatLineCanBePosted(9.67, '', 'S20');
      throw new Error('should have thrown');
    } catch (e) {
      const msg = (e as Error).message;
      expect(msg).toMatch(/S20/);
      expect(msg).toMatch(/nominal_account|Opera VAT code maintenance/);
      // Must mention the dollar/pound amount so the operator can locate
      // the specific failing batch.
      expect(msg).toMatch(/9\.67/);
    }
  });
});
