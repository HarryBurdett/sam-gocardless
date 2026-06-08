# Journal-posting bugs found in production audit (2026-06-05)

**Status:**
- Bug 1 (VAT leg drop) — **FIXED 2026-06-08** in commit `dea521e`
- Bug 2 (njmemo regression) — **WITHDRAWN** as false positive after investigation
- Bug 3 (journal-numbering collision risk) — **FIXED 2026-06-08** in commit `05d5d1d`
- Corrective journals for the 7 live unbalanced fees entries — **NOT done** (will be addressed when working on live data per operator instruction 2026-06-08)

**Captured:** 2026-06-05
**Updated:** 2026-06-08
**Scope:** this repo (sam-gocardless) — also see equivalent memo in `bank-rec` for shared issues

## How this was found

Read-only audit of live Opera SE databases run on 2026-06-05 (host `172.17.172.99`, companies `Opera3SECompany00C` / `Opera3SECompany00I` / `Opera3SECompany00Z`).

Audit scripts retained at `/Users/maccb/sam-Bankrec/repo/tools/audit-journals-final.ts` and siblings — can be re-run any time to reverify findings or check whether bugs have been fixed.

Audited code: `HarryBurdett/sam-gocardless@main`, latest commit on the affected file was `f2d8fa2` (2026-05-18 "cross-pstid ntran balance check on transfer auto-leg").

---

## Bug 1 — VAT leg silently dropped on GoCardless fees posting (HIGH — LIVE ACCOUNTING DRIFT)

**File:** `src/services/batch-posting-executor.ts` — function `postFeesEntry` (~lines 683-865)
**Last touched:** commit `f2d8fa2` (2026-05-18) — the targeted balance fix in that commit did **not** address this case
**Detected in production:** 7 unbalanced journals as of 2026-06-05

### The bug

```typescript
const grossFees = Math.abs(args.grossFees);
const vatAmount = Math.abs(args.vatOnFees);
const netFees = grossFees - vatAmount;        // ALWAYS subtracts VAT

let vatNominalAccount = '';
if (vatAmount > 0) {
  try {
    const vatCodes = await fetchVatCodesWithRates(trx, refDate);
    const code = vatCodes.vatCodes.find((v) => v.code === args.feesVatCode);
    if (code) vatNominalAccount = code.nominal_account;
  } catch {
    // proceed without VAT nominal — line will be skipped
  }
}

const hasVatLine = vatAmount > 0 && !!vatNominalAccount;
ntranCount = hasVatLine ? 3 : 2;
```

The three branches that follow then write:
1. DR fees expense = `netFees` (always — already reduced by VAT)
2. DR VAT = `vatAmount` (only if `hasVatLine`)
3. CR bank = `-grossFees` (always — full gross)

**Failure mode:** when `vatAmount > 0` but `vatNominalAccount` cannot be resolved (lookup throws, VAT code not found, or VAT code has no `nominal_account` configured), the VAT leg is silently skipped — but `netFees` is still reduced and the bank leg is still gross. Result: journal is short on DR by exactly the VAT amount.

The `vatAmount` IS known (passed in `args.vatOnFees`, displayed in the UI). Only the destination account is in doubt. The code conditions on "where to post" but treats it as "whether to post", which is wrong.

### Production evidence (7 broken journals)

| Company | Journal | Posted | DR leg | CR leg | Missing VAT |
|---|---|---|---|---|---|
| cloudsis | 185 | 2026-05-18 | GC090 £142.03 | BB040 −£170.43 | −£28.40 |
| cloudsis | 199 | 2026-05-19 | GC090 £4.00 | BB040 −£4.80 | −£0.80 |
| intsys | 1048 | 2026-05-08 | GA030 £4.00 | BC040 −£4.80 | −£0.80 |
| intsys | 1071 | 2026-05-15 | GA030 £9.10 | BC040 −£10.92 | −£1.82 |
| intsys | 1090 | 2026-05-18 | GA030 £48.31 | BC040 −£57.98 | −£9.67 |
| intsys | 1122 | 2026-05-19 | GA030 £28.07 | BC040 −£33.69 | −£5.62 |
| intsys | 1125 | 2026-05-20 | GA030 £4.00 | BC040 −£4.80 | −£0.80 |

**Total VAT-input lost across the 7 entries: £47.91** — not recorded on the balance sheet, not recoverable from HMRC, and trial balance is off by the same.

### Snapshot invariant violated

