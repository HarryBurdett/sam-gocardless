export async function isPayoutImported(appDb, payoutId, opts = {}) {
    const id = (payoutId ?? '').trim();
    if (!id)
        return false;
    try {
        let q = appDb('gocardless_imports').where({ payout_id: id });
        if (opts.targetSystem) {
            q = q.andWhere({ target_system: opts.targetSystem });
        }
        const row = (await q.first());
        return !!row;
    }
    catch {
        return false;
    }
}
export async function isReferenceImported(appDb, bankReference, opts = {}) {
    const ref = (bankReference ?? '').trim();
    if (!ref)
        return false;
    try {
        // Match exact OR with currency suffix like "REF (EUR)" — same
        // behaviour as the Python implementation.
        let q = appDb('gocardless_imports').where((qb) => {
            qb.where({ bank_reference: ref }).orWhere('bank_reference', 'like', `${ref} (%`);
        });
        if (opts.targetSystem) {
            q = q.andWhere({ target_system: opts.targetSystem });
        }
        const row = (await q.first());
        return !!row;
    }
    catch {
        return false;
    }
}
export async function isEmailImported(appDb, emailId, opts = {}) {
    if (!Number.isFinite(emailId) || emailId <= 0)
        return false;
    try {
        let q = appDb('gocardless_imports').where({ email_id: emailId });
        if (opts.targetSystem) {
            q = q.andWhere({ target_system: opts.targetSystem });
        }
        const row = (await q.first());
        return !!row;
    }
    catch {
        return false;
    }
}
/**
 * List the email_ids that have been imported. Used by scan-emails to
 * filter out emails already in the import history.
 */
export async function getImportedEmailIds(appDb, opts = {}) {
    try {
        let q = appDb('gocardless_imports').whereNotNull('email_id');
        if (opts.targetSystem) {
            q = q.andWhere({ target_system: opts.targetSystem });
        }
        const rows = (await q.distinct('email_id').select('email_id'));
        return rows
            .map((r) => Number(r.email_id))
            .filter((n) => Number.isFinite(n) && n > 0);
    }
    catch {
        return [];
    }
}
/**
 * Set of bank references that have been imported, from any source
 * (email or API). Faithful port of
 * `email_storage.get_imported_gocardless_references`.
 */
export async function getImportedReferences(appDb, opts = {}) {
    try {
        let q = appDb('gocardless_imports').whereNotNull('bank_reference');
        if (opts.targetSystem) {
            q = q.andWhere({ target_system: opts.targetSystem });
        }
        const rows = (await q
            .distinct('bank_reference')
            .select('bank_reference'));
        const out = new Set();
        for (const row of rows) {
            const ref = (row.bank_reference ?? '').toString().trim();
            if (ref)
                out.add(ref);
        }
        return out;
    }
    catch {
        return new Set();
    }
}
//# sourceMappingURL=import-idempotency.js.map