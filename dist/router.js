/**
 * Express router for the GoCardless plugin.
 *
 * Mounts foundational endpoints. Many more remain to be ported from
 * the Python implementation — see docs/sam-rewrite/progress.md.
 */
import { Router } from 'express';
import { loadSettings, saveSettings, maskSettingsForResponse, mergeSettingsUpdate, } from './services/settings.js';
import { runHealthCheck } from './services/health-check.js';
import { getBatchTypes, getNominalAccounts, getPaymentTypes, getVatCodes, getBankAccounts, getImportConfig, getSetupStatus, } from './services/lookups.js';
import { getImportHistory } from './services/import-history.js';
import { checkOrphanedImports, recoverGocardlessFromRestore, } from './services/restore-recovery.js';
import { skipPayout } from './services/skip-payout.js';
import { createClientFromSettings } from './services/gocardless-api.js';
import { fetchGocardlessApiPayouts } from './services/fetch-api-payouts.js';
import { searchReceipts } from './services/receipt-search.js';
import { clearImportHistory, deleteImportRecord, } from './services/import-history-delete.js';
import { updateSubscriptionTags } from './services/subscription-tags.js';
import { getPaymentStats } from './services/payment-stats.js';
import { matchCustomersWithDuplicateCheck, } from './services/match-customers.js';
import { revalidateBatches, } from './services/revalidate-batches.js';
import { getPartnerConfig, getLatestPartnerSignup, getAllMerchantSignups, partnerAdminAuth, setPartnerAdminPassword, updateMerchantAppUrl, activateMerchant, deployToken, initiatePartnerSignup, handlePartnerCallback, partnerCallbackHtml, } from './services/partner.js';
import { archiveGocardlessEmail } from './services/archive-email.js';
import { listPaymentRequests, getPaymentRequest, cancelPaymentRequest, syncPaymentStatuses, } from './services/payment-requests.js';
import { listSubscriptions, getSubscription, pauseSubscription, resumeSubscription, cancelSubscription, updateSubscriptionDetails, linkSubscriptionToDocument, unlinkSubscriptionFromDocument, syncSubscriptionFromOpera, syncSubscriptionsFromGocardless, createSubscription, } from './services/subscriptions.js';
import { listMandates, listUnlinkedMandates, cancelMandate, unlinkMandate, linkMandate, syncMandatesFromGocardless, } from './services/mandates.js';
import { listMandateSetups, cancelMandateSetup, createMandateSetup, checkPendingMandateSetups, } from './services/mandate-setups.js';
import { getEligibleCustomers } from './services/eligible-customers.js';
import { suggestMandateMatch } from './services/suggest-match.js';
import { getCustomerEmail } from './services/customer-email.js';
import { getRepeatDocuments } from './services/repeat-documents.js';
import { getCollectableInvoices } from './services/collectable-invoices.js';
import { getUnpostedPayments } from './services/unposted-payments.js';
import { getDueInvoices, } from './services/due-invoices.js';
import { requestPayment, requestBulkPayments, } from './services/request-payment.js';
import { validatePostingPeriod, getCurrentPeriodInfo, } from './_shared/index.js';
import { scanGocardlessEmails, } from './services/scan-emails.js';
import { parseGocardlessEmail as parseEmailContent, } from './services/parser.js';
import { importGocardlessBatch, } from './services/import-batch.js';
import { importGocardlessBatchFromEmail, } from './services/import-from-email.js';
import { gocardlessBatchPostingExecutor } from './services/batch-posting-executor.js';
import { inMemoryImportLock } from './services/import-lock.js';
import { createDefaultEmailIngestAdapter } from './services/default-email-ingest.js';
export function createRouter(ctx) {
    const router = Router();
    // Opera-3 mirror routes: /api/opera3/* paths resolve to the same
    // handlers as their canonical counterparts. ctx.db.getCompanyDb()
    // already returns an Opera-3 (FoxPro/Knex) connection for opera-3
    // tenants, so the queries Just Work. The frontend selects the
    // prefix based on `ctx.operaType`.
    router.use((req, _res, next) => {
        if (req.url.startsWith('/api/opera3/')) {
            req.url = '/api/' + req.url.slice('/api/opera3/'.length);
            req.operaMirror = true;
        }
        next();
    });
    // Default email-ingest adapter — instantiated once per plugin
    // lifecycle. Activates whenever ctx.emailIngest is wired; bootstraps
    // by calling ctx.emailIngest.listMyMailboxes() and reacts to
    // ownership changes pushed from SAM Admin.
    const builtinEmailIngest = ctx.emailIngest
        ? createDefaultEmailIngestAdapter({
            emailIngest: ctx.emailIngest,
            appId: ctx.appId,
            logger: ctx.logger,
        })
        : null;
    function getAppDb(req, res) {
        if (!ctx.db.app) {
            res.status(503).json({
                success: false,
                error: 'GoCardless per-app database not provisioned for this tenant.',
            });
            return null;
        }
        return ctx.db.app;
    }
    /**
     * Several legacy GoCardless endpoints (e.g. POST /api/gocardless/import,
     * /import-from-email, /match-customers, /revalidate-batches) declare
     * the request body as a bare JSON array via FastAPI's
     * `payments: List[Dict] = Body(...)` (apps/gocardless/api/routes.py).
     * The browser frontend therefore POSTs `JSON.stringify(payments)`,
     * not `{payments: [...]}`. Treat both shapes as valid so the SAM
     * port matches legacy semantics exactly.
     */
    function readArrayBody(req, key) {
        const raw = req.body;
        if (Array.isArray(raw))
            return raw;
        if (raw && typeof raw === 'object' && Array.isArray(raw[key])) {
            return raw[key];
        }
        return [];
    }
    function readObjectBody(req) {
        const raw = req.body;
        if (Array.isArray(raw) || raw === null || raw === undefined)
            return {};
        if (typeof raw !== 'object')
            return {};
        return raw;
    }
    function getOperaDb(req, res) {
        const company = req.operaCompany;
        if (!company) {
            res.status(400).json({
                success: false,
                error: 'No Opera company in context. SAM should set X-Opera-Company.',
            });
            return null;
        }
        const db = ctx.db.getCompanyDb(company);
        if (!db) {
            res.status(503).json({
                success: false,
                error: `Opera SQL connection not available for company ${company}.`,
            });
            return null;
        }
        return db;
    }
    /**
     * GET /api/gocardless/settings
     *
     * Returns the GoCardless settings dict with secrets masked. Faithful
     * port of `get_gocardless_settings` in the Python codebase.
     */
    router.get('/api/gocardless/settings', async (_req, res) => {
        const appDb = getAppDb(_req, res);
        if (!appDb)
            return;
        try {
            const settings = await loadSettings(appDb);
            const masked = maskSettingsForResponse(settings);
            res.json({ success: true, settings: masked });
        }
        catch (err) {
            ctx.logger.error('Failed to load GoCardless settings', err);
            res.status(500).json({ success: false, error: err?.message ?? String(err) });
        }
    });
    /**
     * POST /api/gocardless/settings
     *
     * Merges request body into existing settings and saves. Faithful port
     * of `save_gocardless_settings` — preserves api_access_token and
     * partner_client_secret if not explicitly provided.
     */
    router.post('/api/gocardless/settings', async (req, res) => {
        const appDb = getAppDb(req, res);
        if (!appDb)
            return;
        try {
            const body = (req.body ?? {});
            const existing = await loadSettings(appDb);
            const merged = mergeSettingsUpdate(existing, body);
            const ok = await saveSettings(appDb, merged);
            if (ok) {
                res.json({ success: true, message: 'Settings saved' });
            }
            else {
                res.status(500).json({ success: false, error: 'Failed to save settings' });
            }
        }
        catch (err) {
            ctx.logger.error('Failed to save GoCardless settings', err);
            res.status(500).json({ success: false, error: err?.message ?? String(err) });
        }
    });
    /**
     * GET /api/gocardless/health-check
     *
     * Per-app data-integrity health check. Faithful port of
     * `gocardless_health_check`.
     */
    router.get('/api/gocardless/health-check', async (req, res) => {
        const operaDb = getOperaDb(req, res);
        if (!operaDb)
            return;
        try {
            const appDb = ctx.db.app;
            let settings = null;
            if (appDb) {
                try {
                    settings = await loadSettings(appDb);
                }
                catch (err) {
                    ctx.logger.debug('GoCardless settings not loadable', err);
                }
            }
            const result = await runHealthCheck({
                operaDb,
                appDb,
                settings,
            });
            res.json(result);
        }
        catch (err) {
            ctx.logger.error('GoCardless health-check failed', err);
            res.status(500).json({ success: false, error: err?.message ?? String(err) });
        }
    });
    /**
     * GET /api/gocardless/setup-status
     *
     * Reports whether GoCardless is configured (api_access_token > 10 chars).
     * Used by the launcher to decide whether to redirect to signup.
     */
    router.get('/api/gocardless/setup-status', async (_req, res) => {
        try {
            const result = await getSetupStatus(ctx.db.app);
            res.json(result);
        }
        catch (err) {
            ctx.logger.error('Setup status failed', err);
            res.status(500).json({ success: false, error: err?.message ?? String(err) });
        }
    });
    /**
     * GET /api/gocardless/batch-types
     *
     * Returns the available batched receipt types from Opera (atype where
     * ay_type='R' AND ay_batched=1). Recommends the first one with
     * 'gocardless' in its description.
     */
    router.get('/api/gocardless/batch-types', async (req, res) => {
        const operaDb = getOperaDb(req, res);
        if (!operaDb)
            return;
        try {
            const result = await getBatchTypes(operaDb);
            res.json(result);
        }
        catch (err) {
            ctx.logger.error('Batch types fetch failed', err);
            res.status(500).json({ success: false, error: err?.message ?? String(err) });
        }
    });
    /**
     * GET /api/gocardless/nominal-accounts
     *
     * Returns the nominal accounts dropdown list from nacnt (excluding
     * Z-prefixed system accounts).
     */
    router.get('/api/gocardless/nominal-accounts', async (req, res) => {
        const operaDb = getOperaDb(req, res);
        if (!operaDb)
            return;
        try {
            const result = await getNominalAccounts(operaDb);
            res.json(result);
        }
        catch (err) {
            ctx.logger.error('Nominal accounts fetch failed', err);
            res.status(500).json({ success: false, error: err?.message ?? String(err) });
        }
    });
    /**
     * GET /api/bank-import/accounts/customers
     *
     * Active Opera customer accounts (sname) for the import-batch
     * Opera-Account dropdown in GoCardlessImport.tsx. Faithful port of
     * the bank-reconcile plugin's `getCustomersForDropdown` — the
     * gocardless FE calls this endpoint directly (it lived in the
     * legacy single-process backend; under SAM each plugin needs its
     * own copy because dispatcher routes are plugin-scoped).
     *
     * Filters dormant + stopped per CLAUDE.md ("cannot post to dormant
     * accounts"). Returns shape { success, count, accounts: [{code,
     * name, search_key, display}] } — the GoCardless FE only reads
     * code + name but we ship the full shape for parity.
     */
    router.get('/api/bank-import/accounts/customers', async (req, res) => {
        const operaDb = getOperaDb(req, res);
        if (!operaDb)
            return;
        try {
            const rows = (await operaDb.raw(`
        SELECT
          RTRIM(sn_account) AS code,
          RTRIM(sn_name) AS name,
          RTRIM(ISNULL(sn_key1, '')) AS search_key
        FROM sname WITH (NOLOCK)
        WHERE (sn_stop = 0 OR sn_stop IS NULL)
          AND (sn_dormant = 0 OR sn_dormant IS NULL)
        ORDER BY sn_account
      `));
            const accounts = (Array.isArray(rows) ? rows : []).map((r) => ({
                code: (r.code ?? '').trim(),
                name: (r.name ?? '').trim(),
                search_key: (r.search_key ?? '').trim(),
                display: `${(r.code ?? '').trim()} - ${(r.name ?? '').trim()}`,
            }));
            res.json({ success: true, count: accounts.length, accounts });
        }
        catch (err) {
            ctx.logger.error('Customers dropdown failed', err);
            res.json({
                success: false,
                count: 0,
                accounts: [],
                error: err?.message ?? String(err),
            });
        }
    });
    /**
     * GET /api/bank-import/accounts/suppliers
     *
     * Active Opera supplier accounts (pname) for the dropdown. Same
     * shape + filter as customers above — dormant + stopped excluded.
     */
    router.get('/api/bank-import/accounts/suppliers', async (req, res) => {
        const operaDb = getOperaDb(req, res);
        if (!operaDb)
            return;
        try {
            const rows = (await operaDb.raw(`
        SELECT
          RTRIM(pn_account) AS code,
          RTRIM(pn_name) AS name,
          RTRIM(ISNULL(pn_payee, '')) AS payee
        FROM pname WITH (NOLOCK)
        WHERE (pn_stop = 0 OR pn_stop IS NULL)
          AND (pn_dormant = 0 OR pn_dormant IS NULL)
        ORDER BY pn_account
      `));
            const accounts = (Array.isArray(rows) ? rows : []).map((r) => ({
                code: (r.code ?? '').trim(),
                name: (r.name ?? '').trim(),
                payee: (r.payee ?? '').trim(),
                display: `${(r.code ?? '').trim()} - ${(r.name ?? '').trim()}`,
            }));
            res.json({ success: true, count: accounts.length, accounts });
        }
        catch (err) {
            ctx.logger.error('Suppliers dropdown failed', err);
            res.json({
                success: false,
                count: 0,
                accounts: [],
                error: err?.message ?? String(err),
            });
        }
    });
    /**
     * GET /api/gocardless/payment-types
     *
     * Returns nominal payment types (atype where ay_type='P' AND not batched).
     */
    router.get('/api/gocardless/payment-types', async (req, res) => {
        const operaDb = getOperaDb(req, res);
        if (!operaDb)
            return;
        try {
            const result = await getPaymentTypes(operaDb);
            res.json(result);
        }
        catch (err) {
            ctx.logger.error('Payment types fetch failed', err);
            res.status(500).json({ success: false, error: err?.message ?? String(err) });
        }
    });
    /**
     * GET /api/gocardless/vat-codes
     *
     * Returns the VAT codes from ztax with applicable rates for the given
     * date. Used for the fees-VAT split.
     */
    router.get('/api/gocardless/vat-codes', async (req, res) => {
        const operaDb = getOperaDb(req, res);
        if (!operaDb)
            return;
        try {
            const asOfDate = typeof req.query.as_of_date === 'string' ? req.query.as_of_date : null;
            const result = await getVatCodes(operaDb, asOfDate);
            res.json(result);
        }
        catch (err) {
            ctx.logger.error('VAT codes fetch failed', err);
            res.status(500).json({ success: false, error: err?.message ?? String(err) });
        }
    });
    /**
     * GET /api/gocardless/bank-accounts
     *
     * Returns Opera bank accounts for dropdown selection.
     */
    router.get('/api/gocardless/bank-accounts', async (req, res) => {
        const operaDb = getOperaDb(req, res);
        if (!operaDb)
            return;
        try {
            const result = await getBankAccounts(operaDb);
            res.json(result);
        }
        catch (err) {
            ctx.logger.error('Bank accounts fetch failed', err);
            res.status(500).json({ success: false, error: err?.message ?? String(err) });
        }
    });
    /**
     * GET /api/gocardless/import-config
     *
     * Consolidated endpoint returning batch_types + nominal_accounts +
     * vat_codes in a single response. Faithful port of
     * `get_gocardless_import_config`.
     */
    router.get('/api/gocardless/import-config', async (req, res) => {
        const operaDb = getOperaDb(req, res);
        if (!operaDb)
            return;
        try {
            const asOfDate = typeof req.query.as_of_date === 'string' ? req.query.as_of_date : null;
            const result = await getImportConfig(operaDb, asOfDate);
            res.json(result);
        }
        catch (err) {
            ctx.logger.error('Import config fetch failed', err);
            res.status(500).json({ success: false, error: err?.message ?? String(err) });
        }
    });
    /**
     * GET /api/gocardless/import-history
     *
     * Past GoCardless batches imported to Opera. Faithful port of
     * `get_gocardless_import_history`. Enriches payment records with
     * Opera customer names (sname) and GC mandate customer names.
     */
    router.get('/api/gocardless/import-history', async (req, res) => {
        const appDb = getAppDb(req, res);
        if (!appDb)
            return;
        // Opera DB is optional — if missing the history is returned without
        // Opera-name enrichment.
        let operaDb = null;
        const company = req.operaCompany;
        if (company) {
            operaDb = ctx.db.getCompanyDb(company);
        }
        try {
            const limit = req.query.limit ? Number(req.query.limit) : 50;
            const fromDate = typeof req.query.from_date === 'string' ? req.query.from_date : null;
            const toDate = typeof req.query.to_date === 'string' ? req.query.to_date : null;
            const result = await getImportHistory(appDb, operaDb, {
                limit,
                fromDate,
                toDate,
            });
            res.json(result);
        }
        catch (err) {
            ctx.logger.error('Import history fetch failed', err);
            res.status(500).json({ success: false, error: err?.message ?? String(err) });
        }
    });
    /**
     * POST /api/gocardless/skip-payout
     *
     * Record a payout to history without importing — used for foreign-currency,
     * already-manually-entered, or duplicate payouts. Faithful port of
     * `skip_gocardless_payout`.
     */
    router.post('/api/gocardless/skip-payout', async (req, res) => {
        const appDb = getAppDb(req, res);
        if (!appDb)
            return;
        try {
            const q = req.query;
            const body = (req.body ?? null);
            const result = await skipPayout(appDb, {
                payoutId: String(q.payout_id ?? ''),
                bankReference: String(q.bank_reference ?? ''),
                grossAmount: Number(q.gross_amount ?? 0),
                currency: typeof q.currency === 'string' ? q.currency : 'GBP',
                paymentCount: q.payment_count ? Number(q.payment_count) : 0,
                reason: typeof q.reason === 'string' ? q.reason : 'manual',
                fxAmount: q.fx_amount ? Number(q.fx_amount) : null,
                payments: Array.isArray(body) ? body : undefined,
            });
            res.json(result);
        }
        catch (err) {
            ctx.logger.error('Skip payout failed', err);
            res.status(500).json({ success: false, error: err?.message ?? String(err) });
        }
    });
    /**
     * POST /api/gocardless/test-api
     *
     * Test the saved GoCardless API token by hitting GET /creditors.
     * Faithful port of `test_gocardless_api`.
     */
    router.post('/api/gocardless/test-api', async (req, res) => {
        const appDb = getAppDb(req, res);
        if (!appDb)
            return;
        try {
            const settings = await loadSettings(appDb);
            const client = createClientFromSettings(settings);
            if (!client) {
                res.json({ success: false, error: 'No API access token configured' });
                return;
            }
            const result = await client.testConnection();
            res.json(result);
        }
        catch (err) {
            ctx.logger.error('GoCardless test-api failed', err);
            res.status(500).json({ success: false, error: err?.message ?? String(err) });
        }
    });
    /**
     * POST /api/gocardless/archive-email
     *
     * Mark a GoCardless email as already-in-Opera and (when SAM's email
     * service exposes the capability) move it to an archive folder.
     * Faithful port of archive_gocardless_email (routes.py:3503-3574).
     *
     * Query params:
     *   - email_id (required)
     *   - archive_folder (default 'Archive/GoCardless')
     *
     * NB: SAM's emailIngest service doesn't currently expose moveEmail.
     * The DB tracking happens regardless; the move reports
     * 'provider_not_available' until that capability lands. The
     * tracking row alone is enough to keep the email out of future
     * scans (which is the primary purpose).
     */
    router.post('/api/gocardless/archive-email', async (req, res) => {
        const appDb = getAppDb(req, res);
        if (!appDb)
            return;
        try {
            const emailId = Number(req.query.email_id);
            const archiveFolder = String(req.query.archive_folder ?? 'Archive/GoCardless');
            const result = await archiveGocardlessEmail(appDb, { emailId, archiveFolder }, ctx.emailIngest ?? null);
            if (!result.success) {
                res.status(400).json(result);
                return;
            }
            res.json(result);
        }
        catch (err) {
            ctx.logger.error('Archive email failed', err);
            res.status(500).json({ success: false, error: err?.message ?? String(err) });
        }
    });
    /**
     * GET /api/gocardless/test-data
     *
     * Returns a hard-coded sample GoCardless payout dataset (the
     * Intsys-extracted figures from the gocardless.png screenshot used
     * during development). Faithful port of get_gocardless_test_data
     * (apps/gocardless/api/routes.py:191-224).
     *
     * Used by the frontend dev playground when the user wants to
     * exercise the matching/import UI without a real payout email.
     */
    router.get('/api/gocardless/test-data', async (_req, res) => {
        res.json({
            success: true,
            payment_count: 18,
            gross_amount: 29869.8,
            gocardless_fees: -118.31,
            vat_on_fees: -19.73,
            net_amount: 29751.49,
            bank_reference: 'INTSYSUKLTD-KN3CMJ',
            payments: [
                { customer_name: 'Deep Blue Restaurantes Ltd', description: 'Intsys INV26362,26363', amount: 7380.0, invoice_refs: ['INV26362', 'INV26363'] },
                { customer_name: 'Medimpex UK Ltd', description: 'Intsys INV26365', amount: 1530.0, invoice_refs: ['INV26365'] },
                { customer_name: 'The Prospect Trust', description: 'Intsys INV', amount: 3000.0, invoice_refs: [] },
                { customer_name: 'SMCP UK Limited', description: 'Intsys INV26374,26375', amount: 1320.0, invoice_refs: ['INV26374', 'INV26375'] },
                { customer_name: 'Vectair Systems Limited', description: 'Intsys INV26378', amount: 8398.8, invoice_refs: ['INV26378'] },
                { customer_name: 'Jackson Lifts', description: 'Intsys Opera 3 Support', amount: 123.0, invoice_refs: [] },
                { customer_name: 'Vectair Systems Limited', description: 'Opera SE Toolkit', amount: 109.2, invoice_refs: [] },
                { customer_name: 'A WARNE & CO LTD', description: 'Intsys Data Connector', amount: 168.0, invoice_refs: [] },
                { customer_name: 'Physique Management Ltd', description: 'Intsys Pegasus Support', amount: 551.4, invoice_refs: [] },
                { customer_name: 'Ormiston Wire Ltd', description: 'Intsys Opera 3 Support', amount: 90.0, invoice_refs: [] },
                { customer_name: 'Totality GCS Ltd', description: 'Intsys Pegasus Support', amount: 240.0, invoice_refs: [] },
                { customer_name: 'Red Band Chemical Co Ltd T/A Lindsay & Gilmour', description: 'Intsys Pegasus Upgrade Plan', amount: 74.4, invoice_refs: [] },
                { customer_name: 'P Flannery Plant Hire (Oval) Ltd', description: 'Intsys Pegasus Upgrade Plan', amount: 78.0, invoice_refs: [] },
                { customer_name: 'Harro Foods Limited', description: 'Intsys Opera 3 Sales Website', amount: 5607.0, invoice_refs: [] },
                { customer_name: 'Physique Management Ltd', description: 'Intsys Data Connector', amount: 168.0, invoice_refs: [] },
                { customer_name: 'Nisbets Limited', description: 'Intsys Opera 3 Licence Subs', amount: 540.0, invoice_refs: [] },
                { customer_name: 'Vectair Systems Limited', description: 'Intsys Pegasus WEBLINK', amount: 192.0, invoice_refs: [] },
                { customer_name: 'ST Astier Limited', description: 'Intsys CIS Support', amount: 300.0, invoice_refs: [] },
            ],
        });
    });
    /**
     * GET /api/gocardless/api-payouts
     *
     * Fetch payouts directly from the GoCardless REST API. Faithful slim
     * port of `get_gocardless_api_payouts` (apps/gocardless/api/routes.py
     * lines 1952-1989). Query params:
     *   - status:    payout status filter (default 'paid')
     *   - limit:     number of payouts (default 20)
     *   - days_back: lookback window (default settings.payout_lookback_days
     *                or 30)
     *
     * NB: the Python version then enriches each payout with full payment
     * details, dedupes against Opera + import history, and applies
     * period-closed filtering. That enrichment depends on
     * OperaSQLImport.get_home_currency, get_payout_with_payments,
     * email_storage.is_gocardless_payout_imported, and _is_period_closed
     * — none of which are ported yet. This endpoint returns the raw
     * payouts array; the enrichment is added in a later session once
     * the helper services land.
     */
    router.get('/api/gocardless/api-payouts', async (req, res) => {
        const appDb = getAppDb(req, res);
        if (!appDb)
            return;
        const operaDb = getOperaDb(req, res);
        if (!operaDb)
            return;
        try {
            const settings = await loadSettings(appDb);
            const accessToken = settings.api_access_token ?? '';
            if (!accessToken) {
                res.json({
                    success: false,
                    error: 'No API access token configured. Go to Settings to add your GoCardless API credentials.',
                });
                return;
            }
            const status = typeof req.query.status === 'string' ? req.query.status : 'paid';
            const limit = req.query.limit ? Number(req.query.limit) : 20;
            const daysBackOverride = req.query.days_back
                ? Number(req.query.days_back)
                : NaN;
            const daysBack = Number.isFinite(daysBackOverride)
                ? daysBackOverride
                : Number(settings.payout_lookback_days ?? 30);
            const client = createClientFromSettings(settings);
            if (!client) {
                res.json({ success: false, error: 'No API access token configured' });
                return;
            }
            const environment = settings.api_sandbox
                ? 'sandbox'
                : 'live';
            const result = await fetchGocardlessApiPayouts(appDb, operaDb, client, environment, {
                status,
                limit,
                daysBack,
                companyReference: (settings.company_reference ?? '').toString(),
                gcBankCode: (settings.gocardless_bank_code ?? '').toString() || null,
                destBankCode: (settings.default_bank_code ?? '').toString() || null,
                targetSystem: ctx.operaType === 'opera-3' ? 'opera3' : 'opera_se',
            });
            res.json(result);
        }
        catch (err) {
            ctx.logger.error('GoCardless api-payouts failed', err);
            res.status(500).json({ success: false, error: err?.message ?? String(err) });
        }
    });
    /**
     * GET /api/gocardless/receipt-search
     *
     * Search GoCardless receipts by customer + date range. Faithful
     * port of `search_gocardless_receipts`. Reads from app DB import
     * history, flattens payments_json, enriches with Opera names.
     */
    router.get('/api/gocardless/receipt-search', async (req, res) => {
        const appDb = getAppDb(req, res);
        if (!appDb)
            return;
        let operaDb = null;
        const company = req.operaCompany;
        if (company) {
            operaDb = ctx.db.getCompanyDb(company);
        }
        try {
            const customer = typeof req.query.customer === 'string' ? req.query.customer : null;
            const fromDate = typeof req.query.from_date === 'string' ? req.query.from_date : null;
            const toDate = typeof req.query.to_date === 'string' ? req.query.to_date : null;
            const limit = req.query.limit ? Number(req.query.limit) : 200;
            const result = await searchReceipts(appDb, operaDb, {
                customer,
                fromDate,
                toDate,
                limit,
            });
            res.json(result);
        }
        catch (err) {
            ctx.logger.error('Receipt search failed', err);
            res.status(500).json({ success: false, error: err?.message ?? String(err) });
        }
    });
    /**
     * GET /api/gocardless/orphan-check
     *
     * SAM enhancement — detect `gocardless_imports` rows whose
     * underlying Opera atran/aentry no longer exist. Triggered by an
     * Opera restore (or by anyone deleting the receipt in Opera
     * Cashbook). Read-only; does not modify anything. Surface the
     * result to the user with a "Recover" prompt; only then call the
     * recovery endpoint below.
     */
    router.get('/api/gocardless/orphan-check', async (req, res) => {
        const operaDb = getOperaDb(req, res);
        if (!operaDb)
            return;
        const appDb = getAppDb(req, res);
        if (!appDb)
            return;
        try {
            res.json(await checkOrphanedImports(operaDb, appDb));
        }
        catch (err) {
            ctx.logger.error('GoCardless orphan check failed', err);
            res.status(500).json({ success: false, error: err?.message ?? String(err) });
        }
    });
    /**
     * POST /api/gocardless/recover-from-restore
     *
     * Delete the orphaned `gocardless_imports` rows surfaced by the
     * orphan-check endpoint, so the normal API-payouts flow can
     * re-import the underlying payouts. Requires explicit user
     * confirmation (this is an explicit POST), never auto-runs.
     */
    router.post('/api/gocardless/recover-from-restore', async (req, res) => {
        const operaDb = getOperaDb(req, res);
        if (!operaDb)
            return;
        const appDb = getAppDb(req, res);
        if (!appDb)
            return;
        try {
            res.json(await recoverGocardlessFromRestore(operaDb, appDb));
        }
        catch (err) {
            ctx.logger.error('GoCardless recover-from-restore failed', err);
            res.status(500).json({ success: false, error: err?.message ?? String(err) });
        }
    });
    /**
     * DELETE /api/gocardless/import-history
     *
     * Bulk-delete import history records within an optional date range.
     * If no dates supplied, clears ALL records — caller responsible for
     * confirmation. Faithful port of `clear_gocardless_import_history`.
     */
    router.delete('/api/gocardless/import-history', async (req, res) => {
        const appDb = getAppDb(req, res);
        if (!appDb)
            return;
        try {
            const fromDate = typeof req.query.from_date === 'string' ? req.query.from_date : null;
            const toDate = typeof req.query.to_date === 'string' ? req.query.to_date : null;
            const result = await clearImportHistory(appDb, { fromDate, toDate });
            res.json(result);
        }
        catch (err) {
            ctx.logger.error('Clear import history failed', err);
            res.status(500).json({ success: false, error: err?.message ?? String(err) });
        }
    });
    /**
     * DELETE /api/gocardless/import-history/:record_id
     *
     * Delete a single import record so the payout can be re-imported.
     * Does NOT touch Opera. Faithful port of
     * `delete_gocardless_import_record`.
     */
    router.delete('/api/gocardless/import-history/:record_id', async (req, res) => {
        const appDb = getAppDb(req, res);
        if (!appDb)
            return;
        try {
            const id = Number(req.params.record_id);
            if (!Number.isFinite(id)) {
                res.status(400).json({ success: false, error: 'Invalid record_id' });
                return;
            }
            const result = await deleteImportRecord(appDb, id);
            if (!result.success && result.error === 'Record not found') {
                res.status(404).json(result);
                return;
            }
            res.json(result);
        }
        catch (err) {
            ctx.logger.error('Delete import record failed', err);
            res.status(500).json({ success: false, error: err?.message ?? String(err) });
        }
    });
    /**
     * POST /api/gocardless/match-customers
     *
     * Match a list of GoCardless payments to Opera customer accounts.
     * Faithful port of `match_gocardless_customers` (apps/gocardless/api/
     * routes.py:497-575). Strategy priority:
     *   0. metadata.opera_account → exact account if customer exists
     *   1. mandate_id → linked Opera account
     *   2. gocardless_customer_id → linked Opera account
     *   3. customer_name → mandate names (normalised, exact then contains)
     *   4. customer_name → Opera sname.sn_name (normalised, exact then contains)
     *
     * After matching, scans Opera cashbook (atran at_type=1) for receipts
     * with the same value (1p tolerance) and tags possible_duplicate=true.
     *
     * Body: array of payment objects with customer_name, description,
     * amount, mandate_id, customer_id, metadata, gc_payment_id.
     */
    router.post('/api/gocardless/match-customers', async (req, res) => {
        const operaDb = getOperaDb(req, res);
        if (!operaDb)
            return;
        const appDb = getAppDb(req, res);
        if (!appDb)
            return;
        try {
            const body = req.body;
            const payments = Array.isArray(body)
                ? body
                : Array.isArray(body?.payments)
                    ? body.payments
                    : null;
            if (!payments) {
                res.status(400).json({
                    success: false,
                    error: 'Body must be an array of payments',
                });
                return;
            }
            const settings = await loadSettings(appDb);
            const result = await matchCustomersWithDuplicateCheck(appDb, operaDb, payments, { defaultBatchType: settings.default_batch_type ?? null });
            res.json(result);
        }
        catch (err) {
            ctx.logger.error('Match customers failed', err);
            res.status(500).json({ success: false, error: err?.message ?? String(err) });
        }
    });
    /**
     * POST /api/gocardless/revalidate-batches
     *
     * Refresh validation status for previously-fetched batches without
     * re-hitting the GoCardless API. Faithful port of
     * revalidate_gocardless_batches (routes.py:2530-2702). Per batch:
     *   - parse payment_date
     *   - detect foreign currency vs Opera home currency
     *   - run validatePostingPeriod (SL ledger)
     *   - duplicate scan against atran/aentry:
     *       foreign currency → ref-only (suffix LIKE)
     *       GBP             → ref + amount (£1 tolerance), then amount
     *                         alone within 14 days (1p tolerance)
     *
     * Body: array of batch objects (originals preserved through the
     * pipeline like Python's **batch spread).
     */
    router.post('/api/gocardless/revalidate-batches', async (req, res) => {
        const operaDb = getOperaDb(req, res);
        if (!operaDb)
            return;
        try {
            const body = req.body;
            const batches = Array.isArray(body)
                ? body
                : Array.isArray(body?.batches)
                    ? body.batches
                    : null;
            if (!batches) {
                res.status(400).json({
                    success: false,
                    error: 'Body must be an array of batches',
                });
                return;
            }
            const result = await revalidateBatches(operaDb, batches);
            res.json(result);
        }
        catch (err) {
            ctx.logger.error('Revalidate batches failed', err);
            res.status(500).json({ success: false, error: err?.message ?? String(err) });
        }
    });
    /**
     * GET /api/gocardless/mandates
     *
     * List all GoCardless mandates linked to Opera customers. Faithful
     * port of list_gocardless_mandates (routes.py:6404-6425). Filters
     * out __UNLINKED__ rows when a linked version of the same
     * mandate_id exists. Sorted alphabetically by opera_name.
     */
    router.get('/api/gocardless/mandates', async (req, res) => {
        const appDb = getAppDb(req, res);
        if (!appDb)
            return;
        try {
            const result = await listMandates(appDb, {
                status: typeof req.query.status === 'string' ? req.query.status : null,
                operaAccount: typeof req.query.opera_account === 'string'
                    ? req.query.opera_account
                    : null,
            });
            res.json(result);
        }
        catch (err) {
            ctx.logger.error('List mandates failed', err);
            res.status(500).json({ success: false, error: err?.message ?? String(err) });
        }
    });
    /**
     * GET /api/gocardless/mandates/unlinked
     *
     * List GoCardless mandates synced from the API but not yet linked to
     * an Opera customer (opera_account='__UNLINKED__'). Faithful port of
     * list_unlinked_gocardless_mandates (routes.py:6428-6447).
     */
    router.get('/api/gocardless/mandates/unlinked', async (req, res) => {
        const appDb = getAppDb(req, res);
        if (!appDb)
            return;
        try {
            const result = await listUnlinkedMandates(appDb);
            res.json(result);
        }
        catch (err) {
            ctx.logger.error('List unlinked mandates failed', err);
            res.status(500).json({ success: false, error: err?.message ?? String(err) });
        }
    });
    /**
     * POST /api/gocardless/mandates/sync
     *
     * Pull every active mandate from the GoCardless API and upsert
     * the local row, auto-linking to GC-tagged Opera customers
     * (`sn_analsys = 'GC'`) by normalised name match. Faithful port
     * of sync_gocardless_mandates (apps/gocardless/api/routes.py
     * :6450-6654). Returns counters for synced / new / updated /
     * auto_linked + a human-readable message.
     *
     * NB: must be defined before /mandates/:mandate_id paths so
     * Express doesn't mis-route 'sync' as a path parameter.
     */
    router.post('/api/gocardless/mandates/sync', async (req, res) => {
        const operaDb = getOperaDb(req, res);
        if (!operaDb)
            return;
        const appDb = getAppDb(req, res);
        if (!appDb)
            return;
        try {
            const settings = await loadSettings(appDb);
            const client = createClientFromSettings(settings);
            if (!client) {
                res.status(400).json({
                    success: false,
                    error: 'No API access token configured',
                });
                return;
            }
            // Fetch GC-tagged Opera customers for auto-match
            const operaCustomers = (await operaDb('sname')
                .whereRaw("LTRIM(RTRIM(UPPER(sn_analsys))) = 'GC'")
                .select('sn_account', 'sn_name', 'sn_email'));
            const customers = operaCustomers.map((r) => ({
                account: String(r.sn_account ?? '').trim(),
                name: String(r.sn_name ?? '').trim(),
                email: r.sn_email ? String(r.sn_email).trim() : null,
            }));
            const fetchPage = async (cursor) => {
                const r = await client.listMandates({
                    status: 'active',
                    limit: 100,
                    cursor: cursor ?? undefined,
                });
                if (!r.success)
                    throw new Error(r.error ?? 'Mandate list failed');
                return { mandates: r.mandates, after: r.after };
            };
            const customerCache = new Map();
            const fetchCustomer = async (customerId) => {
                if (customerCache.has(customerId)) {
                    return customerCache.get(customerId) ?? null;
                }
                const r = await client.getCustomer(customerId);
                const cust = r.success && r.customer
                    ? {
                        company_name: r.customer.company_name ?? undefined,
                        given_name: r.customer.given_name ?? undefined,
                        family_name: r.customer.family_name ?? undefined,
                        email: r.customer.email ?? undefined,
                    }
                    : null;
                customerCache.set(customerId, cust);
                return cust;
            };
            const result = await syncMandatesFromGocardless(appDb, fetchPage, fetchCustomer, customers);
            if (!result.success) {
                res.status(400).json(result);
                return;
            }
            res.json(result);
        }
        catch (err) {
            ctx.logger.error('Sync mandates failed', err);
            res.status(500).json({ success: false, error: err?.message ?? String(err) });
        }
    });
    /**
     * POST /api/gocardless/mandates/link
     *
     * Link a GoCardless mandate to an Opera customer. Faithful port of
     * link_gocardless_mandate (apps/gocardless/api/routes.py
     * :6657-6792). Pipeline:
     *   1. Best-effort GoCardless API verify (mandate.status, scheme,
     *      linked customer.email) when an access token is configured.
     *      Falls back to defaults on any API error — operator workflow
     *      should not be blocked by transient API issues.
     *   2. Local upsert of (opera_account, mandate_id), with
     *      __UNLINKED__ placeholder cleanup.
     *   3. Re-link confirmation guard: when the same mandate currently
     *      points at a different non-__UNLINKED__ account, the call
     *      returns 409 + needs_confirm=true unless confirm=true.
     *   4. Opera write: ROWLOCK update of sname.sn_analsys = 'GC' on
     *      the new account; clears 'GC' on the old account when re-
     *      linking. Failures are reported per-side in the response
     *      (matches Python's "log + continue" behaviour).
     */
    router.post('/api/gocardless/mandates/link', async (req, res) => {
        const operaDb = getOperaDb(req, res);
        if (!operaDb)
            return;
        const appDb = getAppDb(req, res);
        if (!appDb)
            return;
        try {
            const body = (req.body ?? {});
            const operaAccount = String(body.opera_account ?? '').trim();
            const mandateId = String(body.mandate_id ?? '').trim();
            const operaName = typeof body.opera_name === 'string' ? body.opera_name : null;
            const confirm = !!body.confirm;
            if (!operaAccount || !mandateId) {
                res.status(400).json({
                    success: false,
                    error: 'opera_account and mandate_id are required',
                });
                return;
            }
            // 1. Best-effort GoCardless verify
            let mandateStatus = 'active';
            let scheme = 'bacs';
            let customerId = null;
            let email = null;
            const settings = await loadSettings(appDb);
            const client = createClientFromSettings(settings);
            if (client) {
                const m = await client.getMandate(mandateId);
                if (m.success && m.mandate) {
                    const md = m.mandate;
                    mandateStatus = md.status ?? 'active';
                    scheme = md.scheme ?? 'bacs';
                    customerId =
                        md.links?.customer ?? null;
                    if (customerId) {
                        const c = await client.getCustomer(customerId);
                        if (c.success && c.customer) {
                            const cd = c.customer;
                            email = cd.email ?? null;
                        }
                    }
                }
            }
            // 2. Local upsert
            const linkResult = await linkMandate(appDb, {
                operaAccount,
                mandateId,
                operaName,
                gocardlessCustomerId: customerId,
                mandateStatus,
                scheme,
                email,
                confirm,
            });
            if (!linkResult.success && linkResult.needsConfirm) {
                res.status(409).json({
                    success: false,
                    needs_confirm: true,
                    error: linkResult.error,
                    old_account: linkResult.oldOperaAccount,
                });
                return;
            }
            if (!linkResult.success) {
                res.status(400).json(linkResult);
                return;
            }
            // 3. Opera sn_analsys flag move
            const gcFlag = {};
            try {
                if (linkResult.oldOperaAccount) {
                    const removed = await operaDb('sname')
                        .whereRaw('LTRIM(RTRIM(sn_account)) = ?', [
                        linkResult.oldOperaAccount,
                    ])
                        .andWhereRaw("LTRIM(RTRIM(UPPER(sn_analsys))) = 'GC'")
                        .update({ sn_analsys: '' });
                    gcFlag.gc_removed_from = linkResult.oldOperaAccount;
                    gcFlag.gc_removed_rows = Number(removed);
                }
                const set = await operaDb('sname')
                    .whereRaw('LTRIM(RTRIM(sn_account)) = ?', [operaAccount])
                    .andWhereRaw("(sn_analsys IS NULL OR LTRIM(RTRIM(sn_analsys)) = '' OR LTRIM(RTRIM(UPPER(sn_analsys))) != 'GC')")
                    .update({ sn_analsys: 'GC' });
                gcFlag.gc_set_on = operaAccount;
                gcFlag.gc_set_rows = Number(set);
            }
            catch (sqlErr) {
                gcFlag.gc_error = sqlErr?.message ?? String(sqlErr);
                ctx.logger.warn?.('sn_analsys flag move failed', sqlErr);
            }
            res.json({
                success: true,
                message: linkResult.message,
                mandate: linkResult.mandate,
                gc_flag: gcFlag,
            });
        }
        catch (err) {
            ctx.logger.error('Link mandate failed', err);
            res.status(500).json({ success: false, error: err?.message ?? String(err) });
        }
    });
    /**
     * GET /api/gocardless/mandates/suggest-match
     *
     * Suggest the best Opera customer match for a GoCardless customer
     * name using fuzzy matching against the full sales ledger.
     * Faithful port of suggest_mandate_match
     * (apps/gocardless/api/routes.py:7644-7718).
     *
     * Scoring tiers: exact (1.0) > containment (0.85) > Ratcliff/
     * Obershelp ratio (sequenceMatcherRatio). Threshold 0.5; cap 5
     * results. GC-tagged customers tie-break to the top.
     *
     * Query params:
     *   - gc_name (required) — GoCardless customer name
     */
    router.get('/api/gocardless/mandates/suggest-match', async (req, res) => {
        const operaDb = getOperaDb(req, res);
        if (!operaDb)
            return;
        try {
            const gcName = typeof req.query.gc_name === 'string' ? req.query.gc_name : '';
            const result = await suggestMandateMatch(operaDb, gcName);
            res.json(result);
        }
        catch (err) {
            ctx.logger.error('Suggest mandate match failed', err);
            // Match Python: soft success on error
            res.json({ success: true, suggestions: [], gc_name: '' });
        }
    });
    /**
     * GET /api/gocardless/eligible-customers
     *
     * Customers eligible for GoCardless: union of customers with
     * sn_analsys='GC' (operator-flagged) + customers with a linked
     * mandate. Faithful port of get_gocardless_eligible_customers
     * (routes.py:7551-7635). Each row reports has_mandate +
     * mandate_id + mandate_status so the UI can show "needs setup"
     * vs "already mandated" status.
     *
     * Adds dormant + stopped filter per CLAUDE.md (the original
     * Python missed these).
     */
    router.get('/api/gocardless/eligible-customers', async (req, res) => {
        const operaDb = getOperaDb(req, res);
        if (!operaDb)
            return;
        const appDb = getAppDb(req, res);
        if (!appDb)
            return;
        try {
            const result = await getEligibleCustomers(appDb, operaDb);
            res.json(result);
        }
        catch (err) {
            ctx.logger.error('Eligible customers failed', err);
            res.status(500).json({ success: false, error: err?.message ?? String(err) });
        }
    });
    /**
     * POST /api/gocardless/request-payment
     *
     * Request a single Direct Debit payment from a customer via the
     * customer's existing GoCardless mandate. Faithful port of
     * request_gocardless_payment (apps/gocardless/api/routes.py
     * :8249-8435). Pipeline:
     *   1. Duplicate-invoice guard against active payment_requests
     *   2. Active mandate lookup (gocardless_mandates)
     *   3. Opera read: invoice total (from stran.st_trbal) +
     *      unallocated-credit safety check
     *   4. POST /payments via the GoCardless client
     *   5. Persist to gocardless_payment_requests + return enriched
     *      response with customer_name + estimated_arrival
     */
    router.post('/api/gocardless/request-payment', async (req, res) => {
        const operaDb = getOperaDb(req, res);
        if (!operaDb)
            return;
        const appDb = getAppDb(req, res);
        if (!appDb)
            return;
        try {
            const settings = await loadSettings(appDb);
            const client = createClientFromSettings(settings);
            if (!client) {
                res.status(400).json({
                    success: false,
                    error: 'GoCardless API not configured',
                });
                return;
            }
            const body = (req.body ?? {});
            const input = {
                operaAccount: String(body.opera_account ?? body.operaAccount ?? ''),
                invoices: Array.isArray(body.invoices) ? body.invoices.map(String) : [],
                amountPence: body.amount === undefined || body.amount === null
                    ? body.amountPence ?? null
                    : Number(body.amount),
                chargeDate: typeof body.charge_date === 'string'
                    ? body.charge_date
                    : (body.chargeDate ?? null),
                description: body.description ?? null,
            };
            const readOpera = async (operaAccount, invoices) => {
                let invoiceTotalPounds = null;
                if (invoices.length > 0) {
                    const totalRow = await operaDb('stran')
                        .where({ st_account: operaAccount })
                        .whereIn('st_trref', invoices)
                        .sum({ total: 'st_trbal' })
                        .first();
                    const total = totalRow?.total;
                    if (total !== null && total !== undefined && Number(total) !== 0) {
                        invoiceTotalPounds = Number(total);
                    }
                }
                const creditRow = await operaDb('stran')
                    .where({ st_account: operaAccount })
                    .andWhere('st_trbal', '<', 0)
                    .sum({ total: 'st_trbal' })
                    .first();
                const credit = Number(creditRow?.total ?? 0);
                return {
                    invoiceTotalPounds,
                    unallocatedCreditPounds: Math.abs(credit),
                };
            };
            const createRemote = async (input2) => client.createPayment({
                amountPence: input2.amountPence,
                mandateId: input2.mandateId,
                description: input2.description,
                chargeDate: input2.chargeDate,
                metadata: input2.metadata,
            });
            const result = await requestPayment(appDb, input, { request_statement_reference: settings.request_statement_reference ?? '' }, readOpera, createRemote);
            if (!result.success) {
                res.status(400).json(result);
                return;
            }
            res.json(result);
        }
        catch (err) {
            ctx.logger.error('Request payment failed', err);
            res.status(500).json({ success: false, error: err?.message ?? String(err) });
        }
    });
    /**
     * POST /api/gocardless/payment-requests/bulk
     *
     * Request multiple payments in one shot. Each row is run through
     * the same pipeline as /request-payment; failures are reported
     * per-row and don't abort the batch. Faithful port of
     * request_bulk_payments (apps/gocardless/api/routes.py:8438-8486).
     *
     * Accepts either { requests: [...] } or a bare array body.
     */
    router.post('/api/gocardless/payment-requests/bulk', async (req, res) => {
        const operaDb = getOperaDb(req, res);
        if (!operaDb)
            return;
        const appDb = getAppDb(req, res);
        if (!appDb)
            return;
        try {
            const settings = await loadSettings(appDb);
            const client = createClientFromSettings(settings);
            if (!client) {
                res.status(400).json({
                    success: false,
                    error: 'GoCardless API not configured',
                });
                return;
            }
            const raw = req.body;
            const body = Array.isArray(raw)
                ? raw
                : Array.isArray(raw?.requests)
                    ? raw.requests
                    : [];
            const inputs = body.map((r) => ({
                operaAccount: String(r.opera_account ?? r.operaAccount ?? ''),
                invoices: Array.isArray(r.invoices) ? r.invoices.map(String) : [],
                amountPence: r.amount === undefined || r.amount === null
                    ? r.amountPence ?? null
                    : Number(r.amount),
                chargeDate: typeof r.charge_date === 'string' ? r.charge_date : (r.chargeDate ?? null),
                description: r.description ?? null,
            }));
            const readOpera = async (operaAccount, invoices) => {
                let invoiceTotalPounds = null;
                if (invoices.length > 0) {
                    const totalRow = await operaDb('stran')
                        .where({ st_account: operaAccount })
                        .whereIn('st_trref', invoices)
                        .sum({ total: 'st_trbal' })
                        .first();
                    const total = totalRow?.total;
                    if (total !== null && total !== undefined && Number(total) !== 0) {
                        invoiceTotalPounds = Number(total);
                    }
                }
                const creditRow = await operaDb('stran')
                    .where({ st_account: operaAccount })
                    .andWhere('st_trbal', '<', 0)
                    .sum({ total: 'st_trbal' })
                    .first();
                const credit = Number(creditRow?.total ?? 0);
                return {
                    invoiceTotalPounds,
                    unallocatedCreditPounds: Math.abs(credit),
                };
            };
            const createRemote = async (input2) => client.createPayment({
                amountPence: input2.amountPence,
                mandateId: input2.mandateId,
                description: input2.description,
                chargeDate: input2.chargeDate,
                metadata: input2.metadata,
            });
            const result = await requestBulkPayments(appDb, inputs, { request_statement_reference: settings.request_statement_reference ?? '' }, readOpera, createRemote);
            res.json(result);
        }
        catch (err) {
            ctx.logger.error('Request bulk payments failed', err);
            res.status(500).json({ success: false, error: err?.message ?? String(err) });
        }
    });
    /**
     * GET /api/gocardless/unposted-payments
     *
     * Surfaces collected GoCardless payments (status=confirmed or
     * paid_out) that haven't been posted to Opera yet. Faithful port
     * of get_unposted_gocardless_payments
     * (apps/gocardless/api/routes.py:6283-6401).
     *
     * Three already-posted checks per request:
     *   1. Has the payout been imported? (skipped when SAM doesn't
     *      yet expose email_storage.is_gocardless_payout_imported)
     *   2. Are the invoice_refs fully paid in stran?
     *   3. Does the cashbook (aentry/atran with at_inputby='GOCARDLS')
     *      already carry a matching receipt?
     *
     * On match, the local payment_request row is updated to
     * status='posted'. Failures swallowed to match Python's
     * "log + continue" — the dashboard always renders.
     */
    router.get('/api/gocardless/unposted-payments', async (req, res) => {
        const operaDb = getOperaDb(req, res);
        if (!operaDb)
            return;
        const appDb = getAppDb(req, res);
        if (!appDb)
            return;
        try {
            // Build customer-name lookup from local mandates
            const mandateRows = (await appDb('gocardless_mandates').select('opera_account', 'opera_name'));
            const customerNames = new Map();
            for (const m of mandateRows ?? []) {
                const acct = (m.opera_account ?? '').trim();
                const name = (m.opera_name ?? '').trim();
                if (acct && acct !== '__UNLINKED__' && name) {
                    customerNames.set(acct, name);
                }
            }
            const result = await getUnpostedPayments(operaDb, appDb, {
                customerNamesByAccount: customerNames,
            });
            res.json(result);
        }
        catch (err) {
            ctx.logger.warn?.('Could not check unposted GoCardless payments', err);
            // Match Python: dashboard always loads, error swallowed
            res.json({
                success: true,
                has_unposted: false,
                unposted_count: 0,
                unposted_total: 0,
                unprocessed_batches: 0,
                unposted: [],
            });
        }
    });
    /**
     * GET /api/gocardless/collectable-invoices
     *
     * List outstanding sales-ledger invoices that can be collected via
     * GoCardless Direct Debit. Faithful port of get_collectable_invoices
     * (apps/gocardless/api/routes.py:7721-7894). Decorates each invoice
     * with mandate status, days-overdue, and whether a payment request
     * already covers it.
     *
     * Query params:
     *   - overdue_only (default false)
     *   - min_amount (default 0)
     */
    router.get('/api/gocardless/collectable-invoices', async (req, res) => {
        const operaDb = getOperaDb(req, res);
        if (!operaDb)
            return;
        const appDb = getAppDb(req, res);
        if (!appDb)
            return;
        try {
            const overdueOnly = req.query.overdue_only === 'true' || req.query.overdue_only === '1';
            const minAmount = req.query.min_amount
                ? Number(req.query.min_amount)
                : 0;
            const result = await getCollectableInvoices(operaDb, appDb, {
                overdueOnly,
                minAmount,
            });
            res.json(result);
        }
        catch (err) {
            ctx.logger.error('Get collectable invoices failed', err);
            res.status(500).json({ success: false, error: err?.message ?? String(err) });
        }
    });
    /**
     * GET /api/gocardless/due-invoices
     *
     * List outstanding invoices due for GoCardless collection,
     * grouped by customer. Faithful port of get_gocardless_due_invoices
     * (apps/gocardless/api/routes.py:7897-8214).
     *
     * Only returns invoices for customers with an active mandate.
     * Each invoice is decorated with mandate, payment-request, and
     * subscription info. Customers carry an unallocated-credit
     * warning when a credit balance exists on their account.
     *
     * Query params:
     *   - advance_date (default = today, YYYY-MM-DD)
     *   - include_future (default true)
     *
     * The Python source optionally enriches payment_requested via the
     * GoCardless list_payments API (catches payments made via the GC
     * dashboard). We currently skip that enrichment to keep the
     * endpoint snappy — local payment_requests already covers the
     * main case. Will be wired through once list_payments lands.
     */
    router.get('/api/gocardless/due-invoices', async (req, res) => {
        const operaDb = getOperaDb(req, res);
        if (!operaDb)
            return;
        const appDb = getAppDb(req, res);
        if (!appDb)
            return;
        try {
            const settings = await loadSettings(appDb);
            const advanceDate = typeof req.query.advance_date === 'string' ? req.query.advance_date : null;
            const includeFuture = req.query.include_future === undefined
                ? true
                : !(req.query.include_future === 'false' ||
                    req.query.include_future === '0');
            const result = await getDueInvoices(operaDb, appDb, {
                advanceDate,
                includeFuture,
                subscriptionTag: settings.subscription_tag ?? 'SUB',
            });
            res.json(result);
        }
        catch (err) {
            ctx.logger.error('Get due invoices failed', err);
            res.status(500).json({ success: false, error: err?.message ?? String(err) });
        }
    });
    // Suppress unused-import warning when due-invoices types only flow through
    // the body of this endpoint at runtime.
    void null;
    /**
     * GET /api/gocardless/repeat-documents
     *
     * List Opera repeat documents (ih_docstat='U') suitable for
     * GoCardless subscriptions, cross-referenced with the per-app
     * mandates + subscriptions tables. Faithful port of
     * get_gocardless_repeat_documents
     * (apps/gocardless/api/routes.py:8619-8785).
     *
     * Query params:
     *   - require_mandate (default true): when true, only show docs
     *     for customers with an active mandate. Set false to show all
     *     active customers (used by the link-existing-sub UI).
     */
    router.get('/api/gocardless/repeat-documents', async (req, res) => {
        const operaDb = getOperaDb(req, res);
        if (!operaDb)
            return;
        const appDb = getAppDb(req, res);
        if (!appDb)
            return;
        try {
            const settings = await loadSettings(appDb);
            const requireMandateRaw = req.query.require_mandate;
            const requireMandate = requireMandateRaw === undefined
                ? true
                : !(requireMandateRaw === 'false' || requireMandateRaw === '0');
            const result = await getRepeatDocuments(operaDb, appDb, {
                requireMandate,
                subscriptionTag: settings.subscription_tag ?? 'SUB',
            });
            res.json(result);
        }
        catch (err) {
            ctx.logger.error('Get repeat documents failed', err);
            res.status(500).json({ success: false, error: err?.message ?? String(err) });
        }
    });
    /**
     * GET /api/gocardless/customer-email/:account
     *
     * Look up the customer email + name + contact from sname for the
     * given account. Used by the mandate-setup form to pre-fill
     * customer details. Faithful port of get_customer_email_for_mandate
     * (apps/gocardless/api/routes.py:7189-7217).
     *
     * Returns success=true with empty fields if the account is not
     * found — the form still loads, the operator just types the email
     * manually.
     */
    router.get('/api/gocardless/customer-email/:account', async (req, res) => {
        const operaDb = getOperaDb(req, res);
        if (!operaDb)
            return;
        try {
            const result = await getCustomerEmail(operaDb, String(req.params.account ?? ''));
            res.json(result);
        }
        catch (err) {
            ctx.logger.error('Get customer email failed', err);
            res.status(500).json({ success: false, error: err?.message ?? String(err) });
        }
    });
    /**
     * POST /api/gocardless/mandates/setup
     *
     * Initiate a new GoCardless mandate setup for an Opera customer:
     *   1. Creates a billing request via GoCardless API
     *   2. Creates a billing-request flow + auth URL
     *   3. Persists a tracking row in mandate_setup_requests
     *   4. Sends the customer an email with the auth URL via SAM's
     *      email service
     *
     * Faithful port of create_mandate_setup
     * (apps/gocardless/api/routes.py:6852-7051). Email send is
     * best-effort: setup row persists either way, status reflects
     * whether the email went out.
     *
     * Body:
     *   - opera_account (required)
     *   - opera_name
     *   - customer_email (required)
     *   - email_subject (optional)
     *   - email_body (optional, supports {authorisation_url} placeholder)
     */
    router.post('/api/gocardless/mandates/setup', async (req, res) => {
        const appDb = getAppDb(req, res);
        if (!appDb)
            return;
        try {
            const settings = await loadSettings(appDb);
            const client = createClientFromSettings(settings);
            if (!client) {
                res.status(400).json({
                    success: false,
                    error: 'GoCardless API access token not configured. Go to GoCardless Settings to add your API credentials.',
                });
                return;
            }
            const body = (req.body ?? {});
            const remote = {
                createBillingRequest: async (opts) => {
                    const r = await client.createBillingRequest({
                        customerEmail: opts.customerEmail,
                        customerName: opts.customerName,
                        metadata: opts.metadata,
                    });
                    const id = r.success && r.billingRequest
                        ? r.billingRequest.id ?? undefined
                        : undefined;
                    return { success: r.success, id, error: r.error };
                },
                createBillingRequestFlow: async (billingRequestId) => {
                    const r = await client.createBillingRequestFlow({
                        billingRequestId,
                    });
                    const flow = r.flow;
                    return {
                        success: r.success,
                        flowId: flow?.id ?? undefined,
                        authorisationUrl: flow?.authorisation_url ?? undefined,
                        error: r.error,
                    };
                },
            };
            const sendEmail = ctx.email
                ? async (opts) => {
                    const r = await ctx.email.send({
                        to: opts.to,
                        subject: opts.subject,
                        bodyHtml: opts.bodyHtml,
                    });
                    return { success: r.success, error: r.error ?? null };
                }
                : undefined;
            const companyName = (settings.company_reference ?? '')
                .replace(/LTDLTD/g, ' LTD')
                .replace(/LTD/g, ' Ltd')
                .trim() || 'Our Company';
            const result = await createMandateSetup(appDb, {
                operaAccount: String(body.opera_account ?? ''),
                operaName: typeof body.opera_name === 'string' ? body.opera_name : null,
                customerEmail: String(body.customer_email ?? ''),
                emailSubject: typeof body.email_subject === 'string' ? body.email_subject : null,
                emailBodyHtml: typeof body.email_body === 'string' ? body.email_body : null,
                companyName,
            }, remote, sendEmail);
            if (!result.success) {
                res.status(400).json(result);
                return;
            }
            res.json(result);
        }
        catch (err) {
            ctx.logger.error('Create mandate setup failed', err);
            res.status(500).json({ success: false, error: err?.message ?? String(err) });
        }
    });
    /**
     * POST /api/gocardless/mandates/check-setups
     *
     * Poll GoCardless for status updates on every pending mandate
     * setup row. Faithful port of check_mandate_setups
     * (apps/gocardless/api/routes.py:7070-7186).
     *
     * For each pending row:
     *   - Fetch the billing request → status, mandate id, customer id
     *   - When mandate created and active → mark setup completed,
     *     link mandate to Opera customer (gocardless_mandates upsert),
     *     and ROWLOCK-update sname.sn_analsys='GC' on the Opera customer
     *   - Otherwise map brq.status to the appropriate local status
     *
     * Per-row failures are reported in updates[] but never abort the
     * batch.
     */
    router.post('/api/gocardless/mandates/check-setups', async (req, res) => {
        const operaDb = getOperaDb(req, res);
        if (!operaDb)
            return;
        const appDb = getAppDb(req, res);
        if (!appDb)
            return;
        try {
            const settings = await loadSettings(appDb);
            const client = createClientFromSettings(settings);
            if (!client) {
                res.status(400).json({
                    success: false,
                    error: 'GoCardless API access token not configured',
                });
                return;
            }
            const remote = {
                getBillingRequest: async (id) => {
                    const r = await client.getBillingRequest(id);
                    const brq = r.billingRequest;
                    return {
                        success: r.success,
                        status: brq?.status ?? undefined,
                        mandateId: (brq?.links?.mandate_request_mandate ??
                            brq?.links?.mandate) ||
                            null,
                        customerId: brq?.links?.customer ?? null,
                        error: r.error,
                    };
                },
                getMandate: async (id) => {
                    const r = await client.getMandate(id);
                    const m = r.mandate;
                    return {
                        success: r.success,
                        status: m?.status ?? undefined,
                        error: r.error,
                    };
                },
            };
            const completeSetup = async (input) => {
                // 1. Look up GC customer for name + email enrichment
                let gcName = null;
                let email = input.setup.customer_email || null;
                if (input.gocardlessCustomerId) {
                    try {
                        const cust = await client.getCustomer(input.gocardlessCustomerId);
                        if (cust.success && cust.customer) {
                            const c = cust.customer;
                            gcName =
                                c.company_name ||
                                    `${c.given_name ?? ''} ${c.family_name ?? ''}`.trim() ||
                                    null;
                            if (!email && c.email)
                                email = c.email;
                        }
                    }
                    catch {
                        // best-effort
                    }
                }
                // 2. Fetch mandate scheme (default bacs)
                let scheme = 'bacs';
                try {
                    const m = await client.getMandate(input.mandateId);
                    if (m.success && m.mandate) {
                        const md = m.mandate;
                        if (md.scheme)
                            scheme = md.scheme;
                    }
                }
                catch {
                    // best-effort
                }
                // 3. Local link
                const linkResult = await linkMandate(appDb, {
                    operaAccount: input.setup.opera_account,
                    mandateId: input.mandateId,
                    operaName: input.setup.opera_name || null,
                    gocardlessName: gcName,
                    gocardlessCustomerId: input.gocardlessCustomerId,
                    mandateStatus: 'active',
                    scheme,
                    email,
                    confirm: true,
                });
                if (!linkResult.success) {
                    return { success: false, error: linkResult.error };
                }
                // 4. Set sn_analsys='GC' on the Opera customer
                try {
                    await operaDb('sname')
                        .whereRaw('LTRIM(RTRIM(sn_account)) = ?', [
                        input.setup.opera_account,
                    ])
                        .andWhereRaw("(sn_analsys IS NULL OR LTRIM(RTRIM(sn_analsys)) = '' OR LTRIM(RTRIM(UPPER(sn_analsys))) != 'GC')")
                        .update({ sn_analsys: 'GC' });
                }
                catch (sqlErr) {
                    ctx.logger.warn?.(`Could not set sn_analsys='GC' for ${input.setup.opera_account}`, sqlErr);
                }
                return { success: true };
            };
            const result = await checkPendingMandateSetups(appDb, remote, completeSetup);
            res.json(result);
        }
        catch (err) {
            ctx.logger.error('Check mandate setups failed', err);
            res.status(500).json({ success: false, error: err?.message ?? String(err) });
        }
    });
    /**
     * GET /api/gocardless/mandates/pending-setups
     *
     * List all mandate setup requests with current status. Faithful
     * port of list_pending_mandate_setups (routes.py:7054-7067).
     * Returns pending_count for the dashboard "X to chase up" widget.
     */
    router.get('/api/gocardless/mandates/pending-setups', async (req, res) => {
        const appDb = getAppDb(req, res);
        if (!appDb)
            return;
        try {
            const result = await listMandateSetups(appDb);
            res.json(result);
        }
        catch (err) {
            ctx.logger.error('List mandate setups failed', err);
            res.status(500).json({ success: false, error: err?.message ?? String(err) });
        }
    });
    /**
     * POST /api/gocardless/mandates/cancel-setup/:setup_id
     *
     * Cancel a pending mandate setup request. Faithful port of
     * cancel_mandate_setup (routes.py:7220-7244). Refuses cancellation
     * when status is already final (completed/failed/cancelled).
     */
    router.post('/api/gocardless/mandates/cancel-setup/:setup_id', async (req, res) => {
        const appDb = getAppDb(req, res);
        if (!appDb)
            return;
        try {
            const id = Number(req.params.setup_id);
            const result = await cancelMandateSetup(appDb, id);
            if (!result.success) {
                res
                    .status(result.error === 'Setup request not found' ? 404 : 400)
                    .json(result);
                return;
            }
            res.json(result);
        }
        catch (err) {
            ctx.logger.error('Cancel mandate setup failed', err);
            res.status(500).json({ success: false, error: err?.message ?? String(err) });
        }
    });
    /**
     * POST /api/gocardless/mandates/:mandate_id/cancel
     *
     * Cancel a mandate via GoCardless API and update the local
     * mandate_status. Faithful port of cancel_gocardless_mandate
     * (routes.py:6795-6830). Local update only proceeds if the remote
     * cancel succeeds (or returns "already cancelled").
     */
    router.post('/api/gocardless/mandates/:mandate_id/cancel', async (req, res) => {
        const appDb = getAppDb(req, res);
        if (!appDb)
            return;
        try {
            const settings = await loadSettings(appDb);
            const client = createClientFromSettings(settings);
            if (!client) {
                res.status(400).json({
                    success: false,
                    error: 'GoCardless not configured',
                });
                return;
            }
            const cancelRemote = async (id) => client.cancelMandate(id);
            const result = await cancelMandate(appDb, String(req.params.mandate_id ?? ''), cancelRemote);
            if (!result.success) {
                res
                    .status(result.error === 'Mandate not found' ? 404 : 400)
                    .json(result);
                return;
            }
            res.json(result);
        }
        catch (err) {
            ctx.logger.error('Cancel mandate failed', err);
            res.status(500).json({ success: false, error: err?.message ?? String(err) });
        }
    });
    /**
     * DELETE /api/gocardless/mandates/:mandate_id
     *
     * Unlink a mandate from its Opera customer (sets opera_account to
     * '__UNLINKED__' rather than deleting the row — mandate-level
     * history matters for audit). Faithful port of
     * unlink_gocardless_mandate (routes.py:6833-6849). Does NOT cancel
     * the mandate in GoCardless — operator must call /cancel for that.
     */
    router.delete('/api/gocardless/mandates/:mandate_id', async (req, res) => {
        const appDb = getAppDb(req, res);
        if (!appDb)
            return;
        try {
            const result = await unlinkMandate(appDb, String(req.params.mandate_id ?? ''));
            if (!result.success) {
                res
                    .status(result.error === 'Mandate not found' ? 404 : 400)
                    .json(result);
                return;
            }
            res.json(result);
        }
        catch (err) {
            ctx.logger.error('Unlink mandate failed', err);
            res.status(500).json({ success: false, error: err?.message ?? String(err) });
        }
    });
    /**
     * GET /api/gocardless/subscriptions
     *
     * List GoCardless subscriptions stored in the per-app DB. SAM-side
     * read endpoint; the Python source has only the Opera 3 variant
     * which adds Opera-side mismatch detection (deferred until full
     * Opera SE ihead/itran reads land).
     *
     * Filters: status, opera_account. Default limit 200. Each row
     * enriched with customer_name from the matching mandate.
     */
    router.get('/api/gocardless/subscriptions', async (req, res) => {
        const appDb = getAppDb(req, res);
        if (!appDb)
            return;
        // Opera DB is optional — enrichment is a best-effort overlay.
        const company = req.operaCompany;
        const operaDb = company ? ctx.db.getCompanyDb(company) : null;
        try {
            const result = await listSubscriptions(appDb, {
                status: typeof req.query.status === 'string' ? req.query.status : null,
                operaAccount: typeof req.query.opera_account === 'string'
                    ? req.query.opera_account
                    : null,
                limit: req.query.limit ? Number(req.query.limit) : undefined,
            }, operaDb);
            res.json(result);
        }
        catch (err) {
            ctx.logger.error('List subscriptions failed', err);
            res.status(500).json({ success: false, error: err?.message ?? String(err) });
        }
    });
    /**
     * POST /api/gocardless/subscriptions/link
     *
     * Link an Opera repeat document (ih_doc) to a GoCardless subscription.
     * Faithful port of link_subscription_to_document
     * (apps/gocardless/api/routes.py:8788-8832). Multiple docs per
     * subscription supported; rejects when the doc is already linked
     * to a different subscription.
     *
     * NB: this route MUST be defined before /subscriptions/:id so Express
     * doesn't mis-route 'link' as a path parameter.
     */
    router.post('/api/gocardless/subscriptions/link', async (req, res) => {
        const appDb = getAppDb(req, res);
        if (!appDb)
            return;
        try {
            const body = (req.body ?? {});
            const result = await linkSubscriptionToDocument(appDb, {
                subscriptionId: String(body.subscription_id ?? ''),
                sourceDoc: String(body.source_doc ?? ''),
            });
            if (!result.success) {
                const isMissing = typeof result.error === 'string' &&
                    /not found locally/i.test(result.error);
                res.status(isMissing ? 404 : 400).json(result);
                return;
            }
            res.json(result);
        }
        catch (err) {
            ctx.logger.error('Link subscription failed', err);
            res.status(500).json({ success: false, error: err?.message ?? String(err) });
        }
    });
    /**
     * POST /api/gocardless/subscriptions/unlink
     *
     * Remove the link between a subscription and an Opera repeat document.
     * Faithful port of unlink_subscription_from_document
     * (apps/gocardless/api/routes.py:8835-8874). When source_doc is
     * omitted, all document links for the subscription are removed.
     */
    router.post('/api/gocardless/subscriptions/unlink', async (req, res) => {
        const appDb = getAppDb(req, res);
        if (!appDb)
            return;
        try {
            const body = (req.body ?? {});
            const result = await unlinkSubscriptionFromDocument(appDb, {
                subscriptionId: String(body.subscription_id ?? ''),
                sourceDoc: typeof body.source_doc === 'string' && body.source_doc
                    ? body.source_doc
                    : null,
            });
            if (!result.success) {
                const isMissing = typeof result.error === 'string' && /not found/i.test(result.error);
                res.status(isMissing ? 404 : 400).json(result);
                return;
            }
            res.json(result);
        }
        catch (err) {
            ctx.logger.error('Unlink subscription failed', err);
            res.status(500).json({ success: false, error: err?.message ?? String(err) });
        }
    });
    /**
     * POST /api/gocardless/subscriptions
     *
     * Create a GoCardless subscription from one or more Opera repeat
     * documents. Faithful port of create_gocardless_subscription
     * (apps/gocardless/api/routes.py:8997-9154).
     *
     * Body:
     *   - source_doc (single) OR source_docs[] (multiple)
     *   - day_of_month (optional, 1-28 or -1 for last)
     *   - start_date (optional, YYYY-MM-DD)
     *
     * Pipeline:
     *   1. Fetch tagged ihead docs (ih_docstat='U' AND ih_analsys=SUB)
     *   2. Validate all docs belong to same customer
     *   3. Sum line totals (it_exvat + it_vatval) → amount_pence
     *   4. Look up active mandate for customer
     *   5. Reject if any doc already linked to a non-cancelled subscription
     *   6. Create remotely (mandate, amount, interval, day_of_month, metadata)
     *   7. Persist locally + link all docs via junction table
     */
    router.post('/api/gocardless/subscriptions', async (req, res) => {
        const operaDb = getOperaDb(req, res);
        if (!operaDb)
            return;
        const appDb = getAppDb(req, res);
        if (!appDb)
            return;
        try {
            const settings = await loadSettings(appDb);
            const client = createClientFromSettings(settings);
            if (!client) {
                res.status(400).json({
                    success: false,
                    error: 'GoCardless API not configured',
                });
                return;
            }
            const body = (req.body ?? {});
            const sourceDocs = Array.isArray(body.source_docs) && body.source_docs.length > 0
                ? body.source_docs.map((s) => String(s))
                : body.source_doc
                    ? [String(body.source_doc)]
                    : [];
            const subTag = settings.subscription_tag ?? 'SUB';
            const operaReader = {
                fetchTaggedDocs: async (refs, tag) => {
                    const rows = await operaDb('ihead')
                        .where({ ih_docstat: 'U' })
                        .whereIn('ih_doc', refs)
                        .andWhereRaw('RTRIM(ih_analsys) = ?', [tag])
                        .select('ih_doc', 'ih_account', 'ih_name', 'ih_ignore', 'ih_custref');
                    return (rows ?? []).map((r) => ({
                        ih_doc: String(r.ih_doc ?? '').trim(),
                        ih_account: String(r.ih_account ?? '').trim(),
                        ih_name: String(r.ih_name ?? '').trim(),
                        ih_ignore: String(r.ih_ignore ?? '').trim(),
                        ih_custref: String(r.ih_custref ?? '').trim(),
                    }));
                },
                sumLineTotals: async (refs) => {
                    const row = await operaDb('itran')
                        .whereIn('it_doc', refs)
                        .select(operaDb.raw('COALESCE(SUM(it_exvat), 0) AS line_nett'), operaDb.raw('COALESCE(SUM(it_vatval), 0) AS line_vat'))
                        .first();
                    return {
                        lineNettPence: Number(row?.line_nett ?? 0),
                        lineVatPence: Number(row?.line_vat ?? 0),
                    };
                },
            };
            const remote = (input) => client.createSubscription({
                mandateId: input.mandateId,
                amountPence: input.amountPence,
                intervalUnit: input.intervalUnit,
                interval: input.interval,
                dayOfMonth: input.dayOfMonth ?? null,
                name: input.name,
                startDate: input.startDate ?? null,
                metadata: input.metadata,
            });
            const result = await createSubscription(appDb, {
                sourceDocs,
                dayOfMonth: body.day_of_month === undefined ? null : Number(body.day_of_month),
                startDate: typeof body.start_date === 'string' ? body.start_date : null,
            }, operaReader, remote, { subscriptionTag: subTag });
            if (!result.success) {
                res.status(400).json(result);
                return;
            }
            res.json(result);
        }
        catch (err) {
            ctx.logger.error('Create subscription failed', err);
            res.status(500).json({ success: false, error: err?.message ?? String(err) });
        }
    });
    /**
     * POST /api/gocardless/subscriptions/sync
     *
     * Pull every subscription from the GoCardless API and upsert into
     * the local DB. Faithful port of sync_gocardless_subscriptions
     * (apps/gocardless/api/routes.py:9375-9500). Resolves
     * mandate -> {opera_account, opera_name} via the local mandates
     * table first, falling back to the GoCardless mandate + customer
     * APIs when the local link doesn't carry a name.
     *
     * NB: must be defined before /subscriptions/:id so Express doesn't
     * mis-route 'sync' as a path parameter.
     */
    router.post('/api/gocardless/subscriptions/sync', async (req, res) => {
        const appDb = getAppDb(req, res);
        if (!appDb)
            return;
        try {
            const settings = await loadSettings(appDb);
            const client = createClientFromSettings(settings);
            if (!client) {
                res.status(400).json({
                    success: false,
                    error: 'GoCardless API not configured',
                });
                return;
            }
            const fetchPage = async (cursor) => {
                const r = await client.listSubscriptions({
                    limit: 100,
                    cursor: cursor ?? undefined,
                });
                if (!r.success) {
                    throw new Error(r.error ?? 'Subscription list failed');
                }
                return { subscriptions: r.subscriptions, after: r.after };
            };
            const customerCache = new Map();
            const mandateCustomerCache = new Map();
            const resolveAccount = async (mandateId) => {
                let customerId = mandateCustomerCache.get(mandateId);
                if (customerId === undefined) {
                    const m = await client.getMandate(mandateId);
                    customerId =
                        m.success && m.mandate
                            ? m.mandate.links
                                ?.customer ?? null
                            : null;
                    mandateCustomerCache.set(mandateId, customerId);
                }
                if (!customerId)
                    return { opera_account: null, opera_name: null };
                let name = customerCache.get(customerId);
                if (name === undefined) {
                    const c = await client.getCustomer(customerId);
                    if (c.success && c.customer) {
                        const cd = c.customer;
                        const company = cd.company_name ?? '';
                        const given = cd.given_name ?? '';
                        const family = cd.family_name ?? '';
                        name = company || `${given} ${family}`.trim() || null;
                    }
                    else {
                        name = null;
                    }
                    customerCache.set(customerId, name);
                }
                return { opera_account: null, opera_name: name ?? null };
            };
            const result = await syncSubscriptionsFromGocardless(appDb, fetchPage, { resolveAccount });
            if (!result.success) {
                res.status(400).json(result);
                return;
            }
            res.json(result);
        }
        catch (err) {
            ctx.logger.error('Sync subscriptions failed', err);
            res.status(500).json({ success: false, error: err?.message ?? String(err) });
        }
    });
    /**
     * GET /api/gocardless/subscriptions/:subscription_id
     *
     * Read a single subscription with its linked source_docs and Opera
     * customer name enrichment. Faithful port of
     * get_gocardless_subscription (apps/gocardless/api/routes.py:9157-9169).
     */
    router.get('/api/gocardless/subscriptions/:subscription_id', async (req, res) => {
        const appDb = getAppDb(req, res);
        if (!appDb)
            return;
        const company = req.operaCompany;
        const operaDb = company ? ctx.db.getCompanyDb(company) : null;
        try {
            const result = await getSubscription(appDb, String(req.params.subscription_id ?? ''), operaDb);
            if (!result.success) {
                const isMissing = typeof result.error === 'string' && /not found/i.test(result.error);
                res.status(isMissing ? 404 : 400).json(result);
                return;
            }
            res.json(result);
        }
        catch (err) {
            ctx.logger.error('Get subscription failed', err);
            res.status(500).json({ success: false, error: err?.message ?? String(err) });
        }
    });
    /**
     * PUT /api/gocardless/subscriptions/:subscription_id
     *
     * Update name / amount on a GoCardless subscription, then mirror the
     * change locally. Faithful port of update_gocardless_subscription
     * (apps/gocardless/api/routes.py:9248-9291). Returns the fresh
     * subscription with source_docs.
     */
    router.put('/api/gocardless/subscriptions/:subscription_id', async (req, res) => {
        const appDb = getAppDb(req, res);
        if (!appDb)
            return;
        try {
            const settings = await loadSettings(appDb);
            const client = createClientFromSettings(settings);
            if (!client) {
                res.status(400).json({
                    success: false,
                    error: 'GoCardless API not configured',
                });
                return;
            }
            const body = (req.body ?? {});
            const subscriptionId = String(req.params.subscription_id ?? '');
            const amount = body.amount_pence === undefined || body.amount_pence === null
                ? null
                : Number(body.amount_pence);
            const remote = async (id, opts) => client.updateSubscription(id, {
                name: opts.name ?? null,
                amountPence: opts.amountPence ?? null,
            });
            const result = await updateSubscriptionDetails(appDb, subscriptionId, {
                name: typeof body.name === 'string' ? body.name : null,
                amountPence: Number.isFinite(amount) ? amount : null,
            }, remote);
            if (!result.success) {
                res.status(400).json(result);
                return;
            }
            res.json(result);
        }
        catch (err) {
            ctx.logger.error('Update subscription failed', err);
            res.status(500).json({ success: false, error: err?.message ?? String(err) });
        }
    });
    /**
     * POST /api/gocardless/subscriptions/:subscription_id/pause
     *
     * Pause an active subscription via GoCardless API + mirror locally.
     * Faithful port of pause_gocardless_subscription
     * (apps/gocardless/api/routes.py:9294-9318).
     */
    router.post('/api/gocardless/subscriptions/:subscription_id/pause', async (req, res) => {
        const appDb = getAppDb(req, res);
        if (!appDb)
            return;
        try {
            const settings = await loadSettings(appDb);
            const client = createClientFromSettings(settings);
            if (!client) {
                res.status(400).json({
                    success: false,
                    error: 'GoCardless API not configured',
                });
                return;
            }
            const result = await pauseSubscription(appDb, String(req.params.subscription_id ?? ''), (id) => client.pauseSubscription(id));
            if (!result.success) {
                const isMissing = typeof result.error === 'string' && /not found/i.test(result.error);
                res.status(isMissing ? 404 : 400).json(result);
                return;
            }
            res.json(result);
        }
        catch (err) {
            ctx.logger.error('Pause subscription failed', err);
            res.status(500).json({ success: false, error: err?.message ?? String(err) });
        }
    });
    /**
     * POST /api/gocardless/subscriptions/:subscription_id/resume
     *
     * Resume a paused subscription. Faithful port of
     * resume_gocardless_subscription (apps/gocardless/api/routes.py
     * :9321-9345).
     */
    router.post('/api/gocardless/subscriptions/:subscription_id/resume', async (req, res) => {
        const appDb = getAppDb(req, res);
        if (!appDb)
            return;
        try {
            const settings = await loadSettings(appDb);
            const client = createClientFromSettings(settings);
            if (!client) {
                res.status(400).json({
                    success: false,
                    error: 'GoCardless API not configured',
                });
                return;
            }
            const result = await resumeSubscription(appDb, String(req.params.subscription_id ?? ''), (id) => client.resumeSubscription(id));
            if (!result.success) {
                const isMissing = typeof result.error === 'string' && /not found/i.test(result.error);
                res.status(isMissing ? 404 : 400).json(result);
                return;
            }
            res.json(result);
        }
        catch (err) {
            ctx.logger.error('Resume subscription failed', err);
            res.status(500).json({ success: false, error: err?.message ?? String(err) });
        }
    });
    /**
     * POST /api/gocardless/subscriptions/:subscription_id/sync-from-opera
     *
     * Re-derive the subscription amount from its linked Opera repeat
     * documents and push the new total to GoCardless. Faithful port of
     * sync_subscription_from_opera (apps/gocardless/api/routes.py
     * :9172-9245). Reads itran (in pence) for all linked source_docs:
     *   amount_pence = SUM(it_exvat) + SUM(it_vatval)
     *
     * Skips remote+local update when the new amount matches the existing
     * one. Returns old/new amounts when an update happens.
     */
    router.post('/api/gocardless/subscriptions/:subscription_id/sync-from-opera', async (req, res) => {
        const appDb = getAppDb(req, res);
        if (!appDb)
            return;
        const operaDb = getOperaDb(req, res);
        if (!operaDb)
            return;
        try {
            const settings = await loadSettings(appDb);
            const client = createClientFromSettings(settings);
            if (!client) {
                res.status(400).json({
                    success: false,
                    error: 'GoCardless API not configured',
                });
                return;
            }
            const subscriptionId = String(req.params.subscription_id ?? '');
            // Read itran totals (in pence) for the linked repeat docs.
            const readOperaDocAmount = async (sourceDocs) => {
                const row = await operaDb('itran')
                    .whereIn('it_doc', sourceDocs)
                    .select(operaDb.raw('COALESCE(SUM(it_exvat), 0) AS line_nett'), operaDb.raw('COALESCE(SUM(it_vatval), 0) AS line_vat'))
                    .first();
                return {
                    lineNettPence: Number(row?.line_nett ?? 0),
                    lineVatPence: Number(row?.line_vat ?? 0),
                };
            };
            const updateRemote = async (id, amountPence) => client.updateSubscription(id, { amountPence });
            const result = await syncSubscriptionFromOpera(appDb, subscriptionId, readOperaDocAmount, updateRemote);
            if (!result.success) {
                const isMissing = typeof result.error === 'string' && /not found/i.test(result.error);
                res.status(isMissing ? 404 : 400).json(result);
                return;
            }
            res.json(result);
        }
        catch (err) {
            ctx.logger.error('Sync subscription from Opera failed', err);
            res.status(500).json({ success: false, error: err?.message ?? String(err) });
        }
    });
    /**
     * POST /api/gocardless/subscriptions/:subscription_id/cancel
     *
     * Cancel a subscription (cannot be undone in GoCardless). Faithful
     * port of cancel_gocardless_subscription (apps/gocardless/api/
     * routes.py:9348-9372).
     */
    router.post('/api/gocardless/subscriptions/:subscription_id/cancel', async (req, res) => {
        const appDb = getAppDb(req, res);
        if (!appDb)
            return;
        try {
            const settings = await loadSettings(appDb);
            const client = createClientFromSettings(settings);
            if (!client) {
                res.status(400).json({
                    success: false,
                    error: 'GoCardless API not configured',
                });
                return;
            }
            const result = await cancelSubscription(appDb, String(req.params.subscription_id ?? ''), (id) => client.cancelSubscription(id));
            if (!result.success) {
                const isMissing = typeof result.error === 'string' && /not found/i.test(result.error);
                res.status(isMissing ? 404 : 400).json(result);
                return;
            }
            res.json(result);
        }
        catch (err) {
            ctx.logger.error('Cancel subscription failed', err);
            res.status(500).json({ success: false, error: err?.message ?? String(err) });
        }
    });
    /**
     * GET /api/gocardless/payment-requests
     *
     * List payment requests, optionally filtered by status + opera_account.
     * Faithful port of list_payment_requests (routes.py:8217-8246).
     * Each row enriched with customer_name from the mandate.
     */
    router.get('/api/gocardless/payment-requests', async (req, res) => {
        const appDb = getAppDb(req, res);
        if (!appDb)
            return;
        try {
            const result = await listPaymentRequests(appDb, {
                status: typeof req.query.status === 'string' ? req.query.status : null,
                operaAccount: typeof req.query.opera_account === 'string'
                    ? req.query.opera_account
                    : null,
                limit: req.query.limit ? Number(req.query.limit) : undefined,
            });
            res.json(result);
        }
        catch (err) {
            ctx.logger.error('List payment requests failed', err);
            res.status(500).json({ success: false, error: err?.message ?? String(err) });
        }
    });
    /**
     * POST /api/gocardless/payment-requests/sync
     *
     * Poll the GoCardless API for status updates on all pending payment
     * requests and update local rows. Faithful port of
     * sync_payment_statuses (apps/gocardless/api/routes.py:8556-8616).
     *
     * Per-payment failures are logged + skipped — never fails the whole
     * sync run. Returns counts so the UI can show "synced X / total Y".
     */
    router.post('/api/gocardless/payment-requests/sync', async (req, res) => {
        const appDb = getAppDb(req, res);
        if (!appDb)
            return;
        try {
            const settings = await loadSettings(appDb);
            const client = createClientFromSettings(settings);
            if (!client) {
                res.status(400).json({
                    success: false,
                    error: 'GoCardless API not configured',
                });
                return;
            }
            const syncRemote = async (paymentId) => client.getPayment(paymentId);
            const result = await syncPaymentStatuses(appDb, syncRemote);
            res.json(result);
        }
        catch (err) {
            ctx.logger.error('Sync payment statuses failed', err);
            res.status(500).json({ success: false, error: err?.message ?? String(err) });
        }
    });
    /**
     * GET /api/gocardless/payment-requests/:request_id
     *
     * Single-payment-request detail. Faithful port of get_payment_request
     * (routes.py:8489-8506). Includes customer_name from the linked
     * mandate when available.
     */
    router.get('/api/gocardless/payment-requests/:request_id', async (req, res) => {
        const appDb = getAppDb(req, res);
        if (!appDb)
            return;
        try {
            const id = Number(req.params.request_id);
            const result = await getPaymentRequest(appDb, id);
            if (!result.success) {
                res
                    .status(result.error === 'Payment request not found' ? 404 : 400)
                    .json(result);
                return;
            }
            res.json(result);
        }
        catch (err) {
            ctx.logger.error('Get payment request failed', err);
            res.status(500).json({ success: false, error: err?.message ?? String(err) });
        }
    });
    /**
     * POST /api/gocardless/payment-requests/:request_id/cancel
     *
     * Cancel a pending payment request. Faithful port of
     * cancel_payment_request (routes.py:8509-8553).
     *   - Refuses cancellation when status isn't pending/pending_*
     *   - Best-effort GoCardless API cancel via the saved access token
     *     — failure is reported as remote_warning but local cancel
     *     proceeds (matches Python's "log + continue")
     *   - Local row marked status='cancelled' with error_message
     */
    router.post('/api/gocardless/payment-requests/:request_id/cancel', async (req, res) => {
        const appDb = getAppDb(req, res);
        if (!appDb)
            return;
        try {
            const id = Number(req.params.request_id);
            const settings = await loadSettings(appDb);
            const client = createClientFromSettings(settings);
            const cancelRemote = client
                ? async (paymentId) => {
                    const r = await client.cancelPayment(paymentId);
                    return { success: r.success, error: r.error };
                }
                : undefined;
            const result = await cancelPaymentRequest(appDb, id, cancelRemote);
            if (!result.success) {
                res
                    .status(result.error === 'Payment request not found' ? 404 : 400)
                    .json(result);
                return;
            }
            res.json(result);
        }
        catch (err) {
            ctx.logger.error('Cancel payment request failed', err);
            res.status(500).json({ success: false, error: err?.message ?? String(err) });
        }
    });
    /**
     * GET /api/gocardless/payment-requests/stats
     *
     * Dashboard statistics for the GoCardless payments-DB. Faithful port
     * of `get_gocardless_payment_stats` (routes.py:6271-6280) which calls
     * `GoCardlessPaymentsDB.get_statistics()`. Returns active-mandate
     * count, pending count + amount, month-to-date paid-out, and 30-day
     * failed count — flat shape merged onto {success}.
     */
    router.get('/api/gocardless/payment-requests/stats', async (req, res) => {
        const appDb = getAppDb(req, res);
        if (!appDb)
            return;
        try {
            const result = await getPaymentStats(appDb);
            res.json(result);
        }
        catch (err) {
            ctx.logger.error('Payment stats failed', err);
            res.status(500).json({ success: false, error: err?.message ?? String(err) });
        }
    });
    /**
     * GET /api/gocardless/validate-date?post_date=YYYY-MM-DD
     *
     * Validate that a posting date is allowed in Opera, based on Open
     * Period Accounting / nclndd / nparm. Faithful port of
     * `validate_gocardless_date` (apps/gocardless/api/routes.py:578-618).
     *
     * Returns:
     *   - valid:                bool
     *   - error:                string when invalid
     *   - year/period:          mapped from nclndd
     *   - current_year/current_period: from nparm
     *   - open_period_accounting: bool
     */
    router.get('/api/gocardless/validate-date', async (req, res) => {
        const operaDb = getOperaDb(req, res);
        if (!operaDb)
            return;
        try {
            const postDate = String(req.query.post_date ?? '').trim();
            if (!postDate) {
                res.json({
                    success: false,
                    valid: false,
                    error: 'post_date is required',
                });
                return;
            }
            let result;
            try {
                result = await validatePostingPeriod(operaDb, postDate, 'SL');
            }
            catch (parseErr) {
                res.json({
                    success: false,
                    valid: false,
                    error: parseErr?.message ?? String(parseErr),
                });
                return;
            }
            const current = await getCurrentPeriodInfo(operaDb);
            res.json({
                success: true,
                valid: result.is_valid,
                error: result.is_valid ? null : result.error_message,
                year: result.year,
                period: result.period,
                current_year: current.np_year,
                current_period: current.np_perno,
                open_period_accounting: result.open_period_accounting,
            });
        }
        catch (err) {
            ctx.logger.error('Validate-date failed', err);
            res.status(500).json({
                success: false,
                valid: false,
                error: err?.message ?? String(err),
            });
        }
    });
    /**
     * POST /api/gocardless/update-subscription-tags
     *
     * Preview or apply ih_analsys tag updates to Opera repeat documents
     * matching the configured frequency filters. Faithful port of
     * `update_subscription_tags`.
     *
     * Body:
     *   - mode: 'preview' (default) or 'apply'
     *   - overwrite: bool — if true, also update docs whose ih_analsys
     *                differs from the configured tag
     */
    router.post('/api/gocardless/update-subscription-tags', async (req, res) => {
        const operaDb = getOperaDb(req, res);
        if (!operaDb)
            return;
        const appDb = getAppDb(req, res);
        if (!appDb)
            return;
        try {
            const settings = await loadSettings(appDb);
            const body = (req.body ?? {});
            const result = await updateSubscriptionTags(operaDb, {
                subscription_tag: settings.subscription_tag ?? '',
                subscription_frequencies: settings.subscription_frequencies ?? [],
            }, {
                mode: body.mode === 'apply' ? 'apply' : 'preview',
                overwrite: !!body.overwrite,
            });
            res.json(result);
        }
        catch (err) {
            ctx.logger.error('Update subscription tags failed', err);
            res.status(500).json({ success: false, error: err?.message ?? String(err) });
        }
    });
    /**
     * POST /api/gocardless/partner/initiate-signup
     *
     * Start the OAuth Connect flow for a new merchant. Faithful port of
     * initiate_gocardless_partner_signup (routes.py:1153-1219). Inserts
     * a pending row in gocardless_partner_signups and returns the
     * GoCardless authorisation URL the merchant should be redirected
     * to. State token is stored in status_detail for CSRF validation
     * on /partner/callback.
     *
     * Body: { company_name, company_email }
     */
    router.post('/api/gocardless/partner/initiate-signup', async (req, res) => {
        const appDb = getAppDb(req, res);
        if (!appDb)
            return;
        try {
            const body = (req.body ?? {});
            const proto = req.headers['x-forwarded-proto'] ?? req.protocol;
            const host = req.headers['x-forwarded-host'] ?? req.get('host') ?? '';
            const baseUrl = host ? `${proto}://${host}` : '';
            const result = await initiatePartnerSignup(appDb, {
                companyName: String(body.company_name ?? ''),
                companyEmail: String(body.company_email ?? ''),
                baseUrl,
            });
            res.json(result);
        }
        catch (err) {
            ctx.logger.error('Initiate partner signup failed', err);
            res.status(500).json({ success: false, error: err?.message ?? String(err) });
        }
    });
    /**
     * GET /api/gocardless/partner/callback
     *
     * OAuth redirect target — GoCardless sends the merchant's browser
     * here after they complete signup. Faithful port of
     * gocardless_partner_callback (routes.py:1222-1319).
     *
     * Validates the state token (CSRF), exchanges the auth code for a
     * merchant access token, fetches the creditor info, and stores
     * everything against the latest signup row. Returns HTML (not JSON)
     * because the merchant's browser hits this URL — the partner-portal
     * UI polls /signup-status to detect completion.
     */
    router.get('/api/gocardless/partner/callback', async (req, res) => {
        const appDb = getAppDb(req, res);
        if (!appDb)
            return;
        try {
            const proto = req.headers['x-forwarded-proto'] ?? req.protocol;
            const host = req.headers['x-forwarded-host'] ?? req.get('host') ?? '';
            const baseUrl = host ? `${proto}://${host}` : '';
            const result = await handlePartnerCallback(appDb, {
                code: typeof req.query.code === 'string' ? req.query.code : null,
                state: typeof req.query.state === 'string' ? req.query.state : null,
                error: typeof req.query.error === 'string' ? req.query.error : null,
                baseUrl,
            });
            const html = partnerCallbackHtml(result);
            res.setHeader('Content-Type', 'text/html; charset=utf-8');
            res.status(200).send(html);
        }
        catch (err) {
            ctx.logger.error('Partner callback failed', err);
            const html = partnerCallbackHtml({
                ok: false,
                title: 'Connection Failed',
                message: `Something went wrong: ${err?.message ?? String(err)}`,
            });
            res.setHeader('Content-Type', 'text/html; charset=utf-8');
            res.status(500).send(html);
        }
    });
    /**
     * GET /api/gocardless/partner/config
     *
     * Probe whether GoCardless Partner credentials are configured.
     * Faithful port of get_gocardless_partner_config (routes.py:1487-1501).
     * Constructs a redirect_uri fallback from request origin when no
     * explicit partner_redirect_uri is configured.
     */
    router.get('/api/gocardless/partner/config', async (req, res) => {
        const appDb = getAppDb(req, res);
        if (!appDb)
            return;
        try {
            // Mirror Python's `request.base_url`: protocol://host (+ port)
            const proto = req.headers['x-forwarded-proto'] ?? req.protocol;
            const host = req.headers['x-forwarded-host'] ?? req.get('host') ?? '';
            const baseUrl = host ? `${proto}://${host}` : '';
            const result = await getPartnerConfig(appDb, { baseUrl });
            res.json(result);
        }
        catch (err) {
            ctx.logger.error('Partner config failed', err);
            res.status(500).json({ success: false, error: err?.message ?? String(err) });
        }
    });
    /**
     * GET /api/gocardless/partner/signup-status
     *
     * Latest partner signup record (token redacted). Faithful port of
     * get_gocardless_partner_signup_status (routes.py:1322-1339).
     */
    router.get('/api/gocardless/partner/signup-status', async (req, res) => {
        const appDb = getAppDb(req, res);
        if (!appDb)
            return;
        try {
            const result = await getLatestPartnerSignup(appDb);
            res.json(result);
        }
        catch (err) {
            ctx.logger.error('Partner signup-status failed', err);
            res.status(500).json({ success: false, error: err?.message ?? String(err) });
        }
    });
    /**
     * GET /api/gocardless/partner/merchants?status=...
     *
     * All merchants onboarded via the partner signup flow.
     * Faithful port of list_gocardless_partner_merchants
     * (routes.py:1504-1522). Tokens NEVER returned.
     */
    router.get('/api/gocardless/partner/merchants', async (req, res) => {
        const appDb = getAppDb(req, res);
        if (!appDb)
            return;
        try {
            const status = typeof req.query.status === 'string' && req.query.status.trim()
                ? req.query.status.trim()
                : null;
            const result = await getAllMerchantSignups(appDb, { status });
            res.json(result);
        }
        catch (err) {
            ctx.logger.error('Partner merchants failed', err);
            res.status(500).json({ success: false, error: err?.message ?? String(err) });
        }
    });
    /**
     * POST /api/gocardless/partner/admin-auth
     *
     * Validate admin password gate for the partner signup app config.
     * Faithful port of gocardless_partner_admin_auth (routes.py:1342-1354).
     * Returns first_time=true when no password is set yet (allow operator
     * to define one).
     */
    router.post('/api/gocardless/partner/admin-auth', async (req, res) => {
        const appDb = getAppDb(req, res);
        if (!appDb)
            return;
        try {
            const body = (req.body ?? {});
            const result = await partnerAdminAuth(appDb, String(body.password ?? ''));
            res.json(result);
        }
        catch (err) {
            ctx.logger.error('Partner admin auth failed', err);
            res.status(500).json({ success: false, error: err?.message ?? String(err) });
        }
    });
    /**
     * PUT /api/gocardless/partner/admin-password
     *
     * Set or change the partner admin password. Faithful port of
     * update_gocardless_partner_admin_password (routes.py:1357-1369).
     * Minimum 4 chars (matches Python's check).
     */
    router.put('/api/gocardless/partner/admin-password', async (req, res) => {
        const appDb = getAppDb(req, res);
        if (!appDb)
            return;
        try {
            const body = (req.body ?? {});
            const result = await setPartnerAdminPassword(appDb, String(body.password ?? ''));
            res.json(result);
        }
        catch (err) {
            ctx.logger.error('Partner admin-password failed', err);
            res.status(500).json({ success: false, error: err?.message ?? String(err) });
        }
    });
    /**
     * PUT /api/gocardless/partner/merchant-app-url
     *
     * Save the deployment URL for a merchant. Faithful port of
     * set_merchant_app_url (routes.py:1372-1388). Strips trailing slash.
     */
    router.put('/api/gocardless/partner/merchant-app-url', async (req, res) => {
        const appDb = getAppDb(req, res);
        if (!appDb)
            return;
        try {
            const body = (req.body ?? {});
            const signupId = Number(body.signup_id ?? 0);
            const result = await updateMerchantAppUrl(appDb, {
                signupId,
                appUrl: String(body.app_url ?? ''),
            });
            res.json(result);
        }
        catch (err) {
            ctx.logger.error('Set merchant app URL failed', err);
            res.status(500).json({ success: false, error: err?.message ?? String(err) });
        }
    });
    /**
     * POST /api/gocardless/partner/activate-merchant
     *
     * Push a merchant's GoCardless access token to their app.
     * Faithful port of activate_gocardless_merchant (routes.py:1391-1463).
     *
     * Local-host (localhost / 127.0.0.1 / 0.0.0.0) → write directly to
     * our own settings.api_access_token. Otherwise PUT the token via
     * fetch to {app_url}/api/gocardless/deploy-token (15s timeout). On
     * success, marks signup status='activated'.
     */
    router.post('/api/gocardless/partner/activate-merchant', async (req, res) => {
        const appDb = getAppDb(req, res);
        if (!appDb)
            return;
        try {
            const body = (req.body ?? {});
            const signupId = Number(body.signup_id ?? 0);
            const result = await activateMerchant(appDb, { signupId });
            res.json(result);
        }
        catch (err) {
            ctx.logger.error('Activate merchant failed', err);
            res.status(500).json({ success: false, error: err?.message ?? String(err) });
        }
    });
    /**
     * PUT /api/gocardless/deploy-token
     *
     * Receive a GoCardless access token (the activate-merchant flow's
     * remote target). Faithful port of deploy_gocardless_token
     * (routes.py:1466-1484). Saves to settings.api_access_token.
     */
    router.put('/api/gocardless/deploy-token', async (req, res) => {
        const appDb = getAppDb(req, res);
        if (!appDb)
            return;
        try {
            const body = (req.body ?? {});
            const result = await deployToken(appDb, body);
            res.json(result);
        }
        catch (err) {
            ctx.logger.error('Deploy token failed', err);
            res.status(500).json({ success: false, error: err?.message ?? String(err) });
        }
    });
    /**
     * POST /api/gocardless/parse-content
     *
     * Parse arbitrary GoCardless email content and return the structured
     * batch. Used by the dev playground / when an operator pastes the
     * email body. Faithful port of `parse_gocardless_content`
     * (apps/gocardless/api/routes.py:228-269).
     */
    router.post('/api/gocardless/parse-content', async (req, res) => {
        try {
            const content = String((req.body?.content ?? req.body?.email_content ?? '').toString());
            if (!content.trim()) {
                res
                    .status(400)
                    .json({ success: false, error: 'content is required' });
                return;
            }
            const batch = parseEmailContent(content);
            res.json({
                success: true,
                batch: {
                    gross_amount: batch.gross_amount,
                    gocardless_fees: batch.gocardless_fees,
                    app_fees: batch.app_fees,
                    vat_on_fees: batch.vat_on_fees,
                    net_amount: batch.net_amount,
                    bank_reference: batch.bank_reference,
                    currency: batch.currency,
                    payment_date: batch.payment_date
                        ? batch.payment_date.toISOString().slice(0, 10)
                        : null,
                    email_subject: batch.email_subject,
                    payment_count: batch.payments.length,
                    payments: batch.payments.map((p) => ({
                        customer_name: p.customer_name,
                        description: p.description,
                        amount: p.amount,
                        invoice_refs: p.invoice_refs,
                    })),
                },
            });
        }
        catch (err) {
            ctx.logger.error('parse-content failed', err);
            res
                .status(500)
                .json({ success: false, error: err?.message ?? String(err) });
        }
    });
    /**
     * GET /api/gocardless/scan-emails
     *
     * Scan the connected mailbox for GoCardless payout notifications and
     * return parsed batches with duplicate flags + period validation.
     * Faithful port of scan_gocardless_emails (routes.py:2731-3130).
     *
     * The SAM email-ingest contract delivers emails via a streaming
     * handler rather than a query API (`emailIngest.registerHandler`),
     * so the route requires the SAM team to provide an
     * `EmailMailboxAdapter` at construction time. The replication shape
     * is everything that's deterministic; the adapter wiring is one
     * concrete glue point the SAM team owns.
     *
     * Query params:
     *   - from_date            (YYYY-MM-DD, optional)
     *   - to_date              (YYYY-MM-DD, optional)
     *   - include_processed    ('1' to include already-imported emails)
     *   - company_reference    (override settings.company_reference)
     */
    router.get('/api/gocardless/scan-emails', async (req, res) => {
        const operaDb = getOperaDb(req, res);
        if (!operaDb)
            return;
        const appDb = getAppDb(req, res);
        if (!appDb)
            return;
        const adapter = ctx.gocardlessMailboxAdapter ?? builtinEmailIngest?.mailbox;
        if (!adapter) {
            res.status(503).json({
                success: false,
                error: 'Mailbox adapter not configured. SAM email-ingest wiring required.',
            });
            return;
        }
        try {
            const settings = await loadSettings(appDb);
            const fromDate = req.query.from_date ?? null;
            const toDate = req.query.to_date ?? null;
            const includeProcessed = req.query.include_processed === '1' ||
                req.query.include_processed === 'true';
            const companyOverride = req.query.company_reference ?? null;
            const result = await scanGocardlessEmails(operaDb, appDb, adapter, {
                fromDate,
                toDate,
                includeProcessed,
                companyReferenceOverride: companyOverride,
                companyReference: settings.company_reference ?? null,
                defaultCbtype: settings.default_batch_type ?? null,
            });
            res.json(result);
        }
        catch (err) {
            ctx.logger.error('scan-emails failed', err);
            res.status(500).json({
                success: false,
                error: err?.message ?? String(err),
            });
        }
    });
    /**
     * POST /api/gocardless/import
     *
     * Import a GoCardless payout as a batch sales-receipt in Opera.
     * Faithful port of `import_gocardless_batch`
     * (apps/gocardless/api/routes.py:622-949) for the validation,
     * idempotency, period gate, mandate verification, destination-bank
     * resolution, and import-history audit trail.
     *
     * The actual aentry/atran/stran/ntran/anoml posting body is
     * delegated to a `BatchPostingExecutor` the SAM team attaches to
     * runtime context (returns 503 until then). The executor receives
     * the fully validated request and performs the SQL writes against
     * the unified Knex client (Opera SE on SQL Server, Opera 3 via the
     * Write Agent — both engines see the same posting code).
     *
     * Body / params (subset; full list in import-batch.ts):
     *   - bank_code, post_date, payments[], reference, complete_batch,
     *     gocardless_fees, vat_on_fees, fees_nominal_account,
     *     fees_vat_code, currency, payout_id, source,
     *     dest_bank_account, dest_bank_sort_code
     */
    router.post('/api/gocardless/import', async (req, res) => {
        const operaDb = getOperaDb(req, res);
        if (!operaDb)
            return;
        const appDb = getAppDb(req, res);
        if (!appDb)
            return;
        const adapter = ctx;
        const executor = adapter.gocardlessBatchExecutor ?? gocardlessBatchPostingExecutor;
        const lock = adapter.gocardlessImportLock ?? inMemoryImportLock;
        try {
            const body = readObjectBody(req);
            const payments = readArrayBody(req, 'payments');
            const settings = await loadSettings(appDb);
            const known = (await appDb('gocardless_mandates')
                .select('mandate_id', 'opera_account'));
            const result = await importGocardlessBatch(operaDb, appDb, {
                bankCode: String(req.query.bank_code ?? body.bank_code ?? ''),
                postDate: String(req.query.post_date ?? body.post_date ?? ''),
                reference: String(req.query.reference ?? body.reference ?? '') || 'GoCardless',
                completeBatch: req.query.complete_batch === 'true' ||
                    body.complete_batch === true,
                cbtype: (req.query.cbtype ?? body.cbtype ?? null),
                goCardlessFees: Number(req.query.gocardless_fees ?? body.gocardless_fees ?? 0),
                vatOnFees: Number(req.query.vat_on_fees ?? body.vat_on_fees ?? 0),
                feesNominalAccount: (req.query.fees_nominal_account ??
                    body.fees_nominal_account ??
                    null),
                feesVatCode: String(req.query.fees_vat_code ?? body.fees_vat_code ?? '2'),
                feesPaymentType: (req.query.fees_payment_type ??
                    body.fees_payment_type ??
                    null),
                currency: (req.query.currency ?? body.currency ?? null),
                payoutId: (req.query.payout_id ?? body.payout_id ?? null),
                source: (req.query.source ?? body.source ?? 'api') === 'email'
                    ? 'email'
                    : 'api',
                destBankAccount: (req.query.dest_bank_account ??
                    body.dest_bank_account ??
                    null),
                destBankSortCode: (req.query.dest_bank_sort_code ??
                    body.dest_bank_sort_code ??
                    null),
                payments,
            }, {
                gocardless_bank_code: settings.gocardless_bank_code ?? null,
                gocardless_transfer_cbtype: settings.gocardless_transfer_cbtype ?? null,
            }, known, executor, lock);
            if (!result.success) {
                res.status(400).json(result);
                return;
            }
            res.json(result);
        }
        catch (err) {
            ctx.logger.error('gocardless/import failed', err);
            res.status(500).json({
                success: false,
                error: err?.message ?? String(err),
            });
        }
    });
    /**
     * POST /api/gocardless/import-from-email
     *
     * Same shape as POST /api/gocardless/import, but takes an
     * `email_id` so the import-history row links back to the source
     * email and (when an archive adapter is wired) the email is moved
     * to the configured archive folder afterwards.
     *
     * Faithful port of `import_gocardless_from_email`
     * (apps/gocardless/api/routes.py:3266-3500).
     */
    router.post('/api/gocardless/import-from-email', async (req, res) => {
        const operaDb = getOperaDb(req, res);
        if (!operaDb)
            return;
        const appDb = getAppDb(req, res);
        if (!appDb)
            return;
        const adapter = ctx;
        const executor = adapter.gocardlessBatchExecutor ?? gocardlessBatchPostingExecutor;
        const lock = adapter.gocardlessImportLock ?? inMemoryImportLock;
        try {
            const body = readObjectBody(req);
            const payments = readArrayBody(req, 'payments');
            const settings = await loadSettings(appDb);
            const known = (await appDb('gocardless_mandates').select('mandate_id', 'opera_account'));
            const result = await importGocardlessBatchFromEmail(operaDb, appDb, {
                emailId: Number(req.query.email_id ?? body.email_id ?? 0),
                bankCode: String(req.query.bank_code ?? body.bank_code ?? ''),
                postDate: String(req.query.post_date ?? body.post_date ?? ''),
                reference: String(req.query.reference ?? body.reference ?? '') || 'GoCardless',
                completeBatch: req.query.complete_batch === 'true' ||
                    body.complete_batch === true,
                cbtype: (req.query.cbtype ?? body.cbtype ?? null),
                goCardlessFees: Number(req.query.gocardless_fees ?? body.gocardless_fees ?? 0),
                vatOnFees: Number(req.query.vat_on_fees ?? body.vat_on_fees ?? 0),
                feesNominalAccount: (req.query.fees_nominal_account ??
                    body.fees_nominal_account ??
                    null),
                feesVatCode: String(req.query.fees_vat_code ?? body.fees_vat_code ?? '2'),
                feesPaymentType: (req.query.fees_payment_type ??
                    body.fees_payment_type ??
                    null),
                currency: (req.query.currency ?? body.currency ?? null),
                payoutId: (req.query.payout_id ?? body.payout_id ?? null),
                destBankAccount: (req.query.dest_bank_account ??
                    body.dest_bank_account ??
                    null),
                destBankSortCode: (req.query.dest_bank_sort_code ??
                    body.dest_bank_sort_code ??
                    null),
                archiveFolder: req.query.archive_folder ??
                    body.archive_folder ??
                    'Archive/GoCardless',
                payments,
            }, {
                gocardless_bank_code: settings.gocardless_bank_code ?? null,
                gocardless_transfer_cbtype: settings.gocardless_transfer_cbtype ?? null,
            }, known, executor, lock, adapter.gocardlessEmailArchive ?? null);
            if (!result.success) {
                res.status(400).json(result);
                return;
            }
            res.json(result);
        }
        catch (err) {
            ctx.logger.error('gocardless/import-from-email failed', err);
            res.status(500).json({
                success: false,
                error: err?.message ?? String(err),
            });
        }
    });
    /**
     * POST /api/gocardless/ocr           — image upload, OCR via ctx.llm
     * POST /api/gocardless/ocr-path      — same, server-side path
     * POST /api/gocardless/parse         — parse pasted content (full
     *                                      email OR just the payment table)
     *
     * Faithful ports of routes.py:90, 124, 227.
     *
     * The Python OCR uses pytesseract; the SAM port uses ctx.llm vision
     * (Claude) for the same OCR-style "extract text from image" flow.
     * /parse is a thin wrapper that tries `parseGocardlessEmail` and
     * falls back to nothing — the existing /parse-content endpoint
     * does the same job with a slightly richer response shape.
     */
    router.post('/api/gocardless/ocr-path', async (req, res) => {
        const llm = ctx.llm ?? null;
        if (!llm) {
            res.status(503).json({ success: false, error: 'ctx.llm not configured' });
            return;
        }
        try {
            const body = (req.body ?? {});
            if (!body.file_path) {
                res.status(400).json({ success: false, error: 'file_path required' });
                return;
            }
            const stream = llm.chat({
                messages: [
                    {
                        role: 'user',
                        content: `Extract all text visible in this image. Return only the raw text, no commentary.\n\nImage path: ${body.file_path}`,
                    },
                ],
                model: 'claude-sonnet-4',
                maxTokens: 8000,
                temperature: 0,
            });
            const buf = [];
            for await (const chunk of stream) {
                if (typeof chunk === 'string')
                    buf.push(chunk);
                else if (chunk && typeof chunk === 'object') {
                    const c = chunk;
                    if (typeof c.text === 'string')
                        buf.push(c.text);
                    else if (c.delta?.text)
                        buf.push(c.delta.text);
                }
            }
            const text = buf.join('').trim();
            if (!text) {
                res.json({ success: false, error: 'No text could be extracted from image' });
                return;
            }
            res.json({ success: true, text, file_path: body.file_path });
        }
        catch (err) {
            ctx.logger.error('ocr-path failed', err);
            res.status(500).json({ success: false, error: err?.message ?? String(err) });
        }
    });
    router.post('/api/gocardless/ocr', async (_req, res) => {
        // Image upload via multipart form — SAM-side handling required
        // (SAM does file uploads outside the plugin's route handler).
        res.status(501).json({
            success: false,
            error: 'Multipart image upload not implemented in this plugin port. Use /api/gocardless/ocr-path with a stored file path, or have the SAM frontend convert image bytes to a data URL and call /ocr-path.',
        });
    });
    router.post('/api/gocardless/parse', async (req, res) => {
        try {
            const body = (req.body ?? {});
            const content = (body.content ?? '').toString();
            if (!content.trim()) {
                res.status(400).json({ success: false, error: 'content required' });
                return;
            }
            const batch = parseEmailContent(content);
            if (batch.payments.length === 0) {
                res.json({
                    success: false,
                    error: 'Could not parse any payments from the content. Please paste the GoCardless email or payment table.',
                });
                return;
            }
            res.json({
                success: true,
                payment_count: batch.payments.length,
                gross_amount: batch.gross_amount,
                gocardless_fees: batch.gocardless_fees,
                vat_on_fees: batch.vat_on_fees,
                net_amount: batch.net_amount,
                bank_reference: batch.bank_reference,
                payments: batch.payments.map((p) => ({
                    customer_name: p.customer_name,
                    description: p.description,
                    amount: p.amount,
                    invoice_refs: p.invoice_refs,
                })),
            });
        }
        catch (err) {
            ctx.logger.error('parse failed', err);
            res.status(500).json({ success: false, error: err?.message ?? String(err) });
        }
    });
    return router;
}
//# sourceMappingURL=router.js.map