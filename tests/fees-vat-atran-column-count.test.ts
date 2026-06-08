/**
 * Test for CRITICAL finding in the 2026-06-08 snapshot-vs-code audit:
 *
 * postFeesEntry's VAT-line atran INSERT had 52 columns declared but
 * 54 values supplied — SQL Server would reject the statement at
 * runtime for any fees batch with vatOnFees > 0. The bug was hidden
 * because pre-Bug-1-fix `hasVatLine` was usually false, so this
 * branch never executed. The Bug 1 fix (assertVatLineCanBePosted)
 * forces hasVatLine to be true once VAT is configured, exposing this
 * runtime defect.
 *
 * This test asserts that every fees INSERT INTO atran statement
 * emitted with vatOnFees > 0 has equal column and value counts.
 */
import { describe, it, expect } from 'vitest';

/**
 * Parse an `INSERT INTO atran (col1, col2, ...) VALUES (val1, val2, ...)`
 * statement and return the column count and value count.
 *
 * Handles VALUES expressions with quoted strings, parameter placeholders
 * (`?`), and numeric literals across multiple physical lines.
 */
function countColumnsAndValues(sql: string): { columns: number; values: number } {
  // Extract the column list — between first '(' and matching ')'
  const colsMatch = sql.match(/INSERT INTO \w+\s*\(([^)]+)\)\s*VALUES/i);
  if (!colsMatch) throw new Error('No INSERT INTO ... VALUES found');
  const colsSection = colsMatch[1];
  const columns = colsSection
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0).length;

  // Extract the values section — everything between VALUES ( and the
  // closing ) before the next clause or end-of-string.
  const valsMatch = sql.match(/VALUES\s*\(([\s\S]+)\)\s*$/m);
  if (!valsMatch) throw new Error('No VALUES (...) found');
  const valsSection = valsMatch[1];

  // Split on top-level commas (commas not inside single-quoted strings).
  // A value can be: '...', ?, number, or an identifier.
  let depth = 0;
  let inString = false;
  let count = 1; // start with 1; each top-level comma adds another
  for (let i = 0; i < valsSection.length; i++) {
    const ch = valsSection[i];
    if (inString) {
      if (ch === "'") {
        // Handle SQL escape '' inside a string
        if (valsSection[i + 1] === "'") {
          i++; // skip the escape
        } else {
          inString = false;
        }
      }
      continue;
    }
    if (ch === "'") {
      inString = true;
      continue;
    }
    if (ch === '(') depth++;
    else if (ch === ')') depth--;
    else if (ch === ',' && depth === 0) count++;
  }
  return { columns, values: count };
}

