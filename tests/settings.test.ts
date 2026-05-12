/**
 * Tests for the GoCardless settings service.
 */
import { describe, it, expect } from 'vitest';
import {
  loadSettings,
  saveSettings,
  maskSettingsForResponse,
  mergeSettingsUpdate,
  type GoCardlessSettings,
} from '../src/services/settings.js';

/**
 * Mock Knex with a single in-memory settings table.
 */
function makeMockDb(): any {
  const store = new Map<string, { key: string; value: string; updated_at: Date }>();

  const db: any = (table: string) => {
    if (table !== 'settings') {
      throw new Error(`Unexpected table: ${table}`);
    }
    let whereClause: { key?: string } = {};
    const builder: any = {
      where: (col: string | Record<string, unknown>, _val?: unknown) => {
        if (typeof col === 'object') Object.assign(whereClause, col);
        else if (_val !== undefined) (whereClause as any)[col] = _val;
        return builder;
      },
      first: async () => (whereClause.key ? store.get(whereClause.key) ?? null : null),
      update: async (patch: Record<string, unknown>) => {
        if (whereClause.key) {
          const existing = store.get(whereClause.key);
          if (existing) {
            store.set(whereClause.key, {
              ...existing,
              value: String(patch.value),
              updated_at: new Date(),
            });
          }
        }
        return 1;
      },
      insert: async (row: Record<string, unknown>) => {
        store.set(String(row.key), {
          key: String(row.key),
          value: String(row.value),
          updated_at: new Date(),
        });
        return [1];
      },
    };
    return builder;
  };
  db.fn = { now: () => new Date() };
  db.raw = async () => [];
  return db;
}

describe('loadSettings', () => {
  it('returns defaults when no row exists', async () => {
    const db = makeMockDb();
    const settings = await loadSettings(db);
    expect(settings.subscription_tag).toBe('SUB');
    expect(settings.fees_vat_code).toBe('1');
    expect(settings.subscription_frequencies).toEqual(['W', 'M', 'A']);
  });

  it('returns persisted settings merged with defaults', async () => {
    const db = makeMockDb();
    const stored: Partial<GoCardlessSettings> = {
      default_batch_type: 'GoCardless',
      default_bank_code: 'BC010',
      api_access_token: 'sandbox_test_token',
    };
    await saveSettings(db, { ...stored } as GoCardlessSettings);

    const loaded = await loadSettings(db);
    expect(loaded.default_batch_type).toBe('GoCardless');
    expect(loaded.default_bank_code).toBe('BC010');
    expect(loaded.api_access_token).toBe('sandbox_test_token');
    // Defaults still present
    expect(loaded.subscription_tag).toBe('SUB');
  });
});

describe('maskSettingsForResponse', () => {
  it('redacts api_access_token and adds api_key_configured + api_key_hint', () => {
    const settings: GoCardlessSettings = {
      ...mkBlank(),
      api_access_token: 'sandbox_abcdefghijklmnop',
    };
    const masked = maskSettingsForResponse(settings);
    expect(masked.api_access_token).toBeUndefined();
    expect(masked.api_key_configured).toBe(true);
    expect(masked.api_key_hint).toBe('...mnop');
  });

  it('reports api_key_configured=false when no token set', () => {
    const settings: GoCardlessSettings = mkBlank();
    const masked = maskSettingsForResponse(settings);
    expect(masked.api_key_configured).toBe(false);
    expect(masked.api_key_hint).toBe('');
  });

  it('replaces partner_client_secret with bullet placeholder when set', () => {
    const settings: GoCardlessSettings = {
      ...mkBlank(),
      partner_client_secret: 'real-secret-value',
    };
    const masked = maskSettingsForResponse(settings);
    expect(masked.partner_client_secret).toBe('••••••••');
  });

  it('uses **** when token has 4 or fewer characters', () => {
    const settings: GoCardlessSettings = {
      ...mkBlank(),
      api_access_token: 'abc',
    };
    const masked = maskSettingsForResponse(settings);
    expect(masked.api_key_hint).toBe('****');
    // Note: Python checks len(api_token) > 10 for api_key_configured.
    // Short tokens are NOT considered configured.
    expect(masked.api_key_configured).toBe(false);
  });
});

describe('mergeSettingsUpdate', () => {
  it('only overwrites keys present in body', () => {
    const existing: GoCardlessSettings = {
      ...mkBlank(),
      default_batch_type: 'OldType',
      default_bank_code: 'BC010',
      fees_vat_code: '1',
    };
    const merged = mergeSettingsUpdate(existing, { default_batch_type: 'NewType' });
    expect(merged.default_batch_type).toBe('NewType');
    expect(merged.default_bank_code).toBe('BC010'); // unchanged
    expect(merged.fees_vat_code).toBe('1'); // unchanged
  });

  it('preserves api_access_token when body provides empty/null', () => {
    const existing: GoCardlessSettings = {
      ...mkBlank(),
      api_access_token: 'existing_token',
    };
    const merged1 = mergeSettingsUpdate(existing, { api_access_token: '' });
    expect(merged1.api_access_token).toBe('existing_token');

    const merged2 = mergeSettingsUpdate(existing, { api_access_token: null });
    expect(merged2.api_access_token).toBe('existing_token');

    const merged3 = mergeSettingsUpdate(existing, {});
    expect(merged3.api_access_token).toBe('existing_token');
  });

  it('updates api_access_token when body provides non-empty value', () => {
    const existing: GoCardlessSettings = {
      ...mkBlank(),
      api_access_token: 'old_token',
    };
    const merged = mergeSettingsUpdate(existing, { api_access_token: 'new_token' });
    expect(merged.api_access_token).toBe('new_token');
  });

  it('preserves partner_client_secret when body sends the bullet placeholder', () => {
    const existing: GoCardlessSettings = {
      ...mkBlank(),
      partner_client_secret: 'existing_secret',
    };
    const merged = mergeSettingsUpdate(existing, {
      partner_client_secret: '••••••••',
    });
    expect(merged.partner_client_secret).toBe('existing_secret');
  });

  it('updates partner_client_secret when body sends a real value', () => {
    const existing: GoCardlessSettings = {
      ...mkBlank(),
      partner_client_secret: 'old_secret',
    };
    const merged = mergeSettingsUpdate(existing, {
      partner_client_secret: 'new_secret',
    });
    expect(merged.partner_client_secret).toBe('new_secret');
  });

  it('handles array fields like exclude_description_patterns', () => {
    const existing: GoCardlessSettings = {
      ...mkBlank(),
      exclude_description_patterns: ['old1', 'old2'],
    };
    const merged = mergeSettingsUpdate(existing, {
      exclude_description_patterns: ['new1'],
    });
    expect(merged.exclude_description_patterns).toEqual(['new1']);
  });
});

function mkBlank(): GoCardlessSettings {
  return {
    default_batch_type: '',
    default_bank_code: '',
    fees_nominal_account: '',
    fees_vat_code: '1',
    fees_payment_type: '',
    company_reference: '',
    exclude_description_patterns: [],
    auto_allocate: false,
    gocardless_bank_code: '',
    gocardless_transfer_cbtype: '',
    subscription_tag: 'SUB',
    subscription_frequencies: ['W', 'M', 'A'],
  };
}
