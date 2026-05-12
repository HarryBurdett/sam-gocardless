export async function getCustomerEmail(operaDb, account) {
    const acct = (account ?? '').trim();
    if (!acct) {
        return { success: true, email: '', name: '' };
    }
    try {
        const row = (await operaDb('sname')
            .whereRaw('LTRIM(RTRIM(sn_account)) = ?', [acct])
            .select(operaDb.raw('RTRIM(sn_name) AS name'), operaDb.raw('RTRIM(sn_email) AS email'), operaDb.raw('RTRIM(sn_contact) AS contact'))
            .first());
        if (!row) {
            return { success: true, email: '', name: '' };
        }
        return {
            success: true,
            email: (row.email ?? '').trim(),
            name: (row.name ?? '').trim(),
            contact: (row.contact ?? '').trim(),
        };
    }
    catch (err) {
        return {
            success: false,
            email: '',
            name: '',
            error: err?.message ?? String(err),
        };
    }
}
//# sourceMappingURL=customer-email.js.map