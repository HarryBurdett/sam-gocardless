const FINAL_STATUSES = new Set(['completed', 'failed', 'cancelled']);
function dateToIso(d) {
    if (!d)
        return null;
    if (d instanceof Date) {
        if (Number.isNaN(d.getTime()))
            return null;
        return d.toISOString();
    }
    return String(d);
}
function rowToSetup(r) {
    return {
        id: r.id,
        opera_account: r.opera_account ?? '',
        opera_name: r.opera_name ?? '',
        customer_email: r.customer_email ?? '',
        billing_request_id: r.billing_request_id ?? '',
        billing_request_flow_id: r.billing_request_flow_id ?? '',
        authorisation_url: r.authorisation_url ?? '',
        mandate_id: r.mandate_id ?? '',
        gocardless_customer_id: r.gocardless_customer_id ?? '',
        status: r.status ?? 'pending',
        status_detail: r.status_detail ?? '',
        email_sent_at: dateToIso(r.email_sent_at),
        mandate_active_at: dateToIso(r.mandate_active_at),
        created_at: dateToIso(r.created_at) ?? '',
        updated_at: dateToIso(r.updated_at) ?? '',
    };
}
export async function listMandateSetups(appDb) {
    try {
        const rows = (await appDb('mandate_setup_requests').orderBy('id', 'desc'));
        const setups = rows.map(rowToSetup);
        const pendingCount = setups.filter((s) => !FINAL_STATUSES.has(s.status)).length;
        return { success: true, setups, pending_count: pendingCount };
    }
    catch (err) {
        return {
            success: false,
            setups: [],
            pending_count: 0,
            error: err?.message ?? String(err),
        };
    }
}
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
function defaultEmailSubject(companyName) {
    return `Set Up Your Direct Debit — ${companyName}`;
}
function defaultEmailBody(customerName, authUrl, companyName) {
    // HTML matches Python's exactly — same heading, button styling, footer.
    return `
    <html>
    <body style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
      <h2 style="color: #333;">Direct Debit Setup</h2>
      <p>Dear ${customerName || 'Customer'},</p>
      <p>We would like to invite you to set up a Direct Debit with us for convenient automated payment processing.</p>
      <p>Please click the button below to securely set up your Direct Debit mandate through GoCardless:</p>
      <p style="text-align: center; margin: 30px 0;">
        <a href="${authUrl}"
           style="display: inline-block; padding: 14px 28px; background-color: #1a73e8; color: white;
                  text-decoration: none; border-radius: 6px; font-weight: bold; font-size: 16px;">
          Set Up Direct Debit
        </a>
      </p>
      <p>This process is quick, secure, and protected by the <a href="https://www.directdebit.co.uk/direct-debit-guarantee/">Direct Debit Guarantee</a>.</p>
      <p>If you have any questions, please don't hesitate to contact us.</p>
      <p>Kind regards,<br>${companyName}</p>
      <hr style="border: none; border-top: 1px solid #eee; margin-top: 30px;">
      <p style="font-size: 11px; color: #999;">
        If the button above doesn't work, copy and paste this link into your browser:<br>
        <a href="${authUrl}" style="color: #999;">${authUrl}</a>
      </p>
    </body>
    </html>
  `;
}
/**
 * Faithful port of create_mandate_setup
 * (apps/gocardless/api/routes.py:6852-7051). Pipeline:
 *   1. Validate inputs (account, email).
 *   2. Create billing request via remote callback.
 *   3. Create billing-request-flow → authorisation URL.
 *   4. Insert a tracking row (status='pending').
 *   5. Best-effort email dispatch via injected sender. On success
 *      mark status='email_sent' + email_sent_at; on failure leave
 *      status='pending' with status_detail.
 */
