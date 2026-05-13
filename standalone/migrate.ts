/**
 * Idempotent migration runner for the standalone host.
 *
 * Imports each .ts file in db/migrations/ in lexical order, calls
 * up(knex) if it hasn't been applied yet, and records the filename in
 * a _standalone_migrations table. Bypasses Knex's built-in tracker so
 * .ts migrations under ESM load cleanly via the tsx runtime.
 */
import type { Knex } from 'knex';
import { readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = resolve(__dirname, '..', 'db', 'migrations');
const TABLE = '_standalone_migrations';

export async function runMigrations(db: Knex): Promise<void> {
  await ensureTable(db);
  const files = (await readdir(MIGRATIONS_DIR))
    .filter((f) => f.endsWith('.ts'))
    .sort();
  for (const file of files) {
    const already = await db(TABLE).where({ name: file }).first();
    if (already) continue;
    const mod = (await import(resolve(MIGRATIONS_DIR, file))) as {
      up: (k: Knex) => Promise<void>;
    };
    await mod.up(db);
    await db(TABLE).insert({ name: file, applied_at: new Date().toISOString() });
  }
}

async function ensureTable(db: Knex): Promise<void> {
  const exists = await db.schema.hasTable(TABLE);
  if (exists) return;
  await db.schema.createTable(TABLE, (table) => {
    table.string('name', 200).primary();
    table.string('applied_at', 64).notNullable();
  });
}
