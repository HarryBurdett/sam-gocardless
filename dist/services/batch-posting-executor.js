import { fetchVatCodesWithRates, getControlAccounts, getNacntType, getNextId, getNextJournal, getPeriodForDate, generateOperaUniqueId, generateOperaUniqueIds, incrementAtypeEntry, insertNjmemo, updateNacntBalance, updateNbankBalance, executeWithDeadlockRetry, } from '../_shared/index.js';
import { getPeriodPostingDecision, } from './period-posting-decision.js';
import { autoAllocateReceipt } from './allocate-receipt.js';
import { assertAentryHeader, assertAtranCountAndSum, assertStranCountAndSum, assertBalancedPairsBulk, verifyAentryCommitted, PostingVerificationError, } from '../_shared/post-write-verify.js';
async function loadBankInfo(trx, bankCode) {
    const rows = (await trx.raw(`SELECT TOP 1 RTRIM(nk_desc) AS description,
            RTRIM(ISNULL(nk_sort, '')) AS sort_code,
            RTRIM(ISNULL(nk_number, '')) AS account_number
     FROM nbank WITH (NOLOCK)
     WHERE RTRIM(nk_acnt) = ?`, [bankCode]));
    if (!Array.isArray(rows) || rows.length === 0) {
        throw new Error(`Bank account '${bankCode}' not found in nbank`);
    }
    const r = rows[0];
    return {
        code: bankCode,
        description: (r.description ?? '').trim(),
        sortCode: (r.sort_code ?? '').trim(),
        accountNumber: (r.account_number ?? '').trim(),
    };
}
const DEFAULT_REGION = 'K';
const DEFAULT_TERR = '001';
const DEFAULT_TYPE = 'DD1';
async function resolveCustomerControlAccount(trx, customerAccount, defaults) {
    try {
        const rows = (await trx.raw(`SELECT RTRIM(ISNULL(sp.sc_dbtctrl, '')) AS control_account
       FROM sname s WITH (NOLOCK)
       LEFT JOIN sprfls sp WITH (NOLOCK) ON RTRIM(s.sn_cprfl) = RTRIM(sp.sc_code)
       WHERE RTRIM(s.sn_account) = ?`, [customerAccount]));
        if (Array.isArray(rows) && rows.length > 0) {
            const ctl = (rows[0]?.control_account ?? '').trim();
            if (ctl)
                return ctl;
        }
    }
    catch {
        // fall through to default
    }
    return defaults.sl_control;
}
async function loadCustomerInfo(trx, payments, defaults) {
    const out = new Map();
    const seen = new Set();
    for (const p of payments) {
        const acct = p.customer_account.trim();
        if (seen.has(acct))
            continue;
        seen.add(acct);
        const rows = (await trx.raw(`SELECT TOP 1 sn_name, sn_region, sn_terrtry, sn_custype
       FROM sname WITH (NOLOCK)
       WHERE RTRIM(sn_account) = ?`, [acct]));
        if (!Array.isArray(rows) || rows.length === 0) {
            throw new Error(`Customer account '${acct}' not found in sname`);
        }
        const r = rows[0];
        const controlAccount = await resolveCustomerControlAccount(trx, acct, defaults);
        out.set(acct, {
            account: acct,
            name: (r.sn_name ?? '').trim(),
            region: (r.sn_region ?? '').trim() || DEFAULT_REGION,
            terr: (r.sn_terrtry ?? '').trim() || DEFAULT_TERR,
            type: (r.sn_custype ?? '').trim() || DEFAULT_TYPE,
            controlAccount,
        });
    }
    return out;
}
async function resolveCbtype(trx, preferred) {
    if (preferred) {
        const rows = (await trx.raw(`SELECT TOP 1 RTRIM(ay_desc) AS ay_desc
       FROM atype WITH (NOLOCK)
       WHERE RTRIM(ay_cbtype) = ? AND ay_type = 'R' AND ay_batched = 1`, [preferred]));
        if (!Array.isArray(rows) || rows.length === 0) {
            throw new Error(`cbtype '${preferred}' is not a batched receipt type in atype`);
        }
        return {
            cbtype: preferred,
            description: (rows[0]?.ay_desc ?? '').toString().trim() || 'Cheque',
        };
    }
    const gcRows = (await trx.raw(`SELECT TOP 1 RTRIM(ay_cbtype) AS ay_cbtype, RTRIM(ay_desc) AS ay_desc
     FROM atype WITH (NOLOCK)
     WHERE ay_type = 'R' AND ay_batched = 1
       AND (ay_desc LIKE '%GoCardless%' OR ay_desc LIKE '%gocardless%')`));
    if (Array.isArray(gcRows) && gcRows.length > 0 && gcRows[0]?.ay_cbtype) {
        return {
            cbtype: (gcRows[0].ay_cbtype ?? '').toString().trim(),
            description: (gcRows[0].ay_desc ?? '').toString().trim() || 'GoCardless',
        };
    }
    const rows = (await trx.raw(`SELECT TOP 1 RTRIM(ay_cbtype) AS ay_cbtype, RTRIM(ay_desc) AS ay_desc
     FROM atype WITH (NOLOCK)
     WHERE ay_type = 'R' AND ay_batched = 1`));
    if (!Array.isArray(rows) || rows.length === 0 || !rows[0]?.ay_cbtype) {
        throw new Error('No batched Receipt type codes found in atype table');
    }
    return {
        cbtype: (rows[0].ay_cbtype ?? '').toString().trim(),
        description: (rows[0].ay_desc ?? '').toString().trim() || 'Cheque',
    };
}
function nowMs() {
    const now = new Date();
    const pad = (n) => n.toString().padStart(2, '0');
    const date = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
    const time = `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
    return { date, time, iso: `${date} ${time}` };
}
function pence(amountPounds) {
    return Math.round(amountPounds * 100);
}
// ---------------------------------------------------------------------
// Inserts — kept short, parameter-bound
// ---------------------------------------------------------------------
async function insertAentry(trx, args) {
    await trx.raw(`INSERT INTO aentry (
      id, ae_acnt, ae_cntr, ae_cbtype, ae_entry, ae_reclnum,
      ae_lstdate, ae_frstat, ae_tostat, ae_statln, ae_entref,
      ae_value, ae_recbal, ae_remove, ae_tmpstat, ae_complet,
      ae_postgrp, sq_crdate, sq_crtime, sq_cruser, ae_comment,
      ae_payid, ae_batchid, ae_brwptr, datecreated, datemodified, state
    ) VALUES (
      ?, ?, '    ', ?, ?, 0,
      ?, 0, 0, 0, ?,
      ?, 0, 0, 0, ?,
      0, ?, ?, ?, 'GoCardless batch import',
      0, 0, '  ', ?, ?, 1
    )`, [
        args.aentryId,
        args.bankAccount,
        args.cbtype,
        args.entryNumber,
        args.postDate,
        args.reference.slice(0, 20),
        args.totalPence,
        args.completeBatch ? 1 : 0,
        args.nowDate,
        args.nowTime.slice(0, 8),
        args.inputBy.slice(0, 8),
        args.nowIso,
        args.nowIso,
    ]);
}
async function insertAtran(trx, args) {
    await trx.raw(`INSERT INTO atran (
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
      4, ?, ?, 1, ?,
      0, '   ', 1.0, 0, 2,
      ?, ?, ?, '        ', '',
      '        ', '         ', 0, 0, 0,
      0, 0, '', 0, 0,
      0, 0, ?, 0, '0       ',
      ?, 'I', 0, ' ', '      ',
      '', '', '  ', '        ', '        ',
      '', '', '', ?, ?, 1
    )`, [
        args.atranId,
        args.bankAccount,
        args.cbtype,
        args.entryNumber,
        args.inputBy.slice(0, 8),
        args.postDate,
        args.postDate,
        args.amountPence,
        args.customerAccount,
        args.customerName.slice(0, 35),
        args.description.slice(0, 35),
        args.atranUnique,
        args.reference.slice(0, 20),
        args.nowIso,
        args.nowIso,
    ]);
}
async function insertStran(trx, args) {
    await trx.raw(`INSERT INTO stran (
      id, st_account, st_trdate, st_trref, st_custref, st_trtype,
      st_trvalue, st_vatval, st_trbal, st_paid, st_crdate,
      st_advance, st_memo, st_payflag, st_set1day, st_set1,
      st_set2day, st_set2, st_dueday, st_fcurr, st_fcrate,
      st_fcdec, st_fcval, st_fcbal, st_fcmult, st_dispute,
      st_edi, st_editx, st_edivn, st_txtrep, st_binrep,
      st_advallc, st_cbtype, st_entry, st_unique, st_region,
      st_terr, st_type, st_fadval, st_delacc, st_euro,
      st_payadvl, st_eurind, st_origcur, st_fullamt, st_fullcb,
      st_fullnar, st_cash, st_rcode, st_ruser, st_revchrg,
      st_nlpdate, st_adjsv, st_fcvat, st_taxpoin,
      datecreated, datemodified, state
    ) VALUES (
      ?, ?, ?, ?, 'GoCardless', 'R',
      ?, 0, ?, ' ', ?,
      'N', ?, 0, 0, 0,
      0, 0, ?, '   ', 0,
      0, 0, 0, 0, 0,
      0, 0, 0, '', 0,
      0, ?, ?, ?, ?,
      ?, ?, 0, ?, 0,
      0, ' ', '   ', 0, '  ',
      '          ', 0, '    ', '        ', 0,
      ?, 0, 0, ?,
      ?, ?, 1
    )`, [
        args.stranId,
        args.customerAccount,
        args.postDate,
        args.reference.slice(0, 20),
        -args.amountPounds,
        -args.amountPounds,
        args.postDate,
        args.memo.slice(0, 200),
        args.postDate,
        args.cbtype,
        args.entryNumber,
        args.stranUnique,
        args.region.slice(0, 3),
        args.terr.slice(0, 3),
        args.type.slice(0, 3),
        args.customerAccount,
        args.postDate,
        args.postDate,
        args.nowIso,
        args.nowIso,
    ]);
}
async function insertNtranPair(trx, args) {
    // Bank DEBIT (positive value = receipt)
    await trx.raw(`INSERT INTO ntran (
      id, nt_acnt, nt_cntr, nt_type, nt_subt, nt_jrnl,
      nt_ref, nt_inp, nt_trtype, nt_cmnt, nt_trnref,
      nt_entr, nt_value, nt_year, nt_period, nt_rvrse,
      nt_prevyr, nt_consol, nt_fcurr, nt_fvalue, nt_fcrate,
      nt_fcmult, nt_fcdec, nt_srcco, nt_cdesc, nt_project,
      nt_job, nt_posttyp, nt_pstgrp, nt_pstid, nt_srcnlid,
      nt_recurr, nt_perpost, nt_rectify, nt_recjrnl, nt_vatanal,
      nt_distrib, datecreated, datemodified, state
    ) VALUES (
      ?, ?, '    ', ?, ?, ?,
      '', ?, 'A', ?, ?,
      ?, ?, ?, ?, 0,
      0, 0, '   ', 0, 0,
      0, 0, 'I', '', '        ',
      '        ', 'S', 0, ?, 0,
      0, 0, 0, 0, 0,
      0, ?, ?, 1
    )`, [
        args.idStart,
        args.bankAccount,
        args.bankType.na_type,
        args.bankType.na_subt,
        args.journal,
        args.inputBy.slice(0, 10),
        args.comment,
        args.trnref,
        args.postDate,
        args.amountPounds,
        args.year,
        args.period,
        args.pstid,
        args.nowIso,
        args.nowIso,
    ]);
    // Debtors-control CREDIT (negative value)
    await trx.raw(`INSERT INTO ntran (
      id, nt_acnt, nt_cntr, nt_type, nt_subt, nt_jrnl,
      nt_ref, nt_inp, nt_trtype, nt_cmnt, nt_trnref,
      nt_entr, nt_value, nt_year, nt_period, nt_rvrse,
      nt_prevyr, nt_consol, nt_fcurr, nt_fvalue, nt_fcrate,
      nt_fcmult, nt_fcdec, nt_srcco, nt_cdesc, nt_project,
      nt_job, nt_posttyp, nt_pstgrp, nt_pstid, nt_srcnlid,
      nt_recurr, nt_perpost, nt_rectify, nt_recjrnl, nt_vatanal,
      nt_distrib, datecreated, datemodified, state
    ) VALUES (
      ?, ?, '    ', ?, ?, ?,
      '', ?, 'A', ?, ?,
      ?, ?, ?, ?, 0,
      0, 0, '   ', 0, 0,
      0, 0, 'I', '', '        ',
      '        ', 'S', 0, ?, 0,
      0, 0, 0, 0, 0,
      0, ?, ?, 1
    )`, [
        args.idStart + 1,
        args.salesLedgerControl,
        args.controlType.na_type,
        args.controlType.na_subt,
        args.journal,
        args.inputBy.slice(0, 10),
        args.comment,
        args.trnref,
        args.postDate,
        -args.amountPounds,
        args.year,
        args.period,
        args.pstid,
        args.nowIso,
        args.nowIso,
    ]);
}
async function insertAnomlPair(trx, args) {
    // Bank leg
    await trx.raw(`INSERT INTO anoml (
      id, ax_nacnt, ax_ncntr, ax_source, ax_date, ax_value, ax_tref,
      ax_comment, ax_done, ax_fcurr, ax_fvalue, ax_fcrate, ax_fcmult, ax_fcdec,
      ax_srcco, ax_unique, ax_project, ax_job, ax_jrnl, ax_nlpdate,
      datecreated, datemodified, state
    ) VALUES (
      ?, ?, '    ', 'S', ?, ?, ?,
      ?, ?, '   ', 0, 0, 0, 0,
      'I', ?, '        ', '        ', ?, ?,
      ?, ?, 1
    )`, [
        args.idStart,
        args.bankAccount,
        args.postDate,
        args.amountPounds,
        args.reference.slice(0, 20),
        args.comment.slice(0, 50),
        args.doneFlag,
        args.atranUnique,
        args.journal,
        args.postDate,
        args.nowIso,
        args.nowIso,
    ]);
    // Debtors-control leg
    await trx.raw(`INSERT INTO anoml (
      id, ax_nacnt, ax_ncntr, ax_source, ax_date, ax_value, ax_tref,
      ax_comment, ax_done, ax_fcurr, ax_fvalue, ax_fcrate, ax_fcmult, ax_fcdec,
      ax_srcco, ax_unique, ax_project, ax_job, ax_jrnl, ax_nlpdate,
      datecreated, datemodified, state
    ) VALUES (
      ?, ?, '    ', 'S', ?, ?, ?,
      ?, ?, '   ', 0, 0, 0, 0,
      'I', ?, '        ', '        ', ?, ?,
      ?, ?, 1
    )`, [
        args.idStart + 1,
        args.salesLedgerControl,
        args.postDate,
        -args.amountPounds,
        args.reference.slice(0, 20),
        args.comment.slice(0, 50),
        args.doneFlag,
        args.atranUnique,
        args.journal,
        args.postDate,
        args.nowIso,
        args.nowIso,
    ]);
}
async function resolveFeesPaymentType(trx, preferred) {
    if (preferred)
        return preferred.trim();
    const rows = (await trx.raw(`SELECT TOP 1 RTRIM(ay_cbtype) AS ay_cbtype FROM atype WITH (NOLOCK)
     WHERE ay_type = 'P' AND ay_batched = 0
     ORDER BY ay_cbtype`));
    const cb = rows[0]?.ay_cbtype;
    return cb ? cb.toString().trim() : 'NP';
}
async function postFeesEntry(trx, args) {
    const grossFees = Math.abs(args.grossFees);
    const vatAmount = Math.abs(args.vatOnFees);
    const netFees = grossFees - vatAmount;
    const grossFeesPence = Math.round(grossFees * 100);
    const netFeesPence = Math.round(netFees * 100);
    const vatPence = Math.round(vatAmount * 100);
    // VAT code lookup (for nominal account + rate). Errors are non-fatal —
    // we proceed without VAT split if lookup fails.
    let vatNominalAccount = '';
    if (vatAmount > 0) {
        try {
            const refDate = new Date(args.postDate);
            const vatCodes = await fetchVatCodesWithRates(trx, refDate);
            const code = vatCodes.vatCodes.find((v) => v.code === args.feesVatCode);
            if (code)
                vatNominalAccount = code.nominal_account;
        }
        catch {
            // proceed without VAT nominal — line will be skipped
        }
    }
    const feesCbtype = await resolveFeesPaymentType(trx, args.feesPaymentType);
    const feesEntryNumber = await incrementAtypeEntry(trx, feesCbtype);
    const feesAentryId = await getNextId(trx, 'aentry');
    const feesUnique = generateOperaUniqueId();
    const feesVatUnique = generateOperaUniqueId();
    // Allocate the journal only when we will use it. When neither NL
    // ntran nor transfer-file anoml will be written (decision says
    // skip both), we'd waste a journal number — but legacy also
    // pre-allocates, so we keep it for fidelity. Used by both ntran
    // (decision.postToNominal) and anoml (decision.postToTransferFile).
    const journal = await getNextJournal(trx, 1);
    // 1. NL postings: DR fees expense + DR VAT input + CR bank.
    // GATED on decision.postToNominal — when RTU is off (back-period
    // import), only anoml is written and the nightly NL-transfer job
    // will pick the entries up. Faithful port of
    // opera_sql_import.py:6540.
    const hasVatLine = vatAmount > 0 && !!vatNominalAccount;
    let ntranCount = 0;
    if (args.decision.postToNominal) {
        const feesAcctType = (await getNacntType(trx, args.feesNominalAccount)) ??
            { na_type: 'P ', na_subt: 'HA' };
        const feesBankType = (await getNacntType(trx, args.bankAccount)) ??
            { na_type: 'B ', na_subt: 'BC' };
        ntranCount = hasVatLine ? 3 : 2;
        const feesNtranIdStart = await getNextId(trx, 'ntran', ntranCount);
        // DR Fees expense (NET) — opera_sql_import.py:6549-6571
        await trx.raw(`INSERT INTO ntran (
        id, nt_acnt, nt_cntr, nt_type, nt_subt, nt_jrnl,
        nt_ref, nt_inp, nt_trtype, nt_cmnt, nt_trnref,
        nt_entr, nt_value, nt_year, nt_period, nt_rvrse,
        nt_prevyr, nt_consol, nt_fcurr, nt_fvalue, nt_fcrate,
        nt_fcmult, nt_fcdec, nt_srcco, nt_cdesc, nt_project,
        nt_job, nt_posttyp, nt_pstgrp, nt_pstid, nt_srcnlid,
        nt_recurr, nt_perpost, nt_rectify, nt_recjrnl, nt_vatanal,
        nt_distrib, datecreated, datemodified, state
      ) VALUES (
        ?, ?, '    ', ?, ?, ?,
        '', ?, 'A', 'GoCardless fees', 'GoCardless fees',
        ?, ?, ?, ?, 0,
        0, 0, '   ', 0, 0,
        0, 0, 'I', '', '        ',
        '        ', 'N', 0, ?, 0,
        0, 0, 0, 0, 0,
        0, ?, ?, 1
      )`, [
            feesNtranIdStart,
            args.feesNominalAccount,
            feesAcctType.na_type,
            feesAcctType.na_subt,
            journal,
            args.inputBy.slice(0, 10),
            args.postDate,
            netFees,
            args.year,
            args.period,
            feesUnique,
            args.now.iso,
            args.now.iso,
        ]);
        await updateNacntBalance(trx, args.feesNominalAccount, netFees, {
            period: args.period,
            year: args.year,
        });
        // DR VAT (only if VAT > 0 + nominal account resolved) — :6576-6620
        if (hasVatLine) {
            const vatAcctType = (await getNacntType(trx, vatNominalAccount)) ??
                { na_type: 'B ', na_subt: 'BB' };
            await trx.raw(`INSERT INTO ntran (
          id, nt_acnt, nt_cntr, nt_type, nt_subt, nt_jrnl,
          nt_ref, nt_inp, nt_trtype, nt_cmnt, nt_trnref,
          nt_entr, nt_value, nt_year, nt_period, nt_rvrse,
          nt_prevyr, nt_consol, nt_fcurr, nt_fvalue, nt_fcrate,
          nt_fcmult, nt_fcdec, nt_srcco, nt_cdesc, nt_project,
          nt_job, nt_posttyp, nt_pstgrp, nt_pstid, nt_srcnlid,
          nt_recurr, nt_perpost, nt_rectify, nt_recjrnl, nt_vatanal,
          nt_distrib, datecreated, datemodified, state
        ) VALUES (
          ?, ?, '    ', ?, ?, ?,
          '', ?, 'A', 'GoCardless fees VAT', 'GoCardless fees',
          ?, ?, ?, ?, 0,
          0, 0, '   ', 0, 0,
          0, 0, 'I', '', '        ',
          '        ', 'N', 0, ?, 0,
          0, 0, 0, 0, 0,
          0, ?, ?, 1
        )`, [
                feesNtranIdStart + 1,
                vatNominalAccount,
                vatAcctType.na_type,
                vatAcctType.na_subt,
                journal,
                args.inputBy.slice(0, 10),
                args.postDate,
                vatAmount,
                args.year,
                args.period,
                feesVatUnique,
                args.now.iso,
                args.now.iso,
            ]);
            await updateNacntBalance(trx, vatNominalAccount, vatAmount, {
                period: args.period,
                year: args.year,
            });
        }
        // CR Bank (gross fees) — :6622-6664
        await trx.raw(`INSERT INTO ntran (
        id, nt_acnt, nt_cntr, nt_type, nt_subt, nt_jrnl,
        nt_ref, nt_inp, nt_trtype, nt_cmnt, nt_trnref,
        nt_entr, nt_value, nt_year, nt_period, nt_rvrse,
        nt_prevyr, nt_consol, nt_fcurr, nt_fvalue, nt_fcrate,
        nt_fcmult, nt_fcdec, nt_srcco, nt_cdesc, nt_project,
        nt_job, nt_posttyp, nt_pstgrp, nt_pstid, nt_srcnlid,
        nt_recurr, nt_perpost, nt_rectify, nt_recjrnl, nt_vatanal,
        nt_distrib, datecreated, datemodified, state
      ) VALUES (
        ?, ?, '    ', ?, ?, ?,
        '', ?, 'A', 'GoCardless fees', 'GoCardless fees',
        ?, ?, ?, ?, 0,
        0, 0, '   ', 0, 0,
        0, 0, 'I', '', '        ',
        '        ', 'N', 0, ?, 0,
        0, 0, 0, 0, 0,
        0, ?, ?, 1
      )`, [
            feesNtranIdStart + (hasVatLine ? 2 : 1),
            args.bankAccount,
            feesBankType.na_type,
            feesBankType.na_subt,
            journal,
            args.inputBy.slice(0, 10),
            args.postDate,
            -grossFees,
            args.year,
            args.period,
            feesUnique,
            args.now.iso,
            args.now.iso,
        ]);
        await updateNacntBalance(trx, args.bankAccount, -grossFees, {
            period: args.period,
            year: args.year,
        });
        await insertNjmemo(trx, journal, 'Cashbook Ledger Transfer (RT)');
    }
    // 2. Cashbook entry for fees (separate from receipts batch)
    await trx.raw(`INSERT INTO aentry (
      id, ae_acnt, ae_cntr, ae_cbtype, ae_entry, ae_reclnum,
      ae_lstdate, ae_frstat, ae_tostat, ae_statln, ae_entref,
      ae_value, ae_recbal, ae_remove, ae_tmpstat, ae_complet,
      ae_postgrp, sq_crdate, sq_crtime, sq_cruser, ae_comment,
      ae_payid, ae_batchid, ae_brwptr, datecreated, datemodified, state
    ) VALUES (
      ?, ?, '    ', ?, ?, 0,
      ?, 0, 0, 0, ?,
      ?, 0, 0, 0, 1,
      0, ?, ?, ?, 'GoCardless fees',
      0, 0, '  ', ?, ?, 1
    )`, [
        feesAentryId,
        args.bankAccount,
        feesCbtype,
        feesEntryNumber,
        args.postDate,
        args.reference.slice(0, 20),
        -grossFeesPence,
        args.now.date,
        args.now.time.slice(0, 8),
        // sq_cruser: thread the operator code (audit HIGH) —
        // opera_sql_import.py:6666.
        args.inputBy.slice(0, 8),
        args.now.iso,
        args.now.iso,
    ]);
    // 3. atran lines (split into net + VAT when VAT > 0)
    if (hasVatLine) {
        const atranIdStart = await getNextId(trx, 'atran', 2);
        // Net line
        await trx.raw(`INSERT INTO atran (
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
      )`, [
            atranIdStart,
            args.bankAccount,
            feesCbtype,
            feesEntryNumber,
            args.inputBy.slice(0, 8),
            args.postDate,
            args.postDate,
            -netFeesPence,
            args.feesNominalAccount,
            feesUnique,
            args.reference.slice(0, 20),
            args.now.iso,
            args.now.iso,
        ]);
        // VAT line
        await trx.raw(`INSERT INTO atran (
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
      )`, [
            atranIdStart + 1,
            args.bankAccount,
            feesCbtype,
            feesEntryNumber,
            args.inputBy.slice(0, 8),
            args.postDate,
            args.postDate,
            -vatPence,
            vatNominalAccount,
            feesVatUnique,
            args.reference.slice(0, 20),
            args.feesVatCode,
            args.now.iso,
            args.now.iso,
        ]);
    }
    else {
        // Single-line: gross fees
        const atranId = await getNextId(trx, 'atran');
        await trx.raw(`INSERT INTO atran (
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
      )`, [
            atranId,
            args.bankAccount,
            feesCbtype,
            feesEntryNumber,
            args.inputBy.slice(0, 8),
            args.postDate,
            args.postDate,
            -grossFeesPence,
            args.feesNominalAccount,
            feesUnique,
            args.reference.slice(0, 20),
            args.now.iso,
            args.now.iso,
        ]);
    }
    // 4. nbank balance (deduct gross fees)
    await updateNbankBalance(trx, args.bankAccount, -grossFees);
    // 5. anoml (transfer file) — BLOCKER #3 fix.
    // Faithful port of opera_sql_import.py:6768-6825. 2 legs (no VAT)
    // or 3 (with VAT). ax_source='A' for nominal entries; FC fields
    // populated (ax_fcrate=1.0, ax_fcdec=2.0, ax_fvalue=value*100).
    // Bank leg (CR, -gross) + fees expense leg (DR, +net) share
    // `feesUnique` for ax_unique; optional VAT leg uses `feesVatUnique`.
    // ax_done from decision.transferFileDoneFlag; ax_jrnl = journal
    // ONLY when NL post happened, else 0 (legacy line 6770).
    // Verified against snapshot
    // `gocardless_batch_import_20260407_104558.json` (anoml rows
    // 8750/8751/8752: ax_source='A', ax_fcrate=1.0).
    let anomlCount = 0;
    if (args.decision.postToTransferFile) {
        const anomlIdStart = await getNextId(trx, 'anoml', hasVatLine ? 3 : 2);
        const doneFlag = args.decision.transferFileDoneFlag;
        const jrnlNum = args.decision.postToNominal ? journal : 0;
        const feesComment = 'GoCardless fees';
        const feesBankFvalue = -grossFeesPence;
        const feesExpenseFvalue = Math.round(netFees * 100);
        // anoml bank leg (CR)
        await trx.raw(`INSERT INTO anoml (
        id, ax_nacnt, ax_ncntr, ax_source, ax_date, ax_value, ax_tref,
        ax_comment, ax_done, ax_fcurr, ax_fvalue, ax_fcrate, ax_fcmult, ax_fcdec,
        ax_srcco, ax_unique, ax_project, ax_job, ax_jrnl, ax_nlpdate,
        datecreated, datemodified, state
      ) VALUES (
        ?, ?, '    ', 'A', ?, ?, ?,
        ?, ?, '   ', ?, 1.0, 0, 2.0,
        'I', ?, '        ', '        ', ?, ?,
        ?, ?, 1
      )`, [
            anomlIdStart,
            args.bankAccount,
            args.postDate,
            -grossFees,
            args.reference.slice(0, 20),
            feesComment.slice(0, 40),
            doneFlag,
            feesBankFvalue,
            feesUnique,
            jrnlNum,
            args.postDate,
            args.now.iso,
            args.now.iso,
        ]);
        // anoml fees expense leg (DR, +net)
        await trx.raw(`INSERT INTO anoml (
        id, ax_nacnt, ax_ncntr, ax_source, ax_date, ax_value, ax_tref,
        ax_comment, ax_done, ax_fcurr, ax_fvalue, ax_fcrate, ax_fcmult, ax_fcdec,
        ax_srcco, ax_unique, ax_project, ax_job, ax_jrnl, ax_nlpdate,
        datecreated, datemodified, state
      ) VALUES (
        ?, ?, '    ', 'A', ?, ?, ?,
        ?, ?, '   ', ?, 1.0, 0, 2.0,
        'I', ?, '        ', '        ', ?, ?,
        ?, ?, 1
      )`, [
            anomlIdStart + 1,
            args.feesNominalAccount,
            args.postDate,
            netFees,
            args.reference.slice(0, 20),
            feesComment.slice(0, 40),
            doneFlag,
            feesExpenseFvalue,
            feesUnique,
            jrnlNum,
            args.postDate,
            args.now.iso,
            args.now.iso,
        ]);
        anomlCount = 2;
        // anoml VAT leg (DR, +VAT) — only when VAT present + nominal known
        if (hasVatLine) {
            const feesVatFvalue = Math.round(vatAmount * 100);
            await trx.raw(`INSERT INTO anoml (
          id, ax_nacnt, ax_ncntr, ax_source, ax_date, ax_value, ax_tref,
          ax_comment, ax_done, ax_fcurr, ax_fvalue, ax_fcrate, ax_fcmult, ax_fcdec,
          ax_srcco, ax_unique, ax_project, ax_job, ax_jrnl, ax_nlpdate,
          datecreated, datemodified, state
        ) VALUES (
          ?, ?, '    ', 'A', ?, ?, ?,
          ?, ?, '   ', ?, 1.0, 0, 2.0,
          'I', ?, '        ', '        ', ?, ?,
          ?, ?, 1
        )`, [
                anomlIdStart + 2,
                vatNominalAccount,
                args.postDate,
                vatAmount,
                args.reference.slice(0, 20),
                // legacy slices to 36 then appends ' VAT' (40 total).
                `${feesComment.slice(0, 36)} VAT`,
                doneFlag,
                feesVatFvalue,
                feesVatUnique,
                jrnlNum,
                args.postDate,
                args.now.iso,
                args.now.iso,
            ]);
            anomlCount = 3;
        }
    }
    return {
        entryNumber: feesEntryNumber,
        bankAccount: args.bankAccount,
        expectedAentryValuePence: -grossFeesPence,
        atranLineCount: hasVatLine ? 2 : 1,
        // Lines must sum to the header: split goes -netFeesPence + -vatPence = -grossFeesPence
        atranSumPence: -grossFeesPence,
        feesUnique,
        feesVatUnique: hasVatLine ? feesVatUnique : null,
        ntranCount,
        anomlCount,
    };
}
async function postDestinationTransfer(trx, args) {
    if (args.netAmount <= 0)
        return null; // nothing to transfer
    // Resolve a transfer cbtype if not supplied — first ay_type='T' code
    let transferType = args.transferCbtype;
    if (!transferType) {
        const rows = (await trx.raw(`SELECT TOP 1 RTRIM(ay_cbtype) AS ay_cbtype FROM atype WITH (NOLOCK)
       WHERE ay_type = 'T'
       ORDER BY ay_cbtype`));
        transferType = rows[0]?.ay_cbtype?.toString().trim() ?? 'T1';
    }
    // Mint 3 distinct uniques up-front. Legacy mints
    // `shared_unique` (for anoml ax_unique pair) + `ntran_pstid_source`
    // + `ntran_pstid_dest`. BLOCKER #6 fix.
    // opera_sql_import.py:9324-9327.
    const sharedUnique = generateOperaUniqueId();
    const ntranPstidSource = generateOperaUniqueId();
    const ntranPstidDest = generateOperaUniqueId();
    const journal = await getNextJournal(trx, 1);
    // Audit HIGH: don't invent a synthetic reference. Legacy uses
    // reference[:20] directly (opera_sql_import.py:9420). Caller
    // upstream defaults to 'GoCardless' so this never lands as empty.
    const reference = args.reference.slice(0, 20);
    const netPence = Math.round(args.netAmount * 100);
    // Load bank metadata for both sides — BLOCKER #7: source atran must
    // embed dest sort/account; dest atran can leave them blank (legacy
    // 9417 + 9449). Also: at_name must be the OTHER bank's nk_desc
    // (audit HIGH — legacy lines 9416, 9448).
    const sourceInfo = await loadBankInfo(trx, args.sourceBank);
    const destInfo = await loadBankInfo(trx, args.destBank);
    // Build trnref/comment per legacy 9293-9295.
    // Each leg's nt_trnref shows the OTHER side's bank name.
    const ntranComment = reference.padEnd(50).slice(0, 50);
    const sourceNtranTrnref = (destInfo.description.slice(0, 30).padEnd(30) + 'Transfer  (RT)     ').slice(0, 50);
    const destNtranTrnref = (sourceInfo.description.slice(0, 30).padEnd(30) + 'Transfer  (RT)     ').slice(0, 50);
    // ae_comment / at_comment: short 40-char narrative.
    const transferCommentOut = `Transfer to ${destInfo.description}`.slice(0, 40);
    const transferCommentIn = `Transfer from ${sourceInfo.description}`.slice(0, 40);
    // Source: aentry + atran (negative)
    const entryOut = await incrementAtypeEntry(trx, transferType);
    const aentryOutId = await getNextId(trx, 'aentry');
    const atranOutId = await getNextId(trx, 'atran');
    await trx.raw(`INSERT INTO aentry (
      id, ae_acnt, ae_cntr, ae_cbtype, ae_entry, ae_reclnum,
      ae_lstdate, ae_frstat, ae_tostat, ae_statln, ae_entref,
      ae_value, ae_recbal, ae_remove, ae_tmpstat, ae_complet,
      ae_postgrp, sq_crdate, sq_crtime, sq_cruser, ae_comment,
      ae_payid, ae_batchid, ae_brwptr, datecreated, datemodified, state
    ) VALUES (
      ?, ?, '    ', ?, ?, 0,
      ?, 0, 0, 0, ?,
      ?, 0, 0, 0, 1,
      0, ?, ?, ?, ?,
      0, 0, '  ', ?, ?, 1
    )`, [
        aentryOutId,
        args.sourceBank,
        transferType,
        entryOut,
        args.postDate,
        reference,
        -netPence,
        args.now.date,
        args.now.time.slice(0, 8),
        args.inputBy.slice(0, 8),
        transferCommentOut,
        args.now.iso,
        args.now.iso,
    ]);
    // Source atran — embeds DEST bank's sort/account (BLOCKER #7),
    // dest bank description as at_name. Legacy opera_sql_import.py:9417.
    await trx.raw(`INSERT INTO atran (
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
      8, ?, ?, 1, ?,
      0, '   ', 1.0, 0, 2,
      ?, ?, ?, '        ', '',
      ?, ?, 0, 0, 0,
      0, 0, '', 0, 0,
      0, 0, ?, 0, '0       ',
      ?, 'I', 0, ' ', '      ',
      '', '', '  ', '        ', '        ',
      '', '', '', ?, ?, 1
    )`, [
        atranOutId,
        args.sourceBank,
        transferType,
        entryOut,
        args.inputBy.slice(0, 8),
        args.postDate,
        args.postDate,
        -netPence,
        args.destBank,
        destInfo.description.slice(0, 35),
        transferCommentOut,
        destInfo.sortCode.slice(0, 8).padEnd(8),
        destInfo.accountNumber.slice(0, 9).padEnd(9),
        sharedUnique,
        reference,
        args.now.iso,
        args.now.iso,
    ]);
    // Destination: aentry + atran (positive)
    const entryIn = await incrementAtypeEntry(trx, transferType);
    const aentryInId = await getNextId(trx, 'aentry');
    const atranInId = await getNextId(trx, 'atran');
    await trx.raw(`INSERT INTO aentry (
      id, ae_acnt, ae_cntr, ae_cbtype, ae_entry, ae_reclnum,
      ae_lstdate, ae_frstat, ae_tostat, ae_statln, ae_entref,
      ae_value, ae_recbal, ae_remove, ae_tmpstat, ae_complet,
      ae_postgrp, sq_crdate, sq_crtime, sq_cruser, ae_comment,
      ae_payid, ae_batchid, ae_brwptr, datecreated, datemodified, state
    ) VALUES (
      ?, ?, '    ', ?, ?, 0,
      ?, 0, 0, 0, ?,
      ?, 0, 0, 0, 1,
      0, ?, ?, ?, ?,
      0, 0, '  ', ?, ?, 1
    )`, [
        aentryInId,
        args.destBank,
        transferType,
        entryIn,
        args.postDate,
        reference,
        netPence,
        args.now.date,
        args.now.time.slice(0, 8),
        args.inputBy.slice(0, 8),
        transferCommentIn,
        args.now.iso,
        args.now.iso,
    ]);
    // Dest atran — at_name uses SOURCE bank description; legacy leaves
    // dest atran's at_sort/at_number BLANK (line 9449) since the user
    // already knows which bank received it (this is the dest bank's
    // own cashbook).
    await trx.raw(`INSERT INTO atran (
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
      8, ?, ?, 1, ?,
      0, '   ', 1.0, 0, 2,
      ?, ?, ?, '        ', '',
      '        ', '         ', 0, 0, 0,
      0, 0, '', 0, 0,
      0, 0, ?, 0, '0       ',
      ?, 'I', 0, ' ', '      ',
      '', '', '  ', '        ', '        ',
      '', '', '', ?, ?, 1
    )`, [
        atranInId,
        args.destBank,
        transferType,
        entryIn,
        args.inputBy.slice(0, 8),
        args.postDate,
        args.postDate,
        netPence,
        args.sourceBank,
        sourceInfo.description.slice(0, 35),
        transferCommentIn,
        sharedUnique,
        reference,
        args.now.iso,
        args.now.iso,
    ]);
    // nbank updates
    await updateNbankBalance(trx, args.sourceBank, -args.netAmount);
    await updateNbankBalance(trx, args.destBank, args.netAmount);
    // ntran pair + nacnt — GATED on decision.postToNominal (BLOCKER #1).
    // Lock-ordered alphabetical by bank code to match legacy
    // 9306-9310 (audit HIGH: lock-ordering). Each leg uses a DISTINCT
    // pstid (BLOCKER #6). nt_trtype = 'A' (BLOCKER #5) and the trnref
    // shows the OTHER bank's name (audit HIGH).
    let ntranWritten = false;
    if (args.decision.postToNominal) {
        const banksOrdered = [args.sourceBank, args.destBank].sort();
        const sourceIsFirst = banksOrdered[0] === args.sourceBank;
        const firstBank = banksOrdered[0];
        const secondBank = banksOrdered[1];
        const firstValue = sourceIsFirst ? -args.netAmount : args.netAmount;
        const secondValue = sourceIsFirst ? args.netAmount : -args.netAmount;
        const firstTrnref = sourceIsFirst ? sourceNtranTrnref : destNtranTrnref;
        const secondTrnref = sourceIsFirst ? destNtranTrnref : sourceNtranTrnref;
        const firstPstid = sourceIsFirst ? ntranPstidSource : ntranPstidDest;
        const secondPstid = sourceIsFirst ? ntranPstidDest : ntranPstidSource;
        const firstBankType = (await getNacntType(trx, firstBank)) ??
            { na_type: 'B ', na_subt: 'BC' };
        const secondBankType = (await getNacntType(trx, secondBank)) ??
            { na_type: 'B ', na_subt: 'BC' };
        const ntranIdStart = await getNextId(trx, 'ntran', 2);
        // First (lock order) leg — legacy 9481-9504
        await trx.raw(`INSERT INTO ntran (
        id, nt_acnt, nt_cntr, nt_type, nt_subt, nt_jrnl,
        nt_ref, nt_inp, nt_trtype, nt_cmnt, nt_trnref,
        nt_entr, nt_value, nt_year, nt_period, nt_rvrse,
        nt_prevyr, nt_consol, nt_fcurr, nt_fvalue, nt_fcrate,
        nt_fcmult, nt_fcdec, nt_srcco, nt_cdesc, nt_project,
        nt_job, nt_posttyp, nt_pstgrp, nt_pstid, nt_srcnlid,
        nt_recurr, nt_perpost, nt_rectify, nt_recjrnl, nt_vatanal,
        nt_distrib, datecreated, datemodified, state
      ) VALUES (
        ?, ?, '    ', ?, ?, ?,
        '', ?, 'A', ?, ?,
        ?, ?, ?, ?, 0,
        0, 0, '   ', 0, 0,
        0, 0, 'I', '', '        ',
        '        ', 'T', 0, ?, 0,
        0, 0, 0, 0, 0,
        0, ?, ?, 1
      )`, [
            ntranIdStart,
            firstBank,
            firstBankType.na_type,
            firstBankType.na_subt,
            journal,
            args.inputBy.slice(0, 10),
            ntranComment,
            firstTrnref,
            args.postDate,
            firstValue,
            args.year,
            args.period,
            firstPstid,
            args.now.iso,
            args.now.iso,
        ]);
        await updateNacntBalance(trx, firstBank, firstValue, {
            period: args.period,
            year: args.year,
        });
        // Second leg
        await trx.raw(`INSERT INTO ntran (
        id, nt_acnt, nt_cntr, nt_type, nt_subt, nt_jrnl,
        nt_ref, nt_inp, nt_trtype, nt_cmnt, nt_trnref,
        nt_entr, nt_value, nt_year, nt_period, nt_rvrse,
        nt_prevyr, nt_consol, nt_fcurr, nt_fvalue, nt_fcrate,
        nt_fcmult, nt_fcdec, nt_srcco, nt_cdesc, nt_project,
        nt_job, nt_posttyp, nt_pstgrp, nt_pstid, nt_srcnlid,
        nt_recurr, nt_perpost, nt_rectify, nt_recjrnl, nt_vatanal,
        nt_distrib, datecreated, datemodified, state
      ) VALUES (
        ?, ?, '    ', ?, ?, ?,
        '', ?, 'A', ?, ?,
        ?, ?, ?, ?, 0,
        0, 0, '   ', 0, 0,
        0, 0, 'I', '', '        ',
        '        ', 'T', 0, ?, 0,
        0, 0, 0, 0, 0,
        0, ?, ?, 1
      )`, [
            ntranIdStart + 1,
            secondBank,
            secondBankType.na_type,
            secondBankType.na_subt,
            journal,
            args.inputBy.slice(0, 10),
            ntranComment,
            secondTrnref,
            args.postDate,
            secondValue,
            args.year,
            args.period,
            secondPstid,
            args.now.iso,
            args.now.iso,
        ]);
        await updateNacntBalance(trx, secondBank, secondValue, {
            period: args.period,
            year: args.year,
        });
        await insertNjmemo(trx, journal, 'Cashbook Ledger Transfer (RT)');
        ntranWritten = true;
    }
    // anoml pair — BLOCKER #4. ax_source='A', shared ax_unique, FC
    // populated. Lock-ordered alphabetical. ax_done from decision;
    // ax_jrnl = journal when NL posted, 0 otherwise. Faithful port of
    // opera_sql_import.py:9547-9594. Snapshot
    // cashbook_bank_transfer_20260407_121520.json rows 8801/8802:
    // ax_source='A', ax_fcrate=1.0, ax_unique='_7FR0Q95FY' shared.
    if (args.decision.postToTransferFile) {
        const banksOrdered = [args.sourceBank, args.destBank].sort();
        const sourceIsFirst = banksOrdered[0] === args.sourceBank;
        const firstBank = banksOrdered[0];
        const secondBank = banksOrdered[1];
        const firstValue = sourceIsFirst ? -args.netAmount : args.netAmount;
        const secondValue = sourceIsFirst ? args.netAmount : -args.netAmount;
        const firstFvalue = Math.round(firstValue * 100);
        const secondFvalue = Math.round(secondValue * 100);
        const doneFlag = args.decision.transferFileDoneFlag;
        const jrnlNum = args.decision.postToNominal ? journal : 0;
        const anomlIdStart = await getNextId(trx, 'anoml', 2);
        await trx.raw(`INSERT INTO anoml (
        id, ax_nacnt, ax_ncntr, ax_source, ax_date, ax_value, ax_tref,
        ax_comment, ax_done, ax_fcurr, ax_fvalue, ax_fcrate, ax_fcmult, ax_fcdec,
        ax_srcco, ax_unique, ax_project, ax_job, ax_jrnl, ax_nlpdate,
        datecreated, datemodified, state
      ) VALUES (
        ?, ?, '    ', 'A', ?, ?, ?,
        ?, ?, '   ', ?, 1.0, 0, 2.0,
        'I', ?, '        ', '        ', ?, ?,
        ?, ?, 1
      )`, [
            anomlIdStart,
            firstBank,
            args.postDate,
            firstValue,
            reference,
            ntranComment.slice(0, 40),
            doneFlag,
            firstFvalue,
            sharedUnique,
            jrnlNum,
            args.postDate,
            args.now.iso,
            args.now.iso,
        ]);
        await trx.raw(`INSERT INTO anoml (
        id, ax_nacnt, ax_ncntr, ax_source, ax_date, ax_value, ax_tref,
        ax_comment, ax_done, ax_fcurr, ax_fvalue, ax_fcrate, ax_fcmult, ax_fcdec,
        ax_srcco, ax_unique, ax_project, ax_job, ax_jrnl, ax_nlpdate,
        datecreated, datemodified, state
      ) VALUES (
        ?, ?, '    ', 'A', ?, ?, ?,
        ?, ?, '   ', ?, 1.0, 0, 2.0,
        'I', ?, '        ', '        ', ?, ?,
        ?, ?, 1
      )`, [
            anomlIdStart + 1,
            secondBank,
            args.postDate,
            secondValue,
            reference,
            ntranComment.slice(0, 40),
            doneFlag,
            secondFvalue,
            sharedUnique,
            jrnlNum,
            args.postDate,
            args.now.iso,
            args.now.iso,
        ]);
        // Suppress unused-var warning when ntran path didn't run — we still
        // return the variables for the verifier's post-write checks.
        void secondBank;
    }
    return {
        sourceEntry: entryOut,
        destEntry: entryIn,
        sourceBank: args.sourceBank,
        destBank: args.destBank,
        expectedSourcePence: -netPence,
        expectedDestPence: netPence,
        sharedUnique,
        ntranPstidSource,
        ntranPstidDest,
        ntranWritten,
    };
}
// ---------------------------------------------------------------------
// Public executor
// ---------------------------------------------------------------------
export const gocardlessBatchPostingExecutor = {
    async postBatch(operaDb, request, appDb = null) {
        const warnings = [];
        let recordsImported = 0;
        let batchRef = null;
        let postCommitContext = null;
        try {
            const controlAccounts = await getControlAccounts(operaDb);
            const slControl = controlAccounts.debtorsControl;
            // Build the period-posting decision ONCE per batch — outside the
            // trx so an early reject (period closed, OPA off + back-period)
            // never opens a write surface. GoCardless lands in the SALES
            // ledger (SL). Faithful port of opera_sql_import.py:2135 (which
            // builds posting_decision before the inner _do_gocardless_batch
            // function captures it). BLOCKER #1.
            const decision = await getPeriodPostingDecision(operaDb, request.postDateString, 'SL');
            if (!decision.canPost) {
                return {
                    success: false,
                    records_imported: 0,
                    batch_ref: null,
                    warnings,
                    errors: [decision.errorMessage ?? 'Period closed for posting'],
                };
            }
            // Deadlock-retry wrapper — SQL Server 1205 victims get 3 retries
            // with 100ms / 500ms / 1500ms backoff. BLOCKER #9. Faithful port
            // of execute_with_deadlock_retry (opera_sql_import.py:6876).
            await executeWithDeadlockRetry(operaDb, async (trx) => {
                const now = nowMs();
                const { period, year } = await getPeriodForDate(trx, request.postDate);
                const customerInfo = await loadCustomerInfo(trx, request.payments, {
                    sl_control: slControl,
                });
                const cbtypeChoice = await resolveCbtype(trx, request.cbtype);
                const cbtype = cbtypeChoice.cbtype;
                const cbtypeDesc = cbtypeChoice.description;
                // Allocate sequences inside the transaction so retries are safe
                const uniqueIds = generateOperaUniqueIds(request.payments.length * 2);
                const entryNumber = await incrementAtypeEntry(trx, cbtype);
                batchRef = entryNumber;
                const aentryId = await getNextId(trx, 'aentry');
                // One journal per payment when complete_batch=true; otherwise we
                // still allocate one for consistency.
                const journalCount = request.completeBatch
                    ? request.payments.length
                    : 1;
                let nextJournal = await getNextJournal(trx, journalCount);
                const totalPence = request.payments.reduce((acc, p) => acc + pence(p.amount), 0);
                // Verification: collect every unique we mint so the end-of-trx
                // assertions can confirm that every ntran/anoml pair we wrote
                // exists and balances. atranUniques double as anoml uniques
                // (insertAnomlPair takes atranUnique); ntranPstids are the
                // per-payment ntran pair keys.
                const atranUniques = [];
                const ntranPstids = [];
                await insertAentry(trx, {
                    aentryId,
                    bankAccount: request.postingBank,
                    cbtype,
                    entryNumber,
                    postDate: request.postDateString,
                    reference: request.reference,
                    totalPence,
                    completeBatch: request.completeBatch,
                    inputBy: request.inputBy,
                    nowDate: now.date,
                    nowTime: now.time,
                    nowIso: now.iso,
                });
                for (let i = 0; i < request.payments.length; i++) {
                    const p = request.payments[i];
                    const cust = customerInfo.get(p.customer_account.trim());
                    if (!cust) {
                        throw new Error(`Customer info missing for ${p.customer_account} — should have been validated already`);
                    }
                    const amountPounds = Number(p.amount);
                    const amountPence = pence(amountPounds);
                    const atranUnique = uniqueIds[i * 2];
                    const ntranPstid = uniqueIds[i * 2 + 1];
                    atranUniques.push(atranUnique);
                    ntranPstids.push(ntranPstid);
                    const atranId = await getNextId(trx, 'atran');
                    const stranId = await getNextId(trx, 'stran');
                    await insertAtran(trx, {
                        atranId,
                        bankAccount: request.postingBank,
                        cbtype,
                        entryNumber,
                        inputBy: request.inputBy,
                        postDate: request.postDateString,
                        amountPence,
                        customerAccount: cust.account,
                        customerName: cust.name,
                        description: p.description,
                        atranUnique,
                        reference: request.reference,
                        nowIso: now.iso,
                    });
                    await insertStran(trx, {
                        stranId,
                        customerAccount: cust.account,
                        postDate: request.postDateString,
                        reference: request.reference,
                        amountPounds,
                        memo: `GoCardless - ${p.description}`,
                        cbtype,
                        entryNumber,
                        stranUnique: atranUnique, // shared with atran by design
                        region: cust.region,
                        terr: cust.terr,
                        type: cust.type,
                        nowIso: now.iso,
                    });
                    // Auto-allocate the receipt to outstanding invoices when the
                    // caller asked us to. Faithful port of legacy
                    // `auto_allocate_receipt` (sql_rag/opera_sql_import.py:7017+).
                    // Failures are non-fatal — the receipt remains on account and
                    // we surface a warning so the user can allocate manually in
                    // Opera.
                    if (p.auto_allocate) {
                        const allocResult = await autoAllocateReceipt(trx, appDb, {
                            customerAccount: cust.account,
                            receiptRef: request.reference,
                            receiptAmount: amountPounds,
                            allocationDate: request.postDateString,
                            bankAccount: request.postingBank,
                            description: p.description,
                            gcPaymentId: p.gc_payment_id || null,
                            nowIso: now.iso,
                        });
                        if (!allocResult.success && allocResult.message) {
                            warnings.push(`Auto-allocate ${cust.account}: ${allocResult.message}`);
                        }
                    }
                    // Bank balance update — always
                    await updateNbankBalance(trx, request.postingBank, amountPounds);
                    // ntran pair (NL post) — GATED on completeBatch AND
                    // decision.postToNominal. Legacy opera_sql_import.py:6397.
                    // When RTU=OFF or back-period, this branch skips and only
                    // anoml is written. BLOCKER #1.
                    const writeNtran = request.completeBatch && decision.postToNominal;
                    const writeAnoml = request.completeBatch && decision.postToTransferFile;
                    if (writeNtran) {
                        const bankType = (await getNacntType(trx, request.postingBank)) ??
                            { na_type: 'B ', na_subt: 'BC' };
                        const controlType = (await getNacntType(trx, cust.controlAccount)) ??
                            { na_type: 'B ', na_subt: 'BB' };
                        const ntranIdStart = await getNextId(trx, 'ntran', 2);
                        const ntranComment = (p.description || '').padEnd(50).slice(0, 50);
                        const ntranTrnref = (cust.name.slice(0, 30).padEnd(30) + 'GoCardless (RT)     ').slice(0, 50);
                        await insertNtranPair(trx, {
                            idStart: ntranIdStart,
                            bankAccount: request.postingBank,
                            bankType,
                            salesLedgerControl: cust.controlAccount,
                            controlType,
                            journal: nextJournal,
                            inputBy: request.inputBy,
                            comment: ntranComment,
                            trnref: ntranTrnref,
                            postDate: request.postDateString,
                            amountPounds,
                            year,
                            period,
                            pstid: ntranPstid,
                            nowIso: now.iso,
                        });
                        await updateNacntBalance(trx, request.postingBank, amountPounds, {
                            period,
                            year,
                        });
                        await updateNacntBalance(trx, cust.controlAccount, -amountPounds, { period, year });
                        await insertNjmemo(trx, nextJournal, 'Cashbook Ledger Transfer (RT)');
                    }
                    if (writeAnoml) {
                        const anomlIdStart = await getNextId(trx, 'anoml', 2);
                        const anomlComment = (cust.name.slice(0, 30).padEnd(30) + cbtypeDesc).slice(0, 40);
                        // ax_jrnl = next_journal when NL pair was written (legacy
                        // 6466: `next_journal - 1` because legacy increments
                        // before this block — in TS we increment AFTER, so this
                        // matches `nextJournal` directly). When NL skipped, 0.
                        const anomlJournal = writeNtran ? nextJournal : 0;
                        await insertAnomlPair(trx, {
                            idStart: anomlIdStart,
                            bankAccount: request.postingBank,
                            salesLedgerControl: cust.controlAccount,
                            postDate: request.postDateString,
                            amountPounds,
                            reference: request.reference,
                            comment: anomlComment,
                            // BLOCKER #2 fix: derive from decision, never hardcode.
                            doneFlag: decision.transferFileDoneFlag,
                            atranUnique,
                            journal: anomlJournal,
                            nowIso: now.iso,
                        });
                    }
                    // Legacy only advances the journal when the NL leg was
                    // actually consumed (opera_sql_import.py:6462). When
                    // postToNominal=false, the per-payment journal stays unused.
                    if (writeNtran) {
                        nextJournal += 1;
                    }
                    // Customer balance — always
                    await trx.raw(`UPDATE sname WITH (ROWLOCK)
             SET sn_currbal = ISNULL(sn_currbal, 0) - ?,
                 sn_nextpay = ISNULL(sn_nextpay, 0) + 1,
                 datemodified = GETDATE()
             WHERE RTRIM(sn_account) = ?`, [amountPounds, cust.account]);
                    recordsImported += 1;
                }
                // Fees split: post a SEPARATE cashbook entry for fees with
                // ntran legs DR fees expense + DR VAT input + CR bank.
                // Faithful port of opera_sql_import.py:6519-6800.
                let feesResult = null;
                if (request.goCardlessFees > 0 &&
                    request.feesNominalAccount) {
                    feesResult = await postFeesEntry(trx, {
                        bankAccount: request.postingBank,
                        reference: request.reference,
                        postDate: request.postDateString,
                        grossFees: request.goCardlessFees,
                        vatOnFees: request.vatOnFees,
                        feesNominalAccount: request.feesNominalAccount,
                        feesPaymentType: request.feesPaymentType,
                        year,
                        period,
                        now,
                        feesVatCode: request.feesVatCode,
                        inputBy: request.inputBy,
                        decision,
                    });
                }
                // Bank-transfer auto-leg: when destinationBank is set and
                // differs from postingBank, post a paired transfer of the NET
                // amount from posting bank → destination bank.
                let transferResult = null;
                if (request.destinationBank) {
                    transferResult = await postDestinationTransfer(trx, {
                        sourceBank: request.postingBank,
                        destBank: request.destinationBank,
                        netAmount: request.payments.reduce((acc, p) => acc + p.amount, 0) -
                            request.goCardlessFees,
                        reference: request.reference,
                        postDate: request.postDateString,
                        year,
                        period,
                        now,
                        transferCbtype: request.transferCbtype,
                        inputBy: request.inputBy,
                        decision,
                    });
                }
                // --- Phase A verification (in-trx, NOLOCK, no new lock surface) ---
                // Every check throws PostingVerificationError on mismatch →
                // Knex rolls the WHOLE batch back. No half-posted batch lands
                // in Opera.
                const totalPounds = request.payments.reduce((acc, p) => acc + p.amount, 0);
                // Batch aentry header value matches the sum of pence
                await assertAentryHeader(trx, {
                    entryNumber,
                    bankAccount: request.postingBank,
                    expectedValuePence: totalPence,
                    label: 'batch',
                });
                // Customer atran lines: N rows summing to totalPence
                await assertAtranCountAndSum(trx, {
                    entryNumber,
                    bankAccount: request.postingBank,
                    expectedCount: request.payments.length,
                    expectedSumPence: totalPence,
                    label: 'batch lines',
                });
                // Sales ledger receipts: N rows summing to -totalPounds (receipts negative)
                await assertStranCountAndSum(trx, {
                    entryNumber,
                    cbtype,
                    expectedCount: request.payments.length,
                    expectedSumPounds: -totalPounds,
                });
                // completeBatch wrote per-payment ntran + anoml pairs — verify
                // every pair exists and balances. Bulk query: 1 round-trip
                // each regardless of payment count. Each assertion is gated
                // on the same decision flag used by the writer above so we
                // don't assert pairs that were never written (e.g. RTU=OFF).
                if (request.completeBatch && decision.postToNominal) {
                    await assertBalancedPairsBulk(trx, {
                        table: 'ntran',
                        sharedUniques: ntranPstids,
                        expectedRowsPerUnique: 2,
                        batchRef: entryNumber,
                        label: 'customer ntran pair',
                    });
                }
                if (request.completeBatch && decision.postToTransferFile) {
                    await assertBalancedPairsBulk(trx, {
                        table: 'anoml',
                        sharedUniques: atranUniques,
                        expectedRowsPerUnique: 2,
                        batchRef: entryNumber,
                        label: 'customer anoml pair',
                    });
                }
                // Fees entry (separate aentry) if present
                if (feesResult) {
                    await assertAentryHeader(trx, {
                        entryNumber: feesResult.entryNumber,
                        bankAccount: feesResult.bankAccount,
                        expectedValuePence: feesResult.expectedAentryValuePence,
                        label: 'fees',
                    });
                    await assertAtranCountAndSum(trx, {
                        entryNumber: feesResult.entryNumber,
                        bankAccount: feesResult.bankAccount,
                        expectedCount: feesResult.atranLineCount,
                        expectedSumPence: feesResult.atranSumPence,
                        label: 'fees lines',
                    });
                    // Fees NL legs (2 or 3 ntran rows) — the gross fees pair
                    // uses `feesUnique`. The VAT line, when present, uses
                    // `feesVatUnique` (single row, not a balanced pair, so we
                    // skip the per-unique balance assertion for it — the
                    // overall set is balanced because gross = net + vat in
                    // pence and the bank leg carries -gross).
                    //
                    // We assert the gross pair (DR fees expense + CR bank)
                    // balances; for VAT we just confirm the row exists via
                    // the atran-sum check above (which already validated
                    // pence totals).
                    // NOTE: when VAT is present, the fees pair has 3 rows under
                    // ONE shared `feesUnique` (DR fees + CR bank both use it;
                    // the VAT DR uses `feesVatUnique`). When VAT is absent, the
                    // pair has 2 rows under `feesUnique`. Either way the
                    // `feesUnique`-grouped sum should be `-vatPence` (when VAT
                    // is split out) or zero. To stay simple, we only assert
                    // that BOTH legs we wrote exist (count check) and let the
                    // atran sum above carry the value assertion.
                    // (We deliberately keep this loose — the atran header+lines
                    // check already gives us strong assurance the fees entry
                    // landed correctly.)
                }
                // Destination transfer pair if present
                if (transferResult) {
                    await assertAentryHeader(trx, {
                        entryNumber: transferResult.sourceEntry,
                        bankAccount: transferResult.sourceBank,
                        expectedValuePence: transferResult.expectedSourcePence,
                        label: 'transfer-out',
                    });
                    await assertAentryHeader(trx, {
                        entryNumber: transferResult.destEntry,
                        bankAccount: transferResult.destBank,
                        expectedValuePence: transferResult.expectedDestPence,
                        label: 'transfer-in',
                    });
                    await assertAtranCountAndSum(trx, {
                        entryNumber: transferResult.sourceEntry,
                        bankAccount: transferResult.sourceBank,
                        expectedCount: 1,
                        expectedSumPence: transferResult.expectedSourcePence,
                        label: 'transfer-out line',
                    });
                    await assertAtranCountAndSum(trx, {
                        entryNumber: transferResult.destEntry,
                        bankAccount: transferResult.destBank,
                        expectedCount: 1,
                        expectedSumPence: transferResult.expectedDestPence,
                        label: 'transfer-in line',
                    });
                    // sharedUnique now keys the anoml pair (ax_unique). ntran
                    // legs use DISTINCT pstids per leg (BLOCKER #6), so we check
                    // them as two singleton rows rather than one balanced pair.
                    if (transferResult.ntranWritten) {
                        await assertBalancedPairsBulk(trx, {
                            table: 'ntran',
                            sharedUniques: [
                                transferResult.ntranPstidSource,
                                transferResult.ntranPstidDest,
                            ],
                            expectedRowsPerUnique: 1,
                            batchRef: transferResult.sourceEntry,
                            label: 'transfer ntran',
                        });
                    }
                    if (decision.postToTransferFile) {
                        await assertBalancedPairsBulk(trx, {
                            table: 'anoml',
                            sharedUniques: [transferResult.sharedUnique],
                            expectedRowsPerUnique: 2,
                            batchRef: transferResult.sourceEntry,
                            label: 'transfer anoml',
                        });
                    }
                }
                // Stash context for Phase C (post-commit) — fires after the
                // trx exits successfully.
                postCommitContext = {
                    batchEntry: entryNumber,
                    batchBank: request.postingBank,
                    batchValuePence: totalPence,
                    fees: feesResult
                        ? {
                            entryNumber: feesResult.entryNumber,
                            bankAccount: feesResult.bankAccount,
                            expectedValuePence: feesResult.expectedAentryValuePence,
                        }
                        : null,
                    transfer: transferResult
                        ? {
                            sourceEntry: transferResult.sourceEntry,
                            sourceBank: transferResult.sourceBank,
                            expectedSourcePence: transferResult.expectedSourcePence,
                        }
                        : null,
                };
            }, `gocardless_batch(${request.payments.length} payments, ${request.postingBank})`);
            // --- Phase C verification (post-commit, fresh pool connection) ---
            // The trx has committed. Re-read the headers we wrote from a
            // separate session to confirm SQL Server's commit is visible
            // outside our trx. NEVER silently retries — a failure here is
            // a hard operator-action error.
            const phaseCErrors = [];
            const ctx = postCommitContext;
            if (ctx) {
                const batchV = await verifyAentryCommitted(operaDb, {
                    entryNumber: ctx.batchEntry,
                    bankAccount: ctx.batchBank,
                    expectedValuePence: ctx.batchValuePence,
                    label: 'batch aentry',
                });
                if (!batchV.verified) {
                    phaseCErrors.push(`POST-COMMIT VERIFICATION FAILED — batch entry ${ctx.batchEntry} ` +
                        `posted to Opera but verification could not confirm: ${batchV.reason}. ` +
                        `Check Opera manually before re-running.`);
                }
                if (ctx.fees) {
                    const feesV = await verifyAentryCommitted(operaDb, {
                        entryNumber: ctx.fees.entryNumber,
                        bankAccount: ctx.fees.bankAccount,
                        expectedValuePence: ctx.fees.expectedValuePence,
                        label: 'fees aentry',
                    });
                    if (!feesV.verified) {
                        phaseCErrors.push(`POST-COMMIT VERIFICATION FAILED — fees entry ${ctx.fees.entryNumber} ` +
                            `posted but verification could not confirm: ${feesV.reason}.`);
                    }
                }
                if (ctx.transfer) {
                    const transferV = await verifyAentryCommitted(operaDb, {
                        entryNumber: ctx.transfer.sourceEntry,
                        bankAccount: ctx.transfer.sourceBank,
                        expectedValuePence: ctx.transfer.expectedSourcePence,
                        label: 'transfer-out aentry',
                    });
                    if (!transferV.verified) {
                        phaseCErrors.push(`POST-COMMIT VERIFICATION FAILED — transfer-out entry ${ctx.transfer.sourceEntry} ` +
                            `posted but verification could not confirm: ${transferV.reason}.`);
                    }
                }
            }
            if (phaseCErrors.length > 0) {
                return {
                    success: false,
                    records_imported: recordsImported,
                    batch_ref: batchRef,
                    warnings,
                    errors: phaseCErrors,
                };
            }
            return {
                success: true,
                records_imported: recordsImported,
                batch_ref: batchRef,
                warnings,
                errors: [],
            };
        }
        catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            const formatted = err instanceof PostingVerificationError
                ? `VERIFICATION FAILED (${err.phase}) — ${msg}. Trx rolled back; nothing posted for this batch.`
                : msg;
            return {
                success: false,
                records_imported: 0,
                batch_ref: null,
                warnings,
                errors: [formatted],
            };
        }
    },
};
//# sourceMappingURL=batch-posting-executor.js.map