export async function createMandateSetup(appDb, input, remote, sendEmail) {
    const operaAccount = (input.operaAccount ?? '').trim();
    const operaName = (input.operaName ?? '').trim();
    const customerEmail = (input.customerEmail ?? '').trim();
    const companyName = (input.companyName ?? '').trim() || 'Our Company';
    if (!operaAccount) {
        return { success: false, error: 'Opera customer account is required' };
    }
    if (!customerEmail) {
        return { success: false, error: 'Customer email address is required' };
    }
    if (!EMAIL_REGEX.test(customerEmail)) {
        return { success: false, error: 'Invalid email address format' };
    }
    // 1. Billing request
    const metadata = { opera_account: operaAccount };
    if (operaName)
        metadata.opera_name = operaName.slice(0, 50);
    const brq = await remote.createBillingRequest({
        customerEmail,
        customerName: operaName || null,
        metadata,
    });
    if (!brq.success || !brq.id) {
        return {
            success: false,
            error: brq.error ?? 'Failed to create billing request in GoCardless',
        };
    }
    // 2. Flow → auth URL
    const flow = await remote.createBillingRequestFlow(brq.id);
    if (!flow.success || !flow.authorisationUrl) {
        return {
            success: false,
            error: flow.error ?? 'Failed to generate authorisation URL from GoCardless',
        };
    }
    // 3. Persist tracking row
    let setupId;
    try {
        const ids = await appDb('mandate_setup_requests')
            .insert({
            opera_account: operaAccount,
            opera_name: operaName || null,
            customer_email: customerEmail,
            billing_request_id: brq.id,
            billing_request_flow_id: flow.flowId ?? null,
            authorisation_url: flow.authorisationUrl,
            status: 'pending',
        })
            .returning('id');
        const inserted = Array.isArray(ids) && ids.length > 0 ? ids[0] : null;
        setupId =
            typeof inserted === 'number'
                ? inserted
                : typeof inserted?.id === 'number'
                    ? inserted.id
                    : 0;
    }
    catch (err) {
        return { success: false, error: err?.message ?? String(err) };
    }
    // 4. Email dispatch (best-effort)
    let emailSent = false;
    let emailError = null;
    if (sendEmail) {
        try {
            const subject = (input.emailSubject ?? '').trim() || defaultEmailSubject(companyName);
            const bodyTemplate = (input.emailBodyHtml ?? '').trim() ||
                defaultEmailBody(operaName, flow.authorisationUrl, companyName);
            const body = bodyTemplate.includes('{authorisation_url}')
                ? bodyTemplate.replaceAll('{authorisation_url}', flow.authorisationUrl)
                : bodyTemplate;
            const sendResult = await sendEmail({
                to: customerEmail,
                subject,
                bodyHtml: body,
            });
            if (sendResult.success) {
                emailSent = true;
            }
            else {
                emailError = sendResult.error ?? 'Email send failed';
            }
        }
        catch (err) {
            emailError = err?.message ?? String(err);
        }
    }
    else {
        emailError = 'No email sender configured';
    }
    // 5. Update setup status based on email outcome
    try {
        if (emailSent) {
            await appDb('mandate_setup_requests')
                .where({ id: setupId })
                .update({
                status: 'email_sent',
                email_sent_at: appDb.fn.now(),
                updated_at: appDb.fn.now(),
            });
        }
        else {
            await appDb('mandate_setup_requests')
                .where({ id: setupId })
                .update({
                status: 'pending',
                status_detail: `Email not sent: ${emailError}`,
                updated_at: appDb.fn.now(),
            });
        }
    }
    catch {
        // best-effort
    }
    // 6. Return enriched setup record
    const fresh = (await appDb('mandate_setup_requests')
        .where({ id: setupId })
        .first());
    return {
        success: true,
        message: `Mandate setup initiated for ${operaName || operaAccount}`,
        setup: fresh ? rowToSetup(fresh) : undefined,
        email_sent: emailSent,
        email_error: emailError,
        authorisation_url: flow.authorisationUrl,
    };
}
/**
 * Faithful port of check_mandate_setups
 * (apps/gocardless/api/routes.py:7070-7186).
 *
 * For each pending mandate setup row:
 *   1. Fetch the billing_request status via the remote callback
 *   2. Map brq.status + mandate.status to a local status:
 *        brq=fulfilled  + mandate=active                 → completed
 *        brq=fulfilled  + mandate=pending_*              → mandate_created
 *        brq=fulfilled  + mandate=cancelled/expired/failed → failed
 *        brq=pending|action_required + setup=email_sent → authorisation_pending
 *        brq=cancelled                                   → cancelled
 *   3. Persist any non-null update_fields to the local row
 *   4. If the new status is 'completed' AND we have a mandate_id,
 *      call completeSetup which links the mandate + sets
 *      sn_analsys='GC' on the Opera customer
 *
 * Per-row failures are reported in updates[] but never abort the run.
 */
