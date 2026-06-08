/**
 * Opera id allocation primitives — sequence counters used by every
 * posting flow.
 *
 * Faithful ports of the methods on `OperaSQLImport`:
 *   - _get_next_journal     → getNextJournal()
 *     allocates from nparm.np_nexjrnl
 *   - _get_next_id          → getNextId()
 *     allocates from nextid table (used for stran/ptran/atran/ntran ids)
 *   - increment_atype_entry → incrementAtypeEntry()
 *     allocates the next aentry number from atype.ay_entry, with the
 *     defensive duplicate-check that walks the counter forward when
 *     it gets out of sync with aentry
 *
 * All three are designed to be called WITHIN an open transaction so
 * UPDLOCK + ROWLOCK on the SELECT prevents two concurrent posters
 * picking the same number. The first argument is therefore a
 * `Knex.Transaction` (alias `trx: Knex`) rather than a raw db handle.
 *
 * Per CLAUDE.md mandatory locking rules: NEVER use MAX(...)+1 to
 * allocate a sequence. ALWAYS allocate via these helpers.
 */
import type { Knex } from 'knex';

/**
 * Allocate the next journal number(s) from nparm.np_nexjrnl.
 *
 * Returns the FIRST allocated journal number; caller uses
 * `first..first+count-1`. Defaults `count=1`.
 *
 * UPDLOCK + ROWLOCK on the read serialises concurrent SAM allocators.
 *
 * Bug 3 hardening (2026-06-05 production audit): Opera Desktop /
 * Zahara / other integrations write to ntran but do NOT update
 * nparm.np_nexjrnl. On the live cloudsis DB at audit time, nparm
 * said next=201 but MAX(nt_jrnl) in the current year was 6650 — a
 * SAM allocation of 201 would have been safe today only because
 * Desktop happened not to have used 201, but the next time the two
 * ranges overlap we'd collide and overwrite a Desktop journal. The
 * fix: take MAX(nparm.np_nexjrnl, MAX(nt_jrnl in current year) + 1)
 * so we never allocate below the high-water mark regardless of
 * what other posting sources are doing.
 *
 * Year scope: nt_jrnl is unique within (nt_year, nt_jrnl) rather
 * than globally, so the MAX is scoped to the current open year per
 * nparm.np_year.
 */
export async function getNextJournal(
  trx: Knex,
  count: number = 1,
): Promise<number> {
  const rows = (await trx.raw(
    `SELECT
       np.np_nexjrnl AS nparm_next,
       np.np_year    AS curr_year,
       (SELECT MAX(nt_jrnl) FROM ntran WITH (NOLOCK)
          WHERE nt_year = np.np_year) AS ntran_max
     FROM nparm np WITH (UPDLOCK, ROWLOCK)`,
  )) as unknown as Array<{
    nparm_next: number | null;
    curr_year: number | null;
    ntran_max: number | null;
  }>;
  const row = Array.isArray(rows) ? rows[0] : undefined;
  const nparmNext = row?.nparm_next != null ? Number(row.nparm_next) : 1;
  const ntranMax = row?.ntran_max != null ? Number(row.ntran_max) : 0;
  const desktopFloor = ntranMax + 1;
  const next = Math.max(nparmNext, desktopFloor);
  await trx.raw(
    `UPDATE nparm WITH (ROWLOCK) SET np_nexjrnl = ?`,
    [next + count],
  );
  return next;
}

/**
 * Allocate the next id(s) from the nextid table for a given table.
 *
 * Opera maintains a `nextid` table with a row per table holding the
 * next available `id` value. Throws if no row exists for `tablename`
 * (Opera SE only — Opera 3 doesn't have nextid).
 */
export async function getNextId(
  trx: Knex,
  tablename: string,
  count: number = 1,
): Promise<number> {
  const rows = (await trx.raw(
    `SELECT nextid FROM nextid WITH (UPDLOCK, ROWLOCK)
     WHERE RTRIM(tablename) = ?`,
    [tablename],
  )) as unknown as Array<{ nextid: number | null }>;
  if (!Array.isArray(rows) || rows.length === 0 || rows[0]?.nextid == null) {
    throw new Error(`No nextid row found for table '${tablename}'`);
  }
  const next = Number(rows[0].nextid);
  await trx.raw(
    `UPDATE nextid WITH (ROWLOCK)
     SET nextid = ?, datemodified = GETDATE()
     WHERE RTRIM(tablename) = ?`,
    [next + count, tablename],
  );
  return next;
}

/**
 * Allocate the next aentry number for a cashbook type.
 *
 * Reads ay_entry from atype with UPDLOCK, then verifies the entry
 * doesn't already exist in aentry (defensive check — Opera can write
 * entries directly, leaving atype's counter behind). Walks the
 * counter forward until an unused number is found, up to 100
 * attempts.
 *
 * The atype.ay_entry field is updated to one PAST the allocated
 * number, ready for the next caller.
 *
 * Format is `{cbtype}{N:08d}` — e.g. cbtype='P1' → 'P100008024'.
 *
 * Throws if the cbtype isn't in atype, or if 100 sequential entries
 * are already taken (extremely unlikely; signals corrupted state).
 */
export async function incrementAtypeEntry(
  trx: Knex,
  cbtype: string,
): Promise<string> {
  const rows = (await trx.raw(
    `SELECT ay_entry FROM atype WITH (UPDLOCK, ROWLOCK)
     WHERE RTRIM(ay_cbtype) = ?`,
    [cbtype],
  )) as unknown as Array<{ ay_entry: string | null }>;
  if (!Array.isArray(rows) || rows.length === 0) {
    throw new Error(`Type code '${cbtype}' not found in atype`);
  }

  const initial = (rows[0]?.ay_entry ?? '').toString().trim();
  const fallback = `${cbtype}${'0'.padStart(8, '0')}`;
  let current = initial || fallback;

  const prefixLen = cbtype.length;
  let entryNum: number;
  try {
    entryNum = Number.parseInt(current.slice(prefixLen), 10);
    if (!Number.isFinite(entryNum)) entryNum = 0;
  } catch {
    entryNum = 0;
  }

  // Defensive forward-walk: skip past any already-existing entries.
  let skipped = 0;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const existsRows = (await trx.raw(
      `SELECT 1 AS x FROM aentry WITH (NOLOCK)
       WHERE RTRIM(ae_cbtype) = ? AND RTRIM(ae_entry) = ?`,
      [cbtype, current],
    )) as unknown as Array<{ x: number | null }>;
    if (!Array.isArray(existsRows) || existsRows.length === 0) {
      break; // unused — we can claim it
    }
    skipped++;
    if (skipped > 100) {
      throw new Error(
        `Unable to find unused entry number for cbtype '${cbtype}' after 100 attempts`,
      );
    }
    entryNum++;
    current = `${cbtype}${entryNum.toString().padStart(8, '0')}`;
  }

  const nextEntry = `${cbtype}${(entryNum + 1).toString().padStart(8, '0')}`;
  await trx.raw(
    `UPDATE atype WITH (ROWLOCK)
     SET ay_entry = ?, datemodified = GETDATE()
     WHERE RTRIM(ay_cbtype) = ?`,
    [nextEntry, cbtype],
  );
  return current;
}