`opera-knowledge-ref/.../opera_se/sop_invoice_*.json` shows the canonical 3-leg pattern for any VAT-bearing transaction:
- VAT leg (its own line)
- NET fee/sales/expense leg
- GROSS contra (bank/customer)

There is no snapshot in the library that shows a 2-leg VAT-bearing transaction. The snapshot encodes a non-negotiable invariant; this code violates it.

The code references the legacy Python source (`opera_sql_import.py:6549-6571` etc.) in comments — "faithful port" — but does not reference the snapshot. The legacy Python had the same silent-drop bug; the port preserved it. The snapshot was created precisely to prevent this class of bug being inherited.

### Recommended fix

Either of the following — pick based on operator-experience preference:

**Option A — loud failure (recommended):**
```typescript
if (vatAmount > 0 && !vatNominalAccount) {
  throw new Error(
    `Cannot post GoCardless fees journal: VAT amount is £${vatAmount.toFixed(2)} ` +
    `but VAT code '${args.feesVatCode}' has no nominal_account configured. ` +
    `Set the VAT nominal in Opera VAT code maintenance.`,
  );
}
```
Operator sees a clear, actionable error. No corrupt journal is written.

**Option B — fall back to gross-on-fees (lossy but balanced):**
```typescript
const feesAmount = hasVatLine ? netFees : grossFees;
// post DR fees = feesAmount, DR VAT (if hasVatLine), CR bank = -grossFees
```
Journal balances. VAT is rolled into the expense line and not separately recoverable. Same loss of VAT input as today but at least books reconcile.

### Corrective journals needed for the 7 broken entries

Each existing 2-leg journal needs a 3rd leg adding to bring it to balance. The shape is a DR to the VAT-input nominal for the missing amount:

```sql
-- per journal, with appropriate VAT-input nominal account for the company
INSERT INTO ntran (
  nt_acnt, nt_jrnl, nt_value, nt_posttyp, nt_trtype, nt_inp,
  nt_cmnt, nt_entr, nt_year, nt_period, nt_pstid, ...
) VALUES (
  '<vat_input_nominal>', <jrnl>, <missing_amount>, 'N', 'A', 'CORRECT',
  'GoCardless fees VAT — correcting entry 2026-06-05',
  ...
);
```

Recommend running these corrections in a single transaction per company, after the code fix lands, with operator review of each entry first.

---

## ~~Bug 2 — `njmemo` coverage regression~~ — **WITHDRAWN 2026-06-08** (false positive)

The original audit reported GOCARDLS-source journals at 38-62%
njmemo coverage vs ZAHARA / Desktop at 100%, attributing the gap to
this app. **Investigation showed this is not a bug in this repo.**

The `nt_inp = 'GOCARDLS'` marker is written by **two distinct
codebases** that both run against the same Opera SE databases:
- This TypeScript repo (`sam-gocardless`)
- Legacy Python at `/Users/maccb/llmragsql/sql_rag/opera_sql_import.py`
  and `apps/gocardless/api/routes.py` (~line 858, 3409, 3802, 6195)

Both write `input_by="GOCARDLS"` (8 chars). The audit can't
distinguish their writes from `nt_inp` alone, so the coverage
percentage is a blend of both systems.

Verified by reading every `INSERT INTO ntran` site in
`batch-posting-executor.ts` and confirming each is paired with an
`insertNjmemo` call:

- `:472, :512` (insertNtranPair helper, used for receipts) → caller at `:1907`
- `:776, :822, :865` (postFeesEntry NL legs) → `:904`
- `:1479, :1523` (postDestinationTransfer pair) → `:1565`

Every code path in this repo that writes ntran also writes njmemo
in the same transaction. The 38-62% coverage figure is attributable
to the legacy Python paths, not this app.

**No fix needed in this repo.** If the legacy Python ever needs an
njmemo-coverage audit, the equivalent helper is `_insert_njmemo` in
`opera_sql_import.py` (~lines 709-741) and the call sites in
`apps/gocardless/api/routes.py`.

---

## Bug 3 — Journal-numbering collision risk (LOW today, will bite later)

**File:** wherever `getNextJournal(trx, count)` is called — currently allocates from `nparm.np_nexjrnl` only.

### The situation

Two posting paths run against the same Opera SE database:

- **SAM apps** (gocardless, bank-rec) read and increment `nparm.np_nexjrnl` atomically (UPDLOCK + UPDATE).
- **Opera Desktop / Zahara / other integrations** allocate by their own mechanism (likely `MAX(nt_jrnl) + 1` within their own session). They do NOT update `nparm.np_nexjrnl`.

