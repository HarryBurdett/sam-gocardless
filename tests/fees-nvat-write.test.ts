/**
 * Test for ERROR finding in the 2026-06-08 snapshot-vs-code audit:
 *
 * sam-gocardless `postFeesEntry` does not write an nvat row when VAT
 * applies to the fees. Legacy Python (opera_sql_import.py:6347-6383)
 * writes nvat for VAT tracking. Sister bank-rec project writes nvat
 * at import-posting-executor.ts:1806-1834. The GoCardless snapshot
 * confirms nvat receives a row when fees-with-VAT is posted.
 *
 * Without nvat the fees VAT reclaim is invisible to Opera's
 * VAT-return report — operators would under-claim recoverable VAT.
 *
 * This test asserts the postFeesEntry function body contains an
 * INSERT INTO nvat statement that is structurally well-formed
 * (column count = value count).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

function countColumnsAndValues(sql: string): { columns: number; values: number } {
  const colsMatch = sql.match(/INSERT INTO \w+\s*\(([^)]+)\)\s*VALUES/i);
  if (!colsMatch) throw new Error('No INSERT INTO ... VALUES found');
  const columns = colsMatch[1]
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0).length;

  const valsMatch = sql.match(/VALUES\s*\(([\s\S]+)\)\s*$/m);
  if (!valsMatch) throw new Error('No VALUES (...) found');
  const valsSection = valsMatch[1];

  let depth = 0;
  let inString = false;
  let count = 1;
  for (let i = 0; i < valsSection.length; i++) {
    const ch = valsSection[i];
    if (inString) {
      if (ch === "'") {
        if (valsSection[i + 1] === "'") i++;
        else inString = false;
      }
      continue;
    }
    if (ch === "'") inString = true;
    else if (ch === '(') depth++;
    else if (ch === ')') depth--;
    else if (ch === ',' && depth === 0) count++;
  }
  return { columns, values: count };
}

function extractPostFeesEntryBody(src: string): string {
  const start = src.indexOf('async function postFeesEntry');
  if (start === -1) throw new Error('postFeesEntry not found in source');
  // Find the function's closing brace by counting braces from the opening {
  const openBrace = src.indexOf('{', start);
  let depth = 1;
  let i = openBrace + 1;
  while (i < src.length && depth > 0) {
    const ch = src[i];
    if (ch === '{') depth++;
    else if (ch === '}') depth--;
    i++;
  }
  return src.slice(start, i);
}

describe('postFeesEntry — nvat write for VAT tracking', () => {
  const src = readFileSync(
    fileURLToPath(new URL('../src/services/batch-posting-executor.ts', import.meta.url)),
    'utf8',
  );
  const body = extractPostFeesEntryBody(src);

  it('postFeesEntry contains an INSERT INTO nvat statement', () => {
    expect(body).toMatch(/INSERT INTO nvat\s*\(/i);
  });

  it('the nvat INSERT statement has matching column and value counts', () => {
    // Match the COMPLETE INSERT — column list AND VALUES list — by
    // pairing both parentheses groups explicitly. The non-greedy
    // `\n\s*\)` anchor stops at the FIRST close-paren on its own line,
    // which is the close of the VALUES list.
    const matches = body.match(/INSERT INTO nvat\s*\([^)]+\)\s*VALUES\s*\([\s\S]*?\n\s*\)/g) ?? [];
    expect(matches.length).toBeGreaterThan(0);
    for (const stmt of matches) {
      const { columns, values } = countColumnsAndValues(stmt);
      expect(values, `nvat INSERT — ${values} values for ${columns} columns:\n${stmt.slice(0, 200)}...`).toBe(columns);
    }
  });

  it('the nvat write is conditioned on vatAmount > 0 (no unconditional write)', () => {
    // The nvat INSERT should live inside an if-block that gates on VAT
    // presence (hasVatLine or vatAmount > 0). If we ever see it outside
    // such a block, fees-without-VAT would emit a meaningless nvat row.
    const nvatIdx = body.indexOf('INSERT INTO nvat');
    if (nvatIdx === -1) {
      // Already failed by previous test; nothing more to check.
      return;
    }
    // Walk backwards from the INSERT to find the enclosing if-block.
    // Count `}` and `{` to find the start of the enclosing block.
    let depth = 0;
    let j = nvatIdx;
    let enclosingIfIdx = -1;
    while (j >= 0) {
      const ch = body[j];
      if (ch === '}') depth++;
      else if (ch === '{') {
        if (depth === 0) {
          // Found the enclosing block opening — look backwards a bit
          // to see if there's an `if (...hasVat|vatAmount...)` before it.
          const before = body.slice(Math.max(0, j - 200), j);
          if (/if\s*\(.*(hasVatLine|vatAmount\s*>\s*0)/.test(before)) {
            enclosingIfIdx = j;
            break;
          }
          // Otherwise keep walking up to next enclosing block.
          depth--;
        } else {
          depth--;
        }
      }
      j--;
    }
    expect(
      enclosingIfIdx,
      'nvat INSERT must be inside an if-block that gates on hasVatLine or vatAmount > 0',
    ).toBeGreaterThan(-1);
  });
});
