/**
 * Per-company settings isolation tests.
 *
 * Verifies the fix for the cross-company settings leak documented in
 * Jonathan's gocardless-multi-company-handoff.md (2026-06-09):
 *
 *   - Two Opera companies in the same SAM-provisioned database must
 *     keep separate `settings.gocardless_settings` rows. Saving for
 *     one must never overwrite the other.
 *   - Loading with an empty / missing company code must FAIL LOUDLY
 *     (companyScope throws) — never silently fall through to "no
 *     filter" and return a random row.
 *   - Migration 008 + the new (companyCode) parameter on
 *     loadSettings/saveSettings is what enforces this.
 *
 * Uses an in-memory SQLite DB with the real migrations applied,
 * matching the migrations.test.ts pattern.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import knex, { type Knex } from 'knex';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import {
  loadSettings,
  saveSettings,
  type GoCardlessSettings,
} from '../src/services/settings.js';

const MIGRATIONS_DIR = path.resolve(__dirname, '../db/migrations');

async function makeDb(): Promise<Knex> {
  const db = knex({
    client: 'sqlite3',
    connection: { filename: ':memory:' },
    useNullAsDefault: true,
  });
  // Apply every migration in lexical order — mirrors how the SAM
  // host's plugin migration runner does it.
  const files = (await fs.readdir(MIGRATIONS_DIR))
    .filter((f) => f.endsWith('.ts') || f.endsWith('.js'))
    .sort();
  for (const file of files) {
    const mod = (await import(path.resolve(MIGRATIONS_DIR, file))) as {
      up: (k: Knex) => Promise<void>;
    };
    await mod.up(db);
  }
  return db;
}

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

describe('settings — per-company isolation', () => {
  let db: Knex;

  beforeEach(async () => {
    db = await makeDb();
  });

  afterEach(async () => {
    await db.destroy();
  });

  it('save+load round-trips per company without cross-talk', async () => {
    const cloudsisSettings: GoCardlessSettings = {
      ...mkBlank(),
      api_access_token: 'live_cloudsis_KEY_x9SS0qrgHj',
      default_batch_type: 'GoCardless',
      company_reference: 'Cloudsis Limited',
    };
    const intsysSettings: GoCardlessSettings = {
      ...mkBlank(),
      api_access_token: 'live_intsys_KEY_It0FoCJXv9',
      default_batch_type: 'GoCardless',
      company_reference: 'Intsys UK Ltd',
    };

    await saveSettings(db, 'C', cloudsisSettings);
    await saveSettings(db, 'I', intsysSettings);

    const loadedCloudsis = await loadSettings(db, 'C');
    const loadedIntsys = await loadSettings(db, 'I');

    expect(loadedCloudsis.api_access_token).toBe('live_cloudsis_KEY_x9SS0qrgHj');
    expect(loadedCloudsis.company_reference).toBe('Cloudsis Limited');
    expect(loadedIntsys.api_access_token).toBe('live_intsys_KEY_It0FoCJXv9');
    expect(loadedIntsys.company_reference).toBe('Intsys UK Ltd');
  });

  it('saving for one company never overwrites another company', async () => {
    await saveSettings(db, 'C', {
      ...mkBlank(),
      api_access_token: 'live_cloudsis_original',
    });
    await saveSettings(db, 'I', {
      ...mkBlank(),
      api_access_token: 'live_intsys_original',
    });
    // Cloudsis updates again — last-write-wins shouldn't affect Intsys.
    await saveSettings(db, 'C', {
      ...mkBlank(),
      api_access_token: 'live_cloudsis_UPDATED',
    });

    expect((await loadSettings(db, 'I')).api_access_token).toBe(
      'live_intsys_original',
    );
    expect((await loadSettings(db, 'C')).api_access_token).toBe(
      'live_cloudsis_UPDATED',
    );
  });

  it('loading an unconfigured company returns defaults, not another company data', async () => {
    await saveSettings(db, 'C', {
      ...mkBlank(),
      api_access_token: 'live_cloudsis_only',
    });

    // 'Z' has no settings row at all — must return defaults, NOT C's data.
    const z = await loadSettings(db, 'Z');
    expect(z.api_access_token).toBeUndefined();
    expect(z.subscription_tag).toBe('SUB'); // default
  });

  it('loadSettings throws on empty company code (fail-loud, never silent leak)', async () => {
    await saveSettings(db, 'C', {
      ...mkBlank(),
      api_access_token: 'live_cloudsis_secret',
    });

    await expect(loadSettings(db, '')).rejects.toThrow(
      /empty company code/i,
    );
    await expect(loadSettings(db, '   ')).rejects.toThrow(
      /empty company code/i,
    );
    await expect(
      loadSettings(db, undefined as unknown as string),
    ).rejects.toThrow(/empty company code/i);
  });

  it('saveSettings throws on empty company code', async () => {
    await expect(
      saveSettings(db, '', { ...mkBlank(), api_access_token: 'leak' }),
    ).rejects.toThrow(/empty company code/i);
  });

  it('migration 008 enforces (key, company_code) composite uniqueness', async () => {
    // Two companies can both own a row with key='gocardless_settings'
    await saveSettings(db, 'C', { ...mkBlank(), api_access_token: 'a' });
    await saveSettings(db, 'I', { ...mkBlank(), api_access_token: 'b' });

    const rows = await db('settings').select('key', 'company_code');
    const settingsRows = rows.filter(
      (r) => r.key === 'gocardless_settings',
    );
    expect(settingsRows).toHaveLength(2);
    const codes = settingsRows.map((r) => r.company_code).sort();
    expect(codes).toEqual(['C', 'I']);
  });

  it('on-disk row count: settings table has exactly one row per company per key', async () => {
    // Update same company three times — should still be one row.
    await saveSettings(db, 'C', { ...mkBlank(), api_access_token: 'v1' });
    await saveSettings(db, 'C', { ...mkBlank(), api_access_token: 'v2' });
    await saveSettings(db, 'C', { ...mkBlank(), api_access_token: 'v3' });

    const rows = await db('settings').where({ company_code: 'C' });
    expect(rows).toHaveLength(1);
    expect(JSON.parse(rows[0]!.value).api_access_token).toBe('v3');
  });
});
