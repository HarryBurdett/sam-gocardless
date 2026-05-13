import { describe, it, expect, afterEach } from 'vitest';
import knex, { type Knex } from 'knex';
import { runMigrations } from '../migrate.js';

const created: Knex[] = [];

function newDb(): Knex {
  const db = knex({
    client: 'sqlite3',
    connection: { filename: ':memory:' },
    useNullAsDefault: true,
    pool: { min: 1, max: 1 },
  });
  created.push(db);
  return db;
}

afterEach(async () => {
  while (created.length) {
    const db = created.pop();
    if (db) await db.destroy();
  }
});

describe('runMigrations', () => {
  it('creates the settings table on first run', async () => {
    const db = newDb();
    await runMigrations(db);
    const exists = await db.schema.hasTable('settings');
    expect(exists).toBe(true);
  });

  it('creates the gocardless_mandates table on first run', async () => {
    const db = newDb();
    await runMigrations(db);
    const exists = await db.schema.hasTable('gocardless_mandates');
    expect(exists).toBe(true);
  });

  it('is idempotent — running twice does not error', async () => {
    const db = newDb();
    await runMigrations(db);
    await expect(runMigrations(db)).resolves.not.toThrow();
  });

  it('records applied migrations in _standalone_migrations', async () => {
    const db = newDb();
    await runMigrations(db);
    const rows = await db('_standalone_migrations').select('name');
    const names = rows.map((r: { name: string }) => r.name).sort();
    expect(names).toContain('001_initial_schema.ts');
    expect(names).toContain('007_align_subscriptions_schema.ts');
  });
});