Today on production:
- cloudsis: SAM next = 201, but `MAX(nt_jrnl)` = 6650
- intsys: SAM next = 1127, but `MAX(nt_jrnl)` = 48541

The numbers are far apart and not currently colliding — the next SAM allocation (201 / 1127) is empirically unused in ntran. **But this is luck, not design.** If Desktop ever happens to write into the low range SAM is currently iterating through, both systems will independently allocate the same `nt_jrnl` and produce duplicate or mixed journals.

### Recommended fix

In `getNextJournal()` (currently a 2-statement UPDLOCK / UPDATE sequence):

```typescript
// Compute the safe next number across BOTH counters
const rows = await trx.raw(`
  SELECT
    (SELECT np_nexjrnl FROM nparm WITH (UPDLOCK, ROWLOCK)) AS nparm_next,
    (SELECT ISNULL(MAX(nt_jrnl), 0) + 1 FROM ntran
       WHERE nt_year = (SELECT np_year FROM nparm WITH (NOLOCK))) AS actual_next
`);
const next = Math.max(Number(rows[0].nparm_next), Number(rows[0].actual_next));
await trx.raw(`UPDATE nparm WITH (ROWLOCK) SET np_nexjrnl = ?`, [next + count]);
return next;
```

This guarantees we never hand out a number that Desktop (or any other source) has already used, regardless of how the other counter is managed.

Same fix needs to land in **both** `sam-gocardless` and `bank-rec` (and any other SAM app that posts journals).

---

## Cross-cutting question (architectural, not done here)

You noted in this session: *"why do we not verify that the transaction balances before we update opera?"*

This bug class — local check in one posting path, missing in another — is exactly what a pre-commit balance assertion would prevent. The current code constructs journals as a sequence of side-effects rather than as in-memory objects, so the natural `assert sum === 0` check has no place to live.

**Not in scope for this memo** (because your architectural intent is that each app owns its own posting code, not the SAM platform), but worth deciding per-app:
- Refactor each app's posting paths to build a `Journal` object (collection of legs) in memory, validate it (sum, leg-count, account-existence) before any SQL runs, then commit atomically.
- Same shape in every app — same `Journal` builder, copied locally per repo or extracted to a `_shared/opera/` helper.

---

## Opera 3 r/w functionality reminder

You also flagged Opera 3 read/write as a future project in this session. The full spec for the bank-reconcile equivalent is at `/Users/maccb/bank-rec/docs/superpowers/specs/2026-05-27-opera-3-rw-enhancement.md`. The same pattern applies to gocardless — likely 1-2 days of work per the earlier estimate:

1. Replace any three-part `Opera3SESystem.dbo.X` references with `ctx.db.operaSystem(table)` facade
2. Audit MSSQL-isms the FoxPro facade doesn't auto-translate (`WITH (NOLOCK)`, `TOP N`, `CONVERT`, `DATEDIFF`)
3. Confirm the Pegasus Opera 3 Write Agent's `/exec` endpoint accepts raw INSERT/UPDATE on `ntran`/`atran`/`anoml`, or add domain-RPC branches in posting paths

See the bank-rec spec for the full detail and rationale.

---

## How to re-verify (audit reproduction)

```bash
cd /Users/maccb/sam-Bankrec/repo
npx tsx tools/audit-journals-final.ts    # 7-check suite, read-only
npx tsx tools/audit-journals-v3.ts        # disambiguates whole-journal sums + njmemo by posting-type
```

Connects to `172.17.172.99:1433` as `n8n / possible` via tedious directly (knex/mssql connection was unreliable during the audit). All queries use `NOLOCK`. Safe to run while production is live.

---

## Trigger / when to start

These bugs are **production-live drift** but not blocking — pick up when ready. Suggested ordering:

1. **Bug 1 first** — it is actively losing VAT input on every fees-bearing GoCardless batch. Highest-cost-per-day to leave unfixed.
2. **Bug 2 next** — cosmetic in accounting terms but degrades audit trail. Pair with the next operator-facing release.
3. **Bug 3 last** — currently latent, no immediate damage, but should be hardened before it's relevant.
4. **Architectural balance-check refactor** — separate scoping discussion. Worth doing once before adding any more posting paths.
5. **Opera 3 r/w** — independent of all the above, trigger when first Opera 3 tenant is in sight.