describe('postFeesEntry — fees VAT atran INSERT statement well-formedness', () => {
  it('countColumnsAndValues sanity check on a known-good statement', () => {
    // The fees NET-line INSERT shape (52 cols, 52 values per audit verification)
    const sql = `INSERT INTO atran (
        id, at_acnt, at_cntr, at_cbtype, at_entry, at_inputby,
        at_type, at_pstdate, at_sysdate, at_tperiod, at_value,
        at_disc, at_fcurr, at_fcexch, at_fcmult, at_fcdec,
        at_account, at_name, at_comment, at_payee, at_payname,
        at_sort, at_number, at_remove, at_chqprn, at_chqlst,
        at_bacprn, at_ccdprn, at_ccdno, at_payslp, at_pysprn,
        at_cash, at_remit, at_unique, at_postgrp, at_ccauth,
        at_refer, at_srcco, at_ecb, at_ecbtype, at_atpycd,
        at_bsref, at_bsname, at_vattycd, at_project, at_job,
        at_bic, at_iban, at_memo, datecreated, datemodified, state
      ) VALUES (
        ?, ?, '    ', ?, ?, ?,
        1, ?, ?, 1, ?,
        0, '   ', 1.0, 0, 2,
        ?, 'GoCardless fees', '', '        ', '',
        '        ', '         ', 0, 0, 0,
        0, 0, '', 0, 0,
        0, 0, ?, 0, '0       ',
        ?, 'I', 0, ' ', '      ',
        '', '', '  ', '        ', '        ',
        '', '', '', ?, ?, 1
      )`;
    const { columns, values } = countColumnsAndValues(sql);
    expect(columns).toBe(52);
    expect(values).toBe(52);
  });

  it('countColumnsAndValues detects the original buggy VAT-line shape (54 values, 52 columns)', () => {
    // Pre-fix SQL — what was committed before the snapshot audit caught it
    const buggySql = `INSERT INTO atran (
        id, at_acnt, at_cntr, at_cbtype, at_entry, at_inputby,
        at_type, at_pstdate, at_sysdate, at_tperiod, at_value,
        at_disc, at_fcurr, at_fcexch, at_fcmult, at_fcdec,
        at_account, at_name, at_comment, at_payee, at_payname,
        at_sort, at_number, at_remove, at_chqprn, at_chqlst,
        at_bacprn, at_ccdprn, at_ccdno, at_payslp, at_pysprn,
        at_cash, at_remit, at_unique, at_postgrp, at_ccauth,
        at_refer, at_srcco, at_ecb, at_ecbtype, at_atpycd,
        at_bsref, at_bsname, at_vattycd, at_project, at_job,
        at_bic, at_iban, at_memo, datecreated, datemodified, state
      ) VALUES (
        ?, ?, '    ', ?, ?, ?,
        1, ?, ?, 1, ?,
        0, '   ', 1.0, 0, 2,
        ?, 'GoCardless fees VAT', '', '        ', '',
        '        ', '         ', 0, 0, 0,
        0, 0, '', 0, 0,
        0, 0, ?, 0, '0       ',
        ?, 'I', 0, ' ', '      ',
        '', '', '  ', '        ', '        ',
        '', '', ?, '', '', ?, ?, 1
      )`;
    const { columns, values } = countColumnsAndValues(buggySql);
    expect(columns).toBe(52);
    expect(values).toBe(54); // confirms the audit's count
  });

  it('every INSERT INTO atran in postFeesEntry has matching column and value counts', async () => {
    // Capture the actual SQL strings the production code would emit
    // by stubbing trx.raw and walking the postFeesEntry path with
    // vatOnFees > 0. Using a fake Knex that captures every .raw()
    // call. The function reads from many tables — we return the
    // minimum shape each needs so it gets to the INSERTs.
    const sqlsCaptured: string[] = [];

    const fakeRow = (col: string, val: unknown) => ({ [col]: val });
    const trx: any = {
      raw: async (sql: string, _bindings?: unknown[]) => {
        sqlsCaptured.push(sql);
        const lower = sql.toLowerCase();
        // VAT codes lookup — must return a row with our feesVatCode
        if (lower.includes('select') && lower.includes('vat') && lower.includes('rate')) {
          // Best-effort match for fetchVatCodesWithRates' query
          return [{ code: 'S20', nominal_account: 'V1100', rate: 20 }];
        }
        // getNacntType — return a default na_type/subt
        if (lower.includes('na_type') && lower.includes('na_subt')) {
          return [{ na_type: 'P ', na_subt: 'HA' }];
        }
        // getNextJournal (post-Bug-3 shape)
        if (lower.includes('nparm_next') || lower.includes('np_nexjrnl')) {
          if (lower.startsWith('update')) return [];
          return [fakeRow('nparm_next', 1000), { curr_year: 2026, ntran_max: 999 }];
        }
        // getNextId
        if (lower.includes('select nextid from nextid')) {
          return [{ nextid: 5000 }];
        }
        if (lower.includes('select ay_entry from atype')) {
          return [{ ay_entry: 'P100000001' }];
        }
        if (lower.includes('select 1 as x from aentry')) {
          return [];
        }
        // updateNacntBalance/updateNbankBalance/etc. — best-effort
        if (lower.startsWith('update') || lower.startsWith('insert')) {
          return [];
        }
        // Default: empty result
        return [];
      },
    };

    // Reach in and call postFeesEntry — but it's not exported. We'll
    // instead extract all INSERT INTO atran SQL bodies from the
    // source file and check each for column/value count balance.
    const fs = await import('node:fs/promises');
    const src = await fs.readFile(
      new URL('../src/services/batch-posting-executor.ts', import.meta.url),
      'utf8',
    );
    // Match every `INSERT INTO atran (... ) VALUES ( ... )` block in the file.
    // Greedy match across newlines, until the closing ) before the comma in the
    // trx.raw call.
    const matches: string[] = [];
    const re = /INSERT INTO atran\s*\([^)]+\)\s*VALUES\s*\([\s\S]*?\n\s*\)/g;
    let m;
    while ((m = re.exec(src)) !== null) {
      matches.push(m[0]);
    }
    expect(matches.length).toBeGreaterThan(0);

    for (let i = 0; i < matches.length; i++) {
      const { columns, values } = countColumnsAndValues(matches[i]);
      expect(
        values,
        `INSERT INTO atran #${i + 1} has ${values} VALUES for ${columns} columns — SQL Server will reject this. Snippet:\n${matches[i].slice(0, 200)}...`,
      ).toBe(columns);
    }
  });
});
