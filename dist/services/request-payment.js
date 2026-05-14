/**
 * Resolve a BACS reference template against per-payment values. Max
 * 10 chars (BACS limit on what appears on the customer's bank
 * statement). Unknown merge fields render empty. Length suffix
 * `{field4}` takes the first 4 chars of `field`. Faithful port of
 * the Python regex `\{(\w+?)(\d+)?\}` substitution in routes.py:5148.
 */
export function buildBacsReference(template, values) {
    const t = (template ?? '').trim();
    if (!t)
        return values.company.slice(0, 10);
    const rendered = t.replace(/\{(\w+?)(\d+)?\}/g, (_match, name, len) => {
        const raw = values[name] ?? '';
        return len ? raw.slice(0, Number(len)) : raw;
    });
    return rendered.trim().slice(0, 10);
}
function trim(s) {
    return (s ?? '').trim();
}
function normaliseChargeDate(raw, today = new Date()) {
    if (!raw)
        return null;
    const m = /^\d{4}-\d{2}-\d{2}$/.exec(raw);
    if (!m)
        return raw; // malformed input — pass through unchanged
    const d = new Date(`${raw}T00:00:00Z`);
    if (Number.isNaN(d.getTime()))
        return raw;
    const todayUtc = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()));
    return d < todayUtc ? null : raw;
}
function buildDescription(description, invoices, stmtRefRaw) {
    const stmtRef = trim(stmtRefRaw).slice(0, 10);
    const desc = trim(description);
    if (!desc) {
        const invPart = invoices.length === 1
            ? invoices[0]
            : `${invoices[0] ?? ''} +${invoices.length - 1}`;
        return stmtRef ? `${stmtRef} ${invPart}` : invPart;
    }
    if (stmtRef && !desc.startsWith(stmtRef)) {
        return `${stmtRef} ${desc}`;
    }
    return desc;
}
function parseInvoiceRefs(value) {
    if (Array.isArray(value))
        return value.map(String);
    if (typeof value === 'string' && value) {
        try {
            const parsed = JSON.parse(value);
            return Array.isArray(parsed) ? parsed.map(String) : [];
        }
        catch {
            return [];
        }
    }
    return [];
}
function formatPounds(pounds) {
    return pounds.toLocaleString('en-GB', {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
    });
}
async function findActiveMandate(appDb, operaAccount) {
    const row = (await appDb('gocardless_mandates')
        .where({ opera_account: operaAccount, mandate_status: 'active' })
        .orderBy('created_at', 'desc')
        .first());
    if (!row || !row.mandate_id)
        return null;
    return {
        mandate_id: row.mandate_id,
        opera_account: row.opera_account ?? operaAccount,
        opera_name: row.opera_name ?? null,
    };
}
async function findDuplicateInvoiceClash(appDb, operaAccount, invoices) {
    if (invoices.length === 0)
        return null;
    const rows = (await appDb('gocardless_payment_requests')
        .where({ opera_account: operaAccount })
        .select('status', 'invoice_refs'));
    const requested = new Set(invoices);
    for (const r of rows ?? []) {
        const status = trim(r.status);
        if (status === 'cancelled' || status === 'failed' || status === 'charged_back')
            continue;
        const refs = parseInvoiceRefs(r.invoice_refs);
        const overlap = refs.filter((ref) => requested.has(ref));
        if (overlap.length > 0) {
            return { status, refs: overlap };
        }
    }
    return null;
}
async function persistPaymentRequest(appDb, row) {
    const ids = (await appDb('gocardless_payment_requests')
        .insert({
        mandate_id: row.mandate_id,
        opera_account: row.opera_account,
        amount_pence: row.amount_pence,
        invoice_refs: JSON.stringify(row.invoice_refs),
        payment_id: row.payment_id,
        charge_date: row.charge_date,
        description: row.description,
        status: row.status,
        currency: row.currency,
    })
        .returning('id'));
    // Knex returning shape varies by driver
    const inserted = Array.isArray(ids) && ids.length > 0 ? ids[0] : null;
    const newId = typeof inserted === 'number'
        ? inserted
        : typeof inserted?.id === 'number'
            ? inserted.id
            : null;
    const persisted = (await appDb('gocardless_payment_requests')
        .where(newId ? { id: newId } : { payment_id: row.payment_id ?? '' })
        .first());
    return persisted ?? {};
}
export async function requestPayment(appDb, input, settings, readOpera, createRemote, today = new Date()) {
    const operaAccount = trim(input.operaAccount);
    const invoices = (input.invoices ?? [])
        .map((s) => trim(String(s)))
        .filter(Boolean);
    if (!operaAccount) {
        return { success: false, error: 'opera_account is required' };
    }
    // 1. Duplicate-invoice guard
    if (invoices.length > 0) {
        try {
            const clash = await findDuplicateInvoiceClash(appDb, operaAccount, invoices);
            if (clash) {
                return {
                    success: false,
                    error: `Payment already requested for invoice(s): ${clash.refs.join(', ')}. ` +
                        `Existing request status: ${clash.status}. ` +
                        `Cancel the existing request first to avoid duplicate collection.`,
                };
            }
        }
        catch {
            // Mirrors Python's "log + continue" — duplicate check failures
            // shouldn't block the operator. The remote API will still
            // surface conflicts via its own response.
        }
    }
    // 2. Mandate lookup
    const mandate = await findActiveMandate(appDb, operaAccount);
    if (!mandate) {
        return {
            success: false,
            error: `No active mandate found for customer ${operaAccount}. Please set up a mandate first.`,
        };
    }
    // 3. Opera read — invoice total + unallocated-credit safety check
    let opera;
    try {
        opera = await readOpera(operaAccount, invoices);
    }
    catch (err) {
        return { success: false, error: err?.message ?? String(err) };
    }
    // 4. Resolve amount
    let amountPence = input.amountPence ?? null;
    if (amountPence === null || amountPence === undefined) {
        if (opera.invoiceTotalPounds === null) {
            return { success: false, error: 'Could not find specified invoices' };
        }
        amountPence = Math.round(opera.invoiceTotalPounds * 100);
    }
    amountPence = Math.round(Number(amountPence));
    if (!Number.isFinite(amountPence) || amountPence <= 0) {
        return { success: false, error: 'Amount must be greater than zero' };
    }
    // 5. Unallocated-credit safety check (only when mandate found)
    if (opera.unallocatedCreditPounds >= 0.01) {
        return {
            success: false,
            error: `Customer ${operaAccount} has £${formatPounds(opera.unallocatedCreditPounds)} ` +
                `unallocated credit on their account. This may be a previous GoCardless payment ` +
                `not yet allocated to invoices. Please allocate existing receipts before ` +
                `requesting a new payment to avoid duplicate collection.`,
        };
    }
    // 6. Build description + sanitised charge_date
    const description = buildDescription(input.description, invoices, settings.request_statement_reference);
    const chargeDate = normaliseChargeDate(input.chargeDate ?? null, today);
    // 6a. Build BACS reference from template — what appears on the
    // customer's bank statement. Max 10 chars. Defaults to
    // {company} so the request_statement_reference is used when no
    // template is set. Faithful port of routes.py:5148 (23b9542 +
    // 4bd437a).
    const firstInvoice = invoices.length > 0 ? invoices[0] : '';
    const invNumDigits = firstInvoice.replace(/\D/g, '');
    const bacsReference = buildBacsReference(settings.bacs_reference_template ?? '{company}', {
        company: trim(settings.request_statement_reference),
        inv: firstInvoice,
        inv_num: invNumDigits,
        customer: operaAccount,
    });
    // 7. Remote create
    const remote = await createRemote({
        amountPence,
        mandateId: mandate.mandate_id,
        description,
        reference: bacsReference || null,
        chargeDate,
        metadata: {
            opera_account: operaAccount,
            invoices: invoices.join(','),
        },
    });
    if (!remote.success) {
        return {
            success: false,
            error: `GoCardless API error: ${remote.error ?? 'unknown'}`,
        };
    }
    const gcStatus = remote.payment?.status ?? 'pending';
    const gcChargeDate = remote.payment?.charge_date ?? null;
    const gcPaymentId = remote.payment?.id ?? null;
    // 8. Persist locally
    const persisted = await persistPaymentRequest(appDb, {
        mandate_id: mandate.mandate_id,
        opera_account: operaAccount,
        amount_pence: amountPence,
        invoice_refs: invoices,
        payment_id: gcPaymentId,
        charge_date: gcChargeDate,
        description,
        status: gcStatus,
        currency: 'GBP',
    });
    // 9. Estimate arrival = charge_date + 5 days (matches Python's rough estimate)
    let estimatedArrival = null;
    if (gcChargeDate) {
        const cd = new Date(`${gcChargeDate}T00:00:00Z`);
        if (!Number.isNaN(cd.getTime())) {
            cd.setUTCDate(cd.getUTCDate() + 5);
            estimatedArrival = cd.toISOString().slice(0, 10);
        }
    }
    return {
        success: true,
        message: `Payment of £${formatPounds(amountPence / 100)} requested for customer ${operaAccount}`,
        payment_request: {
            ...persisted,
            customer_name: mandate.opera_name ?? operaAccount,
            estimated_arrival: estimatedArrival,
        },
    };
}
export async function requestBulkPayments(appDb, inputs, settings, readOpera, createRemote, today) {
    const results = [];
    let succeeded = 0;
    let failed = 0;
    for (const input of inputs ?? []) {
        try {
            const r = await requestPayment(appDb, input, settings, readOpera, createRemote, today);
            results.push({ opera_account: input.operaAccount ?? null, ...r });
            if (r.success)
                succeeded += 1;
            else
                failed += 1;
        }
        catch (err) {
            results.push({
                opera_account: input.operaAccount ?? null,
                success: false,
                error: err?.message ?? String(err),
            });
            failed += 1;
        }
    }
    return {
        success: failed === 0,
        results,
        summary: { total: inputs?.length ?? 0, succeeded, failed },
    };
}
// Exported helpers for tests / re-use
export const __test__ = {
    buildDescription,
    normaliseChargeDate,
    parseInvoiceRefs,
};
//# sourceMappingURL=request-payment.js.map