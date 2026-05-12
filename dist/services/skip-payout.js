const REASON_TO_IMPORTED_BY = {
    foreign_currency: 'MANUAL', // suffix added with currency below
    manual: 'MANUAL-SKIP',
    duplicate: 'MANUAL-DUP',
};
export async function skipPayout(appDb, input) {
    try {
        const reason = input.reason ?? 'manual';
        const currency = (input.currency ?? 'GBP').toUpperCase();
        const targetSystem = input.targetSystem ?? 'opera_se';
        // Compose imported_by tag
        let importedBy;
        if (reason === 'foreign_currency') {
            importedBy = `MANUAL-${currency}`;
        }
        else {
            importedBy = REASON_TO_IMPORTED_BY[reason] ?? 'MANUAL-SKIP';
        }
        // Include currency in display reference for non-GBP
        const displayReference = currency && currency !== 'GBP'
            ? `${input.bankReference} (${currency})`
            : input.bankReference;
        // Serialise payment details if provided
        let paymentsJson = null;
        if (Array.isArray(input.payments) && input.payments.length > 0) {
            paymentsJson = JSON.stringify(input.payments.map((p) => ({
                customer_account: p.matched_account ?? p.customer_account ?? '',
                gc_customer_name: p.customer_name ?? '',
                amount: p.amount ?? 0,
                description: p.description ?? '',
            })));
        }
        const inserted = await appDb('gocardless_imports')
            .insert({
            bank_reference: displayReference,
            payment_date: null, // skipped — no payout_date stored
            gross_amount: input.grossAmount,
            fees_amount: 0,
            vat_on_fees: 0,
            net_amount: input.grossAmount, // unknown for skipped — use gross
            currency: currency,
            bank_code: null,
            cbtype: null,
            payments_json: paymentsJson,
            opera_entry_refs: null,
            target_system: targetSystem,
            imported_by: importedBy,
        })
            .returning('id');
        const recordId = Array.isArray(inserted) && inserted.length > 0
            ? typeof inserted[0] === 'object'
                ? inserted[0].id
                : Number(inserted[0])
            : 0;
        return {
            success: true,
            message: `Payout ${input.bankReference} sent to history (needs manual posting)`,
            record_id: recordId,
            reason,
        };
    }
    catch (err) {
        return { success: false, error: err?.message ?? String(err) };
    }
}
//# sourceMappingURL=skip-payout.js.map