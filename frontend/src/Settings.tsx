import { useState, useRef, useEffect, useCallback } from 'react';
import type { ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Settings, X, Wifi, Tag, HelpCircle } from 'lucide-react';
import { authFetch } from './api-shim';
import { PageHeader } from './PageHeader';

// Legacy SAM-host components stubbed as no-ops until their data
// surfaces become first-class in the standalone host. Settings is
// otherwise functional without them.
function useHelp() {
  const [showHelp, setShowHelp] = useState(false);
  return { showHelp, setShowHelp };
}
function HelpPanel(_props: {
  isOpen?: boolean;
  onClose?: () => void;
  title?: string;
  children?: ReactNode;
  sections?: Array<{ title: string; content: string }>;
}) {
  return null;
}
function SystemConnectionPanel(_props: { appLabel: string }) {
  return null;
}

type OperaVersion = 'opera-sql' | 'opera3';

// Searchable nominal account selector component
function NominalAccountSearch({
  accounts,
  value,
  onChange,
  placeholder = "Click to browse or type to search..."
}: {
  accounts: { code: string; description: string }[];
  value: string;
  onChange: (code: string) => void;
  placeholder?: string;
}) {
  const [search, setSearch] = useState('');
  const [isOpen, setIsOpen] = useState(false);
  const [highlightedIndex, setHighlightedIndex] = useState(0);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (wrapperRef.current && !wrapperRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const filtered = search
    ? accounts.filter(a =>
        a.description.toLowerCase().includes(search.toLowerCase()) ||
        a.code.toLowerCase().includes(search.toLowerCase())
      ).slice(0, 20)
    : accounts.slice(0, 50);

  useEffect(() => {
    setHighlightedIndex(0);
  }, [search]);

  useEffect(() => {
    if (listRef.current && isOpen) {
      const highlighted = listRef.current.children[highlightedIndex] as HTMLElement;
      if (highlighted) {
        highlighted.scrollIntoView({ block: 'nearest' });
      }
    }
  }, [highlightedIndex, isOpen]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (!isOpen) {
      if (e.key === 'ArrowDown' || e.key === 'Enter') {
        setIsOpen(true);
      }
      return;
    }

    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        setHighlightedIndex(i => Math.min(i + 1, filtered.length - 1));
        break;
      case 'ArrowUp':
        e.preventDefault();
        setHighlightedIndex(i => Math.max(i - 1, 0));
        break;
      case 'Enter':
        e.preventDefault();
        if (filtered[highlightedIndex]) {
          onChange(filtered[highlightedIndex].code);
          setIsOpen(false);
          setSearch('');
        }
        break;
      case 'Escape':
        setIsOpen(false);
        break;
    }
  };

  const selected = accounts.find(a => a.code === value);

  return (
    <div ref={wrapperRef} className="relative">
      {value ? (
        <div className="flex items-center gap-2 p-2 border border-green-300 bg-green-50 rounded text-sm">
          <span className="flex-1 truncate">{selected?.code} - {selected?.description}</span>
          <button
            onClick={() => { onChange(''); setSearch(''); }}
            className="text-gray-400 hover:text-red-500"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      ) : (
        <input
          type="text"
          className="w-full p-2 border border-gray-300 rounded text-sm"
          placeholder={placeholder}
          value={search}
          onChange={(e) => { setSearch(e.target.value); setIsOpen(true); }}
          onFocus={() => setIsOpen(true)}
          onKeyDown={handleKeyDown}
        />
      )}
      {isOpen && !value && (
        <div ref={listRef} className="absolute z-10 w-full mt-1 bg-white border border-gray-300 rounded shadow-lg max-h-48 overflow-y-auto">
          {filtered.length === 0 ? (
            <div className="p-2 text-sm text-gray-500">No matches found</div>
          ) : (
            filtered.map((a, idx) => (
              <button
                key={a.code}
                className={`w-full text-left p-2 text-sm border-b border-gray-100 ${
                  idx === highlightedIndex ? 'bg-blue-100' : 'hover:bg-blue-50'
                }`}
                onClick={() => { onChange(a.code); setIsOpen(false); setSearch(''); }}
                onMouseEnter={() => setHighlightedIndex(idx)}
              >
                <span className="font-medium">{a.code}</span> - {a.description}
              </button>
            ))
          )}
        </div>
      )}
    </div>
  );
}