export async function checkPendingMandateSetups(appDb, remote, completeSetup) {
    try {
        const rows = (await appDb('mandate_setup_requests').orderBy('id', 'desc'));
        const pending = rows.filter((r) => !FINAL_STATUSES.has((r.status ?? '').trim()));
        if (pending.length === 0) {
            return {
                success: true,
                message: 'No pending setups to check',
                updates: [],
            };
        }
        const updates = [];
        for (const row of pending) {
            const setup = rowToSetup(row);
            if (!setup.billing_request_id)
                continue;
            try {
                const brq = await remote.getBillingRequest(setup.billing_request_id);
                if (!brq.success) {
                    updates.push({
                        setup_id: setup.id,
                        opera_account: setup.opera_account,
                        opera_name: setup.opera_name,
                        old_status: setup.status,
                        error: brq.error ?? 'Billing request lookup failed',
                    });
                    continue;
                }
                const brqStatus = brq.status ?? '';
                const mandateId = brq.mandateId ?? null;
                const customerId = brq.customerId ?? null;
                const updateFields = {};
                if (customerId && customerId !== setup.gocardless_customer_id) {
                    updateFields.gocardless_customer_id = customerId;
                }
                if (mandateId && mandateId !== setup.mandate_id) {
                    updateFields.mandate_id = mandateId;
                }
                let newStatusForLink = null;
                if (brqStatus === 'fulfilled' && mandateId) {
                    // Resolve mandate status — best-effort, default to mandate_created
                    let mandateStatus = '';
                    try {
                        const m = await remote.getMandate(mandateId);
                        if (m.success)
                            mandateStatus = m.status ?? '';
                    }
                    catch {
                        // best-effort
                    }
                    if (mandateStatus === 'active') {
                        updateFields.status = 'completed';
                        updateFields.mandate_active_at = appDb.fn.now();
                        updateFields.status_detail = `Mandate ${mandateId} is active`;
                        newStatusForLink = 'completed';
                    }
                    else if (mandateStatus === 'pending_customer_approval' ||
                        mandateStatus === 'pending_submission' ||
                        mandateStatus === 'submitted') {
                        updateFields.status = 'mandate_created';
                        updateFields.status_detail = `Mandate ${mandateId} status: ${mandateStatus}`;
                    }
                    else if (mandateStatus === 'cancelled' ||
                        mandateStatus === 'expired' ||
                        mandateStatus === 'failed') {
                        updateFields.status = 'failed';
                        updateFields.status_detail = `Mandate ${mandateId} ${mandateStatus}`;
                    }
                    else {
                        updateFields.status = 'mandate_created';
                        updateFields.status_detail = mandateStatus
                            ? `Mandate ${mandateId} status: ${mandateStatus}`
                            : `Mandate ${mandateId} created (status check failed)`;
                    }
                }
                else if (brqStatus === 'pending' || brqStatus === 'action_required') {
                    if (setup.status === 'email_sent') {
                        updateFields.status = 'authorisation_pending';
                        updateFields.status_detail =
                            'Awaiting customer to complete authorisation';
                    }
                }
                else if (brqStatus === 'cancelled') {
                    updateFields.status = 'cancelled';
                    updateFields.status_detail = 'Billing request was cancelled';
                }
                if (Object.keys(updateFields).length > 0) {
                    updateFields.updated_at = appDb.fn.now();
                    await appDb('mandate_setup_requests')
                        .where({ id: setup.id })
                        .update(updateFields);
                    if (newStatusForLink === 'completed' && mandateId && completeSetup) {
                        try {
                            await completeSetup({
                                setup,
                                mandateId,
                                gocardlessCustomerId: customerId,
                            });
                        }
                        catch {
                            // best-effort — Python logs and continues
                        }
                    }
                    const fresh = (await appDb('mandate_setup_requests')
                        .where({ id: setup.id })
                        .first());
                    updates.push({
                        setup_id: setup.id,
                        opera_account: setup.opera_account,
                        opera_name: setup.opera_name,
                        old_status: setup.status,
                        new_status: fresh?.status ?? updateFields.status,
                        mandate_id: mandateId,
                    });
                }
            }
            catch (err) {
                updates.push({
                    setup_id: setup.id,
                    opera_account: setup.opera_account,
                    opera_name: setup.opera_name,
                    old_status: setup.status,
                    error: err?.message ?? String(err),
                });
            }
        }
        return {
            success: true,
            message: `Checked ${pending.length} pending setups, ${updates.length} updated`,
            updates,
        };
    }
    catch (err) {
        return {
            success: false,
            updates: [],
            error: err?.message ?? String(err),
        };
    }
}
export async function cancelMandateSetup(appDb, setupId) {
    if (!Number.isFinite(setupId) || setupId <= 0) {
        return { success: false, error: 'setup_id must be a positive number' };
    }
    try {
        const row = (await appDb('mandate_setup_requests')
            .where({ id: setupId })
            .first());
        if (!row) {
            return { success: false, error: 'Setup request not found' };
        }
        const status = (row.status ?? '').trim();
        if (FINAL_STATUSES.has(status)) {
            return {
                success: false,
                error: `Cannot cancel — setup is already ${status}`,
            };
        }
        await appDb('mandate_setup_requests').where({ id: setupId }).update({
            status: 'cancelled',
            status_detail: 'Cancelled by user',
            updated_at: appDb.fn.now(),
        });
        const display = (row.opera_name ?? '').trim() || (row.opera_account ?? '').trim();
        return {
            success: true,
            message: `Mandate setup for ${display} cancelled`,
        };
    }
    catch (err) {
        return { success: false, error: err?.message ?? String(err) };
    }
}
//# sourceMappingURL=mandate-setups.js.map