const FREQ_LABELS = {
    W: 'Weekly',
    F: 'Fortnightly',
    M: 'Monthly',
    B: 'Bi-monthly',
    Q: 'Quarterly',
    H: 'Half-yearly',
    A: 'Annual',
};
/**
 * Run the preview / apply flow.
 */
export async function updateSubscriptionTags(operaDb, config, req = {}) {
    const mode = req.mode === 'apply' ? 'apply' : 'preview';
    const overwrite = !!req.overwrite;
    const tag = (config.subscription_tag ?? '').trim();
    const frequencies = (config.subscription_frequencies ?? []).filter((f) => typeof f === 'string' && f.length > 0);
    if (!tag) {
        return { success: false, error: 'Subscription tag is not configured' };
    }
    if (frequencies.length === 0) {
        return { success: false, error: 'No frequency filters selected' };
    }
    try {
        const freqPlaceholders = frequencies.map(() => '?').join(',');
        const rows = (await operaDb('ihead')
            .select('ih_doc', 'ih_account', 'ih_name', 'ih_ignore', 'ih_analsys')
            .where('ih_docstat', 'U')
            .andWhere((qb) => {
            qb.whereNull('ih_econtr').orWhereRaw('ih_econtr >= GETDATE()');
        })
            .whereRaw(`RTRIM(ih_ignore) IN (${freqPlaceholders})`, frequencies)
            .orderBy('ih_account', 'asc')
            .orderBy('ih_doc', 'asc'));
        const documents = [];
        let alreadyTagged = 0;
        let willTag = 0;
        let hasDifferent = 0;
        for (const row of rows) {
            const docRef = (row.ih_doc ?? '').trim();
            const account = (row.ih_account ?? '').trim();
            const name = (row.ih_name ?? '').trim();
            const freqCode = (row.ih_ignore ?? '').trim();
            const currentAnalsys = (row.ih_analsys ?? '').trim();
            let status;
            if (currentAnalsys === tag) {
                alreadyTagged++;
                status = 'already_tagged';
            }
            else if (!currentAnalsys) {
                willTag++;
                status = 'will_tag';
            }
            else {
                hasDifferent++;
                status = 'has_different';
            }
            documents.push({
                doc_ref: docRef,
                account,
                name,
                frequency: FREQ_LABELS[freqCode] ?? freqCode,
                frequency_code: freqCode,
                current_analsys: currentAnalsys,
                status,
            });
        }
        if (mode === 'preview') {
            return {
                success: true,
                tag,
                total_matching: documents.length,
                already_tagged: alreadyTagged,
                will_tag: willTag,
                has_different: hasDifferent,
                documents,
            };
        }
        // Apply mode — query-builder form so rowsAffected is real on
        // every driver (mssql/foxpro/sqlite). Faithful to legacy filter
        // semantics in apps/gocardless/api/routes.py.
        const placeholders = frequencies.map(() => '?').join(',');
        let baseQuery = operaDb('ihead')
            .where('ih_docstat', 'U')
            .andWhere(function notExpired() {
            this.whereNull('ih_econtr').orWhereRaw('ih_econtr >= GETDATE()');
        })
            .whereRaw(`RTRIM(ih_ignore) IN (${placeholders})`, frequencies);
        if (overwrite) {
            baseQuery = baseQuery.andWhere(function differentTag() {
                this.whereRaw('RTRIM(ih_analsys) != ?', [tag])
                    .orWhereNull('ih_analsys')
                    .orWhereRaw("RTRIM(ih_analsys) = ''");
            });
        }
        else {
            baseQuery = baseQuery.andWhere(function unset() {
                this.whereNull('ih_analsys').orWhereRaw("RTRIM(ih_analsys) = ''");
            });
        }
        const updated = Number(await baseQuery.update({
            ih_analsys: tag,
            datemodified: operaDb.raw('GETDATE()'),
        }));
        return {
            success: true,
            updated,
            tag,
            overwrite,
        };
    }
    catch (err) {
        return { success: false, error: err?.message ?? String(err) };
    }
}
//# sourceMappingURL=subscription-tags.js.map