export function GoCardlessSettings() {
  const { data: operaConfigData } = useQuery({
    queryKey: ['operaConfig'],
    queryFn: async () => {
      const res = await authFetch('/api/config/opera');
      return res.json();
    },
  });
  const operaVersion: OperaVersion = operaConfigData?.version === 'opera3' ? 'opera3' : 'opera-sql';
  const opera3DataPath = operaConfigData?.opera3_server_path || operaConfigData?.opera3_base_path || '';

  // Settings state
  const [bankCode, setBankCode] = useState('');
  const [selectedBatchType, setSelectedBatchType] = useState('');
  const [feesNominalAccount, setFeesNominalAccount] = useState('');
  const [gcBankCode, setGcBankCode] = useState('');
  const [transferCbtype, setTransferCbtype] = useState('');
  const [dataSource, setDataSource] = useState<'email' | 'api' | 'history'>('api');
  const [apiAccessToken, setApiAccessToken] = useState('');
  const [apiKeyConfigured, setApiKeyConfigured] = useState(false);
  const [apiKeyHint, setApiKeyHint] = useState('');
  const [apiSandbox, setApiSandbox] = useState(false);
  const [apiTestResult, setApiTestResult] = useState<{ success: boolean; message: string } | null>(null);
  const [isTestingApi, setIsTestingApi] = useState(false);
  const [isSavingSettings, setIsSavingSettings] = useState(false);
  const [feesVatCode, setFeesVatCode] = useState('');
  const [feesPaymentType, setFeesPaymentType] = useState('');
  const [companyReference, setCompanyReference] = useState('');
  const [requestStatementReference, setRequestStatementReference] = useState('');
  const [bacsReferenceTemplate, setBacsReferenceTemplate] = useState('{company}');
  const [archiveFolder, setArchiveFolder] = useState('Archive/GoCardless');
  const [saveSuccess, setSaveSuccess] = useState(false);

  // Subscription settings
  const [subscriptionTag, setSubscriptionTag] = useState('SUB');
  const [subscriptionFrequencies, setSubscriptionFrequencies] = useState<string[]>(['W', 'M', 'A']);
  const [payoutLookbackDays, setPayoutLookbackDays] = useState(30);

  // Subscription tag update modal
  const [showTagModal, setShowTagModal] = useState(false);
  const [tagPreview, setTagPreview] = useState<{
    tag: string;
    total_matching: number;
    already_tagged: number;
    will_tag: number;
    has_different: number;
    documents: { doc_ref: string; account: string; name: string; frequency: string; current_analsys: string; status: string }[];
  } | null>(null);
  const [tagOverwrite, setTagOverwrite] = useState(false);
  const [isLoadingPreview, setIsLoadingPreview] = useState(false);
  const [isApplyingTags, setIsApplyingTags] = useState(false);
  const [tagResult, setTagResult] = useState<{ success: boolean; message: string } | null>(null);

  // Reference data
  const [bankAccounts, setBankAccounts] = useState<{ code: string; description: string }[]>([]);
  const [batchTypes, setBatchTypes] = useState<{ code: string; description: string }[]>([]);
  const [transferTypes, setTransferTypes] = useState<{ code: string; description: string }[]>([]);
  const [nominalAccounts, setNominalAccounts] = useState<{ code: string; description: string }[]>([]);
  const [vatCodes, setVatCodes] = useState<{ code: string; description: string; rate: number }[]>([]);
  const [paymentTypes, setPaymentTypes] = useState<{ code: string; description: string }[]>([]);

  // Helper: build GC import API URL with Opera version routing
  const gcImportUrl = (path: string, extraParams?: Record<string, string>) => {
    const isO3 = operaVersion === 'opera3';
    const base = isO3 ? `/api/opera3/gocardless${path}` : `/api/gocardless${path}`;
    const params = new URLSearchParams();
    if (isO3 && opera3DataPath) params.set('data_path', opera3DataPath);
    if (extraParams) Object.entries(extraParams).forEach(([k, v]) => params.set(k, v));
    const qs = params.toString();
    return qs ? `${base}?${qs}` : base;
  };

  // Load reference data and saved settings
  useEffect(() => {
    if (!operaConfigData) return;

    // Fetch batch types, nominal accounts, and VAT codes in a single request
    authFetch(gcImportUrl('/import-config'))
      .then(res => res.json())
      .then(data => {
        if (data.success) {
          if (data.batch_types) {
            setBatchTypes(data.batch_types.map((t: { code: string; description: string }) => ({
              code: t.code,
              description: t.description
            })));
          }
          if (data.nominal_accounts) setNominalAccounts(data.nominal_accounts);
          if (data.vat_codes) setVatCodes(data.vat_codes);
        }
      })
      .catch(err => console.error('Failed to load GoCardless import config:', err));

    // Fetch transfer types (ay_type='T') for GC→bank transfer
    authFetch('/api/bank-import/cashbook-types?category=T')
      .then(res => res.json())
      .then(data => {
        if (data.success && data.types) {
          setTransferTypes(data.types.map((t: { code: string; description: string }) => ({
            code: t.code,
            description: t.description
          })));
        }
      })
      .catch(err => console.error('Failed to load transfer types:', err));

    // Fetch bank accounts from Opera
    authFetch(gcImportUrl('/bank-accounts'))
      .then(res => res.json())
      .then(data => {
        if (data.success && data.accounts) {
          setBankAccounts(data.accounts);
        }
      })
      .catch(err => console.error('Failed to load bank accounts:', err));

    // Fetch saved settings
    authFetch('/api/gocardless/settings')
      .then(res => res.json())
      .then(data => {
        if (data.success && data.settings) {
          if (data.settings.default_batch_type) setSelectedBatchType(data.settings.default_batch_type);
          if (data.settings.default_bank_code) setBankCode(data.settings.default_bank_code);
          if (data.settings.fees_nominal_account) setFeesNominalAccount(data.settings.fees_nominal_account);
          if (data.settings.fees_vat_code) setFeesVatCode(data.settings.fees_vat_code);
          if (data.settings.fees_payment_type) setFeesPaymentType(data.settings.fees_payment_type);
          if (data.settings.company_reference) setCompanyReference(data.settings.company_reference);
          if (data.settings.request_statement_reference !== undefined) setRequestStatementReference(data.settings.request_statement_reference || '');
          if (data.settings.bacs_reference_template !== undefined) setBacsReferenceTemplate(data.settings.bacs_reference_template || '{company}');
          if (data.settings.archive_folder) setArchiveFolder(data.settings.archive_folder);
          if (data.settings.gocardless_bank_code) setGcBankCode(data.settings.gocardless_bank_code);
          if (data.settings.gocardless_transfer_cbtype) setTransferCbtype(data.settings.gocardless_transfer_cbtype);
          if (data.settings.api_key_configured) {
            setApiKeyConfigured(true);
            setApiKeyHint(data.settings.api_key_hint || '');
          }
          if (data.settings.api_access_token) setApiAccessToken(data.settings.api_access_token);
          if (data.settings.api_sandbox !== undefined) setApiSandbox(data.settings.api_sandbox);
          if (data.settings.data_source) setDataSource(data.settings.data_source);
          if (data.settings.subscription_tag !== undefined) setSubscriptionTag(data.settings.subscription_tag);
          if (data.settings.subscription_frequencies) setSubscriptionFrequencies(data.settings.subscription_frequencies);
          if (data.settings.payout_lookback_days !== undefined) setPayoutLookbackDays(Number(data.settings.payout_lookback_days) || 30);
        }
      })
      .catch(err => console.error('Failed to load GoCardless settings:', err));

    // Fetch payment types
    authFetch(gcImportUrl('/payment-types'))
      .then(res => res.json())
      .then(data => {
        if (data.success && data.types) setPaymentTypes(data.types);
      })
      .catch(err => console.error('Failed to load payment types:', err));
  }, [operaConfigData]);

  // Test GoCardless API connection
  const testApiConnection = async () => {
    setIsTestingApi(true);
    setApiTestResult(null);
    try {
      const response = await authFetch('/api/gocardless/test-api', { method: 'POST' });
      const data = await response.json();
      if (data.success) {
        setApiTestResult({
          success: true,
          message: `Connected to GoCardless ${data.environment}${data.name ? ` (${data.name})` : ''}`
        });
      } else {
        setApiTestResult({ success: false, message: data.error || 'Connection failed' });
      }
    } catch (error) {
      setApiTestResult({ success: false, message: `Connection error: ${error}` });
    } finally {
      setIsTestingApi(false);
    }
  };

  // Resolve BACS template to preview string
  const resolveBacsTemplate = (template: string): string => {
    const fields: Record<string, string> = {
      company: requestStatementReference || 'COMPANY',
      inv: 'INV99999',
      inv_num: '99999',
      customer: 'Z999',
    };
    return template.replace(/\{(\w+?)(\d+)?\}/g, (_: string, field: string, len: string) => {
      const val = fields[field] || '';
      return len ? val.slice(0, parseInt(len)) : val;
    });
  };

  const bacsPreviewLength = resolveBacsTemplate(bacsReferenceTemplate || '{company}').length;
  const bacsError = bacsPreviewLength > 10
    ? `BACS reference resolves to ${bacsPreviewLength} characters — maximum is 10. Shorten the template or use length limits (e.g. {'{company4}'}).`
    : null;

  // Save all GoCardless settings
  const saveSettings = async () => {
    if (bacsError) {
      setSaveSuccess(false);
      return;
    }
    setIsSavingSettings(true);
    setSaveSuccess(false);
    try {
      const response = await authFetch('/api/gocardless/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          default_batch_type: selectedBatchType,
          default_bank_code: bankCode,
          fees_nominal_account: feesNominalAccount,
          fees_vat_code: feesVatCode,
          fees_payment_type: feesPaymentType,
          company_reference: companyReference,
          request_statement_reference: requestStatementReference,
          bacs_reference_template: bacsReferenceTemplate,
          archive_folder: archiveFolder,
          gocardless_bank_code: gcBankCode,
          gocardless_transfer_cbtype: transferCbtype,
          api_access_token: apiAccessToken,
          api_sandbox: apiSandbox,
          data_source: dataSource,
          subscription_tag: subscriptionTag,
          subscription_frequencies: subscriptionFrequencies,
          payout_lookback_days: payoutLookbackDays,
        })
      });
      const data = await response.json();
      if (data.success) {
        if (apiAccessToken) {
          setApiKeyConfigured(true);
          setApiKeyHint(`...${apiAccessToken.slice(-4)}`);
          setApiAccessToken('');
        }
        setSaveSuccess(true);
        setTimeout(() => setSaveSuccess(false), 3000);
      } else {
        alert(`Failed to save settings: ${data.error}`);
      }
    } catch (error) {
      alert(`Failed to save settings: ${error}`);
    } finally {
      setIsSavingSettings(false);
    }
  };

  const toggleFrequency = useCallback((code: string) => {
    setSubscriptionFrequencies(prev =>
      prev.includes(code) ? prev.filter(f => f !== code) : [...prev, code]
    );
  }, []);

  const handlePreviewTags = async () => {
    setIsLoadingPreview(true);
    setTagPreview(null);
    setTagResult(null);
    setTagOverwrite(false);
    try {
      const response = await authFetch('/api/gocardless/update-subscription-tags', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: 'preview' })
      });
      const data = await response.json();
      if (data.success) {
        setTagPreview(data);
        setShowTagModal(true);
      } else {
        setTagResult({ success: false, message: data.error || 'Failed to preview' });
      }
    } catch (error) {
      setTagResult({ success: false, message: `Error: ${error}` });
    } finally {
      setIsLoadingPreview(false);
    }
  };

  const handleApplyTags = async () => {
    setIsApplyingTags(true);
    try {
      const response = await authFetch('/api/gocardless/update-subscription-tags', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: 'apply', overwrite: tagOverwrite })
      });
      const data = await response.json();
      if (data.success) {
        setTagResult({ success: true, message: `Updated ${data.updated} document(s) with tag "${data.tag}"` });
        setShowTagModal(false);
      } else {
        setTagResult({ success: false, message: data.error || 'Failed to apply tags' });
      }
    } catch (error) {
      setTagResult({ success: false, message: `Error: ${error}` });
    } finally {
      setIsApplyingTags(false);
    }
  };

  // Help panel state
  const { showHelp, setShowHelp } = useHelp();

  return (
    <div className="space-y-6">
      <PageHeader icon={Settings} title="GoCardless Settings" subtitle="Configure GoCardless API and import settings">
        <button
          onClick={() => setShowHelp(prev => !prev)}
          className={`flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-lg transition-colors ${
            showHelp ? 'bg-blue-600 text-white' : 'text-gray-600 bg-white border border-gray-200 hover:bg-gray-50'
          }`}
          title="Toggle help (F1)"
        >
          <HelpCircle className="h-4 w-4" />
          Help
        </button>
      </PageHeader>

      {/* Help Panel */}
      <HelpPanel
        isOpen={showHelp}
        onClose={() => setShowHelp(false)}
        sections={[
          { title: 'Access Token', content: 'Your GoCardless API key. Obtain from the GoCardless dashboard under Developers > API Keys. Sandbox tokens start with "sandbox_", live tokens don\'t. The system auto-detects which environment to use.' },
          { title: 'Default Batch Type / GoCardless Control Bank', content: 'The Opera cashbook type and bank account where GoCardless receipts are posted. This should be the bank account that receives GoCardless payouts (check your bank statements).' },
          { title: 'Transfer Type', content: 'The Opera cashbook transfer type used when posting GoCardless bank transfers. Usually the same type used for inter-bank transfers in Opera.' },
          { title: 'Statement Reference', content: 'Appears on the customer\'s bank statement when a Direct Debit is collected. Max 10 characters. Typically your company name or trading name. If blank, GoCardless uses its own default.' },
          { title: 'Fees Nominal Account / VAT Code / Payment Type', content: 'GoCardless deducts fees from each payout. These settings control where the fee expense is posted in Opera\'s nominal ledger, the VAT treatment, and the payment method code.' },
          { title: 'Payout Lookback Days', content: 'How far back to search when fetching payouts from GoCardless. Default 30 days. Lower values mean faster processing. Only payouts within this window appear in the import screen.' },
          { title: 'Subscription Tag', content: 'The Opera analysis code (on repeat invoices) that identifies documents for GoCardless subscription processing. Default is "SUB". Only repeat invoices with this tag will appear in the subscription management screen.' },
          { title: 'Frequency Filter', content: 'When creating subscriptions, filter repeat invoices by their frequency type (Monthly, Quarterly, etc.). "All" shows everything.' },
          { title: 'Partner Integration', content: 'For GoCardless partners managing multiple merchants. Enter your partner credentials to enable merchant onboarding and multi-merchant management. Most users don\'t need this section.' },
        ]}
      />

      <div className="bg-white rounded-lg border border-gray-200 shadow-sm">
        <div className="p-6 space-y-6">
          {/* Data Source */}
          <div className="space-y-3">
            <h3 className="font-medium text-gray-900 border-b pb-2">Data Source</h3>
            <div className="flex items-center gap-3 p-4 border-2 border-blue-500 bg-blue-50 rounded-lg">
              <Wifi className="h-6 w-6 text-blue-600" />
              <div>
                <div className="font-medium">GoCardless API</div>
                <div className="text-sm text-gray-500">Direct API integration</div>
              </div>
            </div>
          </div>

          {/* API Configuration */}
          <div className="space-y-4 p-4 bg-gray-50 rounded-lg">
            <h3 className="font-medium text-gray-900">API Configuration</h3>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Access Token
                {apiKeyConfigured && <span className="ml-2 text-green-600 text-xs font-normal">(Configured {apiKeyHint})</span>}
              </label>
              <input
                type="password"
                value={apiAccessToken}
                onChange={(e) => setApiAccessToken(e.target.value)}
                placeholder={apiKeyConfigured ? 'Enter new token to update, or leave blank to keep existing' : 'Enter your GoCardless access token'}
                className="w-full p-2 border border-gray-300 rounded text-sm"
              />
              <p className="text-xs text-gray-500 mt-1">
                Get your access token from{' '}
                <a href="https://manage.gocardless.com/developers/access-tokens" target="_blank" rel="noopener noreferrer" className="text-blue-600 hover:underline">
                  GoCardless Dashboard &rarr; Developers &rarr; Access Tokens
                </a>
              </p>
            </div>
            <div className="flex items-center gap-4">
              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={apiSandbox}
                  onChange={(e) => setApiSandbox(e.target.checked)}
                  className="rounded border-gray-300"
                />
                <span className="text-sm">Sandbox Mode (for testing)</span>
              </label>
              <button
                onClick={testApiConnection}
                disabled={(!apiAccessToken && !apiKeyConfigured) || isTestingApi}
                className="px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700 disabled:bg-gray-400 text-sm"
              >
                {isTestingApi ? 'Testing...' : 'Test Connection'}
              </button>
            </div>
            {apiTestResult && (
              <div className={`p-3 rounded text-sm ${apiTestResult.success ? 'bg-green-50 text-green-700' : 'bg-red-50 text-red-700'}`}>
                {apiTestResult.success ? '✓' : '✗'} {apiTestResult.message}
              </div>
            )}
          </div>

          {/* Import Settings */}
          <div className="space-y-4">
            <h3 className="font-medium text-gray-900 border-b pb-2">Import Settings</h3>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  {gcBankCode ? 'Destination Bank (receives payout)' : 'Bank Account'}
                </label>
                <select
                  value={bankCode}
                  onChange={(e) => setBankCode(e.target.value)}
                  className="w-full p-2 border border-gray-300 rounded text-sm"
                >
                  {bankAccounts.map(acc => (
                    <option key={acc.code} value={acc.code}>{acc.code} - {acc.description}</option>
                  ))}
                </select>
                <p className="text-xs text-gray-500 mt-1">
                  {gcBankCode ? 'The bank that receives the GoCardless payout (e.g. Barclays Current A/C).' : 'Bank account to post GoCardless receipts to.'}
                </p>
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Default Batch Type</label>
                <select
                  value={selectedBatchType}
                  onChange={(e) => setSelectedBatchType(e.target.value)}
                  className="w-full p-2 border border-gray-300 rounded text-sm"
                >
                  <option value="">-- Select --</option>
                  {batchTypes.map(t => (
                    <option key={t.code} value={t.code}>{t.code} - {t.description}</option>
                  ))}
                </select>
              </div>
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">GoCardless Control Bank</label>
              <select
                value={gcBankCode}
                onChange={(e) => setGcBankCode(e.target.value)}
                className="w-full p-2 border border-gray-300 rounded text-sm"
              >
                <option value="">(None — post directly to bank)</option>
                {bankAccounts.map(acc => (
                  <option key={acc.code} value={acc.code}>{acc.code} - {acc.description}</option>
                ))}
              </select>
              <p className="text-xs text-gray-500 mt-1">
                {gcBankCode && gcBankCode !== bankCode
                  ? `Receipts + fees post here, then net payout auto-transfers to ${bankCode}.`
                  : 'Optional clearing bank. Receipts + fees post here, net payout transfers to Destination Bank.'}
              </p>
            </div>
            {gcBankCode && (
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Transfer Type</label>
                <select
                  value={transferCbtype}
                  onChange={(e) => setTransferCbtype(e.target.value)}
                  className="w-full p-2 border border-gray-300 rounded text-sm"
                >
                  <option value="">(Auto — use default transfer type)</option>
                  {transferTypes.map(t => (
                    <option key={t.code} value={t.code}>{t.code} - {t.description}</option>
                  ))}
                </select>
                <p className="text-xs text-gray-500 mt-1">Cashbook type for the auto-transfer from GC Control to destination bank.</p>
              </div>
            )}
          </div>

          {gcBankCode && gcBankCode !== bankCode && (
            <div className="p-3 bg-blue-50 border border-blue-200 rounded text-sm text-blue-800">
              Receipts + fees will post to <strong>{gcBankCode}</strong>, then net payout transfers to <strong>{bankCode}</strong>.
              The control bank should net to zero after each batch.
            </div>
          )}

          {/* Payment Request Settings */}
          <div className="space-y-4">
            <h3 className="font-medium text-gray-900 border-b pb-2">Payment Requests</h3>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Company Name</label>
              <input
                type="text"
                value={requestStatementReference}
                onChange={(e) => setRequestStatementReference(e.target.value.slice(0, 10))}
                placeholder="e.g. Intsys"
                maxLength={10}
                className="w-48 p-2 border border-gray-300 rounded text-sm"
              />
              <p className="text-xs text-gray-500 mt-1">
                Your company name or trading name (max 10 chars). Used as the {'{company}'} field in the templates below and as a prefix in payment descriptions.
              </p>
              <p className="text-xs text-gray-400 mt-0.5">
                {requestStatementReference ? `${requestStatementReference.length}/10 characters` : 'Not set — GoCardless will use its own default'}
              </p>
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Bank Statement Reference (BACS)</label>
              <input
                type="text"
                value={bacsReferenceTemplate}
                onChange={(e) => setBacsReferenceTemplate(e.target.value)}
                placeholder="{company}"
                className="w-64 p-2 border border-gray-300 rounded text-sm"
              />
              <p className="text-xs text-gray-500 mt-1">
                What the customer sees on their bank statement when the Direct Debit is taken (max 10 characters).
              </p>
              <div className="text-xs text-gray-400 mt-1 space-y-0.5">
                <div><code>{'{company}'}</code> — Company name above ({requestStatementReference || 'not set'})</div>
                <div><code>{'{company4}'}</code> — First 4 chars ({(requestStatementReference || 'COMP').slice(0, 4)})</div>
                <div><code>{'{inv}'}</code> — Full invoice reference (e.g. INV26492)</div>
                <div><code>{'{inv_num}'}</code> — Invoice number only (e.g. 26492)</div>
                <div><code>{'{inv_num5}'}</code> — Number limited to 5 digits</div>
                <div><code>{'{customer}'}</code> — Customer account code (e.g. R019)</div>
              </div>
              {bacsError ? (
                <p className="text-xs text-red-600 mt-1.5 font-medium">{bacsError}</p>
              ) : (
                <p className="text-xs text-green-600 mt-1.5">
                  Preview: "{resolveBacsTemplate(bacsReferenceTemplate || '{company}').slice(0, 10)}" ({Math.min(bacsPreviewLength, 10)} of 10 chars)
                </p>
              )}
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Payment Description</label>
              <p className="text-xs text-gray-500">
                The full description sent to GoCardless (max 100 chars). This appears in GoCardless notifications to the customer, not on their bank statement.
                Format: <span className="font-mono text-gray-600">{requestStatementReference ? `${requestStatementReference} INV26492` : 'INV26492'}</span> (auto-generated from company name + invoice reference).
              </p>
            </div>
          </div>

          {/* Fees Settings */}
          <div className="space-y-4">
            <h3 className="font-medium text-gray-900 border-b pb-2">GoCardless Fees</h3>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Fees Nominal Account</label>
                <NominalAccountSearch
                  accounts={nominalAccounts}
                  value={feesNominalAccount}
                  onChange={setFeesNominalAccount}
                  placeholder="Click to browse or type to search..."
                />
                <p className="text-xs text-gray-500 mt-1">Account to post GoCardless fees</p>
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Fees VAT Code</label>
                <select
                  value={feesVatCode}
                  onChange={(e) => setFeesVatCode(e.target.value)}
                  className="w-full p-2 border border-gray-300 rounded text-sm"
                >
                  <option value="">-- Select --</option>
                  {vatCodes.map(code => (
                    <option key={code.code} value={code.code}>{code.code} - {code.description} ({code.rate}%)</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Fees Payment Type</label>
                <select
                  value={feesPaymentType}
                  onChange={(e) => setFeesPaymentType(e.target.value)}
                  className="w-full p-2 border border-gray-300 rounded text-sm"
                >
                  <option value="">-- Select --</option>
                  {paymentTypes.map(t => (
                    <option key={t.code} value={t.code}>{t.code} - {t.description}</option>
                  ))}
                </select>
                <p className="text-xs text-gray-500 mt-1">Cashbook type for posting fees</p>
              </div>
            </div>
          </div>

          {/* Subscription Settings */}
          <div className="space-y-4">
            <h3 className="font-medium text-gray-900 border-b pb-2">Subscription Settings</h3>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Payout Lookback Days</label>
                <div className="flex items-center gap-2">
                  <input
                    type="number"
                    value={payoutLookbackDays}
                    onChange={(e) => setPayoutLookbackDays(Math.max(1, parseInt(e.target.value) || 30))}
                    min={1}
                    max={365}
                    className="w-24 p-2 border border-gray-300 rounded text-sm"
                  />
                  <span className="text-sm text-gray-500">days</span>
                </div>
                <p className="text-xs text-gray-500 mt-1">How far back to search for payouts when fetching from GoCardless API. Lower = faster.</p>
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Subscription Tag</label>
                <input
                  type="text"
                  value={subscriptionTag}
                  onChange={(e) => setSubscriptionTag(e.target.value.toUpperCase())}
                  placeholder="SUB"
                  maxLength={4}
                  className="w-full p-2 border border-gray-300 rounded text-sm"
                />
                <p className="text-xs text-gray-500 mt-1">Analysis code used to identify subscription repeat documents (ih_analsys)</p>
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Frequency Filter</label>
                <div className="flex flex-wrap gap-3 mt-1">
                  {[
                    { code: 'W', label: 'Weekly' },
                    { code: 'M', label: 'Monthly' },
                    { code: 'Q', label: 'Quarterly' },
                    { code: 'A', label: 'Annual' }
                  ].map(f => (
                    <label key={f.code} className="flex items-center gap-1.5">
                      <input
                        type="checkbox"
                        checked={subscriptionFrequencies.includes(f.code)}
                        onChange={() => toggleFrequency(f.code)}
                        className="rounded border-gray-300"
                      />
                      <span className="text-sm">{f.label}</span>
                    </label>
                  ))}
                </div>
                <p className="text-xs text-gray-500 mt-1">Which repeat document frequencies to include for subscriptions</p>
              </div>
            </div>
            <div className="flex items-center gap-3">
              <button
                onClick={handlePreviewTags}
                disabled={isLoadingPreview || !subscriptionTag}
                className="px-4 py-2 bg-amber-600 text-white rounded hover:bg-amber-700 disabled:bg-gray-400 text-sm flex items-center gap-2"
              >
                <Tag className="h-4 w-4" />
                {isLoadingPreview ? 'Loading...' : 'Update Opera Documents'}
              </button>
              <span className="text-xs text-gray-500">
                Set ih_analsys = "{subscriptionTag}" on matching repeat documents
              </span>
            </div>
            {tagResult && (
              <div className={`p-3 rounded text-sm flex items-start gap-2 ${tagResult.success ? 'bg-green-50 border border-green-200 text-green-700' : 'bg-red-50 border border-red-200 text-red-700'}`}>
                <span>{tagResult.success ? '✓' : '✗'}</span>
                <span className="flex-1">{tagResult.message}</span>
                <button onClick={() => setTagResult(null)} className="text-gray-400 hover:text-gray-600">
                  <X className="h-4 w-4" />
                </button>
              </div>
            )}
          </div>
        </div>

        {/* Tag Update Confirmation Modal */}
        {showTagModal && tagPreview && (
          <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
            <div className="bg-white rounded-lg shadow-xl max-w-lg w-full mx-4">
              <div className="p-4 border-b">
                <h3 className="font-medium text-gray-900">Update Subscription Tags</h3>
                <p className="text-sm text-gray-500 mt-1">
                  Tag repeat documents with analysis code "{tagPreview.tag}"
                </p>
              </div>
              <div className="p-4 space-y-3">
                <div className="grid grid-cols-3 gap-3 text-center">
                  <div className="p-3 bg-green-50 rounded">
                    <div className="text-2xl font-bold text-green-700">{tagPreview.will_tag}</div>
                    <div className="text-xs text-green-600">Will be tagged</div>
                  </div>
                  <div className="p-3 bg-gray-50 rounded">
                    <div className="text-2xl font-bold text-gray-500">{tagPreview.already_tagged}</div>
                    <div className="text-xs text-gray-500">Already tagged</div>
                  </div>
                  <div className="p-3 bg-amber-50 rounded">
                    <div className="text-2xl font-bold text-amber-700">{tagPreview.has_different}</div>
                    <div className="text-xs text-amber-600">Different code</div>
                  </div>
                </div>

                {tagPreview.has_different > 0 && (
                  <label className="flex items-start gap-2 p-3 bg-amber-50 border border-amber-200 rounded">
                    <input
                      type="checkbox"
                      checked={tagOverwrite}
                      onChange={(e) => setTagOverwrite(e.target.checked)}
                      className="rounded border-gray-300 mt-0.5"
                    />
                    <div>
                      <span className="text-sm font-medium text-amber-800">
                        Also overwrite {tagPreview.has_different} document(s) that have a different analysis code
                      </span>
                      <div className="text-xs text-amber-600 mt-1">
                        {tagPreview.documents
                          .filter(d => d.status === 'has_different')
                          .slice(0, 5)
                          .map(d => `${d.doc_ref}: "${d.current_analsys}"`)
                          .join(', ')}
                        {tagPreview.documents.filter(d => d.status === 'has_different').length > 5 && '...'}
                      </div>
                    </div>
                  </label>
                )}

                {tagPreview.will_tag === 0 && !tagOverwrite && (
                  <div className="p-3 bg-gray-50 rounded text-sm text-gray-600">
                    No documents to update. All matching documents are already tagged.
                  </div>
                )}
              </div>
              <div className="p-4 border-t flex justify-end gap-3">
                <button
                  onClick={() => setShowTagModal(false)}
                  className="px-4 py-2 border border-gray-300 rounded text-sm hover:bg-gray-50"
                >
                  Cancel
                </button>
                <button
                  onClick={handleApplyTags}
                  disabled={isApplyingTags || (tagPreview.will_tag === 0 && !tagOverwrite)}
                  className="px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700 disabled:bg-gray-400 text-sm"
                >
                  {isApplyingTags ? 'Updating...' : `Update ${tagOverwrite ? tagPreview.will_tag + tagPreview.has_different : tagPreview.will_tag} Document(s)`}
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Save bar */}
        <div className="flex items-center justify-between p-4 border-t bg-gray-50 rounded-b-lg">
          {saveSuccess && (
            <div className="text-sm text-green-600 font-medium">Settings saved successfully</div>
          )}
          {!saveSuccess && <div />}
          <button
            onClick={saveSettings}
            disabled={isSavingSettings}
            className="px-6 py-2 bg-blue-600 text-white rounded hover:bg-blue-700 disabled:bg-gray-400"
          >
            {isSavingSettings ? 'Saving...' : 'Save Settings'}
          </button>
        </div>
      </div>

      {/* Read-only system connection panel — sourced centrally from
          env vars today, from SAM after migration. Shown for
          per-app diagnostic visibility. */}
      <div className="mt-6">
        <SystemConnectionPanel appLabel="GoCardless" />
      </div>
    </div>
  );
}
