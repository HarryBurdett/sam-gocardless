import { useState, useRef, useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { CreditCard, Upload, CheckCircle, AlertCircle, ArrowRight, X, History, Wifi, RefreshCw, Search } from 'lucide-react';
import { authFetch } from './api-shim';
import { PageHeader } from './PageHeader';
import { Alert } from './Alert';
import { GoCardlessSetupWizard } from './GoCardlessSetupWizard';

type OperaVersion = 'opera-sql' | 'opera3';

// Currency symbol helper
function getCurrencySymbol(currency?: string): string {
  switch (currency?.toUpperCase()) {
    case 'EUR': return '€';
    case 'USD': return '$';
    case 'CAD': return 'C$';
    case 'AUD': return 'A$';
    case 'GBP':
    default: return '£';
  }
}

// Searchable customer selector component
function CustomerSearch({
  customers,
  value,
  onChange
}: {
  customers: { account: string; name: string }[];
  value: string;
  onChange: (account: string, name: string) => void;
}) {
  const [search, setSearch] = useState('');
  const [isOpen, setIsOpen] = useState(false);
  const [highlightedIndex, setHighlightedIndex] = useState(0);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // Close dropdown when clicking outside
  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (wrapperRef.current && !wrapperRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  // Show all customers when no search, filter when typing
  const filtered = search
    ? customers.filter(c =>
        c.name.toLowerCase().includes(search.toLowerCase()) ||
        c.account.toLowerCase().includes(search.toLowerCase())
      ).slice(0, 20) // Limit filtered results
    : customers.slice(0, 50); // Show first 50 when browsing

  // Reset highlight when search changes
  useEffect(() => {
    setHighlightedIndex(0);
  }, [search]);

  // Scroll highlighted item into view
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
          const c = filtered[highlightedIndex];
          onChange(c.account, c.name);
          setIsOpen(false);
          setSearch('');
        }
        break;
      case 'Escape':
        setIsOpen(false);
        break;
    }
  };

  const selected = customers.find(c => c.account === value);

  return (
    <div ref={wrapperRef} className="relative">
      {value ? (
        <div className="flex items-center gap-2 p-2 border border-green-300 bg-green-50 rounded text-sm">
          <span className="flex-1 truncate">{selected?.account} - {selected?.name}</span>
          <button
            onClick={() => { onChange('', ''); setSearch(''); }}
            className="text-gray-400 hover:text-red-500"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      ) : (
        <input
          type="text"
          className="w-full p-2 border border-gray-300 rounded text-sm"
          placeholder="Click to browse or type to search..."
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
            filtered.map((c, idx) => (
              <button
                key={c.account}
                className={`w-full text-left p-2 text-sm border-b border-gray-100 ${
                  idx === highlightedIndex ? 'bg-blue-100' : 'hover:bg-blue-50'
                }`}
                onClick={() => { onChange(c.account, c.name); setIsOpen(false); setSearch(''); }}
                onMouseEnter={() => setHighlightedIndex(idx)}
              >
                <span className="font-medium">{c.account}</span> - {c.name}
              </button>
            ))
          )}
        </div>
      )}
    </div>
  );
}

interface Payment {
  customer_name: string;
  description: string;
  amount: number;
  invoice_refs: string[];
  matched_account?: string;
  matched_name?: string;
  match_score?: number;
  match_status?: 'matched' | 'review' | 'unmatched';
  possible_duplicate?: boolean;
  duplicate_warning?: string;
  gc_payment_id?: string;
  mandate_id?: string;
  [key: string]: unknown;
}

interface ParseResult {
  success: boolean;
  error?: string;
  payment_count?: number;
  gross_amount?: number;
  gocardless_fees?: number;
  vat_on_fees?: number;
  net_amount?: number;
  bank_reference?: string;
  payments?: Payment[];
}

interface Customer {
  account: string;
  name: string;
}

// Email batch from scan-emails endpoint
interface EmailBatch {
  email_id: number;
  email_subject: string;
  email_date: string;
  email_from: string;
  source?: 'email' | 'api';  // Data source: email scanning or API
  payout_id?: string;  // GoCardless payout ID (for API source)
  possible_duplicate?: boolean;
  is_value_mismatch?: boolean;  // Reference exists in Opera but value differs
  duplicate_warning?: string;
  bank_tx_warning?: string;  // Gross amount found in bank transactions
  ref_warning?: string;  // Reference already exists in cashbook
  period_valid?: boolean;
  period_error?: string;
  is_foreign_currency?: boolean;  // True if not home currency
  home_currency?: string;  // Home currency code (e.g., 'GBP')
  import_status?: string;  // ready, already_imported, archived, period_closed, needs_manual_posting, value_mismatch, review_duplicate
  import_status_message?: string;
  batch: {
    gross_amount: number;
    gocardless_fees: number;
    vat_on_fees: number;
    net_amount: number;
    bank_reference: string;
    currency?: string;  // Currency code (e.g., 'GBP', 'EUR')
    payment_date?: string;
    payment_count: number;
    payments: Payment[];
    fx_amount?: number;  // GBP equivalent for foreign currency payouts
    fx_currency?: string;  // Home currency (e.g., 'GBP')
    exchange_rate?: string;  // FX rate applied
    dest_bank_account?: string;  // Payout destination bank account number (from GoCardless)
    dest_bank_sort_code?: string;  // Payout destination bank sort code (from GoCardless)
  };
  // UI state
  isExpanded?: boolean;
  isMatching?: boolean;
  isImporting?: boolean;
  isImported?: boolean;
  isArchiving?: boolean;
  isArchived?: boolean;
  importError?: string;
  matchedPayments?: Payment[];
  archiveStatus?: string;
  postingDate?: string;  // Editable posting date for this batch
}

export function GoCardlessImport() {
  // Check if GoCardless is configured
  const { data: setupStatus, isLoading: setupLoading } = useQuery({
    queryKey: ['gcSetupStatus'],
    queryFn: async () => {
      const res = await authFetch('/api/gocardless/setup-status');
      return res.json();
    },
    staleTime: 60000,
  });

  if (setupLoading) {
    return (
      <div className="flex items-center justify-center py-20">
        <RefreshCw className="h-6 w-6 animate-spin text-gray-400" />
      </div>
    );
  }
  if (setupStatus && !setupStatus.configured) {
    return <GoCardlessSetupWizard />;
  }

  return <GoCardlessImportInner />;
}

function GoCardlessImportInner() {
  // Fetch current company for storage key isolation
  const { data: companiesData } = useQuery({
    queryKey: ['companies'],
    queryFn: async () => {
      const res = await authFetch('/api/companies');
      return res.json();
    },
  });
  const currentCompanyId = companiesData?.current_company?.id || '';

  // Fetch Opera config to determine which version to use
  const { data: operaConfigData } = useQuery({
    queryKey: ['operaConfig'],
    queryFn: async () => {
      const res = await authFetch('/api/config/opera');
      return res.json();
    },
  });
  const operaVersion: OperaVersion = operaConfigData?.version === 'opera3' ? 'opera3' : 'opera-sql';
  const opera3DataPath = operaConfigData?.opera3_server_path || operaConfigData?.opera3_base_path || '';

  const [parseResult, setParseResult] = useState<ParseResult | null>(null);
  const [matchedPayments, setMatchedPayments] = useState<Payment[]>([]);
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [isImporting, setIsImporting] = useState(false);
  const [importResult, setImportResult] = useState<{ success: boolean; message: string } | null>(null);
  const [showSuccessModal, setShowSuccessModal] = useState(false);
  const [successDetails, setSuccessDetails] = useState<{ count: number; amount: number; entryNumber: string } | null>(null);
  const [bankCode, setBankCode] = useState('');
  const [postDate, setPostDate] = useState(new Date().toISOString().split('T')[0]);
  const [completeBatch, setCompleteBatch] = useState(true);
  const [autoAllocateDisabled, setAutoAllocateDisabled] = useState<Set<number>>(new Set()); // Track rows where auto-allocate is disabled
  const [batchTypes, setBatchTypes] = useState<{ code: string; description: string }[]>([]);
  const [selectedBatchType, setSelectedBatchType] = useState('');
  const [bankAccounts, setBankAccounts] = useState<{ code: string; description: string }[]>([]);
  const [feesNominalAccount, setFeesNominalAccount] = useState('');
  const [gcBankCode, setGcBankCode] = useState('');
  const [, setTransferCbtype] = useState('');
  const [, setTransferTypes] = useState<{ code: string; description: string }[]>([]);
  const [archiveFolder, setArchiveFolder] = useState('Archive/GoCardless');

  // History state
  const [showHistory, setShowHistory] = useState(false);
  const [historyData, setHistoryData] = useState<Array<{
    id: number;
    email_subject: string;
    email_date: string;
    bank_reference: string;
    payout_id: string;
    source: 'email' | 'api';
    gross_amount: number;
    net_amount: number;
    gocardless_fees: number;
    vat_on_fees: number;
    payment_count: number;
    receipt_date: string;
    imported_by: string;
    import_date?: string;
    payments_json?: string;
  }>>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyLimit, setHistoryLimit] = useState(50);
  const [historyFromDate, setHistoryFromDate] = useState('');
  const [historyToDate, setHistoryToDate] = useState('');
  const [isClearing, setIsClearing] = useState(false);
  const [showClearConfirm, setShowClearConfirm] = useState(false);
  const [reImportRecord, setReImportRecord] = useState<{ id: number; reference: string; amount: number } | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);
  const [expandedHistoryId, setExpandedHistoryId] = useState<number | null>(null);

  // Receipt search state
  const [showReceiptSearch, setShowReceiptSearch] = useState(false);
  const [searchCustomer, setSearchCustomer] = useState('');
  const [searchFromDate, setSearchFromDate] = useState('');
  const [searchToDate, setSearchToDate] = useState('');
  const [searchResults, setSearchResults] = useState<Array<{
    import_id: number;
    receipt_date: string;
    payout_id: string;
    bank_reference: string;
    batch_ref: string;
    customer_account: string;
    customer_name: string;
    gc_customer_name: string;
    amount: number;
    currency: string;
    payment_id: string;
    invoice_ref: string;
  }>>([]);
  const [searchTotal, setSearchTotal] = useState(0);
  const [searchTotalAmount, setSearchTotalAmount] = useState(0);
  const [searchLoading, setSearchLoading] = useState(false);

  // Settings state (loaded from saved settings for import defaults)
  const [, setDataSource] = useState<'email' | 'api' | 'history'>('api');
  const [apiKeyConfigured, setApiKeyConfigured] = useState(false);
  const [apiKeyHint, setApiKeyHint] = useState('');
  const [apiSandbox, setApiSandbox] = useState(false);
  const [feesPaymentType, setFeesPaymentType] = useState('');

  // Revalidation state
  const [isRevalidating, setIsRevalidating] = useState(false);

  // Email scanning state - restore from sessionStorage on mount
  const [emailBatches, setEmailBatches] = useState<EmailBatch[]>([]);
  const [isScanning, setIsScanning] = useState(false);
  const [scanError, setScanError] = useState<string | null>(null);
  const [, setCompanyReference] = useState('');
  const [scanStats, setScanStats] = useState<{
    total_payouts: number;
    available: number;
    skipped_period_closed: number;
    skipped_duplicates: number;
    skipped_already_imported: number;
    current_period?: { year: number; period: number };
  } | null>(null);

  // Restore from company-prefixed sessionStorage when companyId is available
  useEffect(() => {
    if (!currentCompanyId) return;
    try {
      const batchKey = `gocardless_batches_${currentCompanyId}`;
      const statsKey = `gocardless_scanStats_${currentCompanyId}`;
      const savedBatches = sessionStorage.getItem(batchKey);
      const savedStats = sessionStorage.getItem(statsKey);
      if (savedBatches) setEmailBatches(JSON.parse(savedBatches));
      if (savedStats) setScanStats(JSON.parse(savedStats));
    } catch { /* ignore parse errors */ }
  }, [currentCompanyId]);

  // Persist emailBatches and scanStats to company-prefixed sessionStorage
  useEffect(() => {
    if (!currentCompanyId) return;
    if (emailBatches.length > 0) {
      sessionStorage.setItem(`gocardless_batches_${currentCompanyId}`, JSON.stringify(emailBatches));
    }
  }, [emailBatches, currentCompanyId]);

  useEffect(() => {
    if (!currentCompanyId) return;
    if (scanStats) {
      sessionStorage.setItem(`gocardless_scanStats_${currentCompanyId}`, JSON.stringify(scanStats));
    }
  }, [scanStats, currentCompanyId]);

  // Confirmation dialog state
  const [confirmBatchIndex, setConfirmBatchIndex] = useState<number | null>(null);

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

  // Fetch batch types, bank accounts, and saved settings — re-fetch when opera version changes
  useEffect(() => {
    if (!operaConfigData) return;  // Wait for config to load

    // Fetch batch types
    authFetch(gcImportUrl('/batch-types'))
      .then(res => res.json())
      .then(data => {
        if (data.success && data.batch_types) {
          setBatchTypes(data.batch_types.map((t: { code: string; description: string }) => ({
            code: t.code,
            description: t.description
          })));
        }
      })
      .catch(err => console.error('Failed to load batch types:', err));

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
          // Set first account as default if none selected
          if (data.accounts.length > 0 && !bankCode) {
            setBankCode(data.accounts[0].code);
          }
        }
      })
      .catch(err => console.error('Failed to load bank accounts:', err));

    // Fetch saved settings for defaults
    authFetch('/api/gocardless/settings')
      .then(res => res.json())
      .then(data => {
        if (data.success && data.settings) {
          if (data.settings.default_batch_type) {
            setSelectedBatchType(data.settings.default_batch_type);
          }
          if (data.settings.default_bank_code) {
            setBankCode(data.settings.default_bank_code);
          }
          if (data.settings.fees_nominal_account) {
            setFeesNominalAccount(data.settings.fees_nominal_account);
          }
          if (data.settings.company_reference) {
            setCompanyReference(data.settings.company_reference);
          }
          if (data.settings.archive_folder) {
            setArchiveFolder(data.settings.archive_folder);
          }
          if (data.settings.gocardless_bank_code) {
            setGcBankCode(data.settings.gocardless_bank_code);
          }
          if (data.settings.gocardless_transfer_cbtype) {
            setTransferCbtype(data.settings.gocardless_transfer_cbtype);
          }
          if (data.settings.api_key_configured) {
            setApiKeyConfigured(true);
            setApiKeyHint(data.settings.api_key_hint || '');
          }
          if (data.settings.api_sandbox !== undefined) {
            setApiSandbox(data.settings.api_sandbox);
          }
          if (data.settings.fees_payment_type) {
            setFeesPaymentType(data.settings.fees_payment_type);
          }
          if (data.settings.data_source) {
            setDataSource(data.settings.data_source);
          }
        }
      })
      .catch(err => console.error('Failed to load GoCardless settings:', err));

  }, [operaConfigData]);

  // Fetch import history - uses Opera 3 endpoint if configured for Opera 3
  const fetchHistory = async (limit: number = historyLimit, fromDate?: string, toDate?: string) => {
    setHistoryLoading(true);
    try {
      const params = new URLSearchParams({ limit: String(limit) });
      if (fromDate) params.append('from_date', fromDate);
      if (toDate) params.append('to_date', toDate);
      const historyUrl = operaVersion === 'opera3'
        ? `/api/opera3/gocardless/import-history?${params}`
        : `/api/gocardless/import-history?${params}`;
      const response = await authFetch(historyUrl);
      const data = await response.json();
      if (data.success) {
        setHistoryData(data.imports || []);
      }
    } catch (error) {
      console.error('Failed to fetch history:', error);
    } finally {
      setHistoryLoading(false);
    }
  };

  // Search GoCardless receipts by customer / date
  const searchReceipts = async () => {
    setSearchLoading(true);
    try {
      const params = new URLSearchParams();
      if (searchCustomer.trim()) params.append('customer', searchCustomer.trim());
      if (searchFromDate) params.append('from_date', searchFromDate);
      if (searchToDate) params.append('to_date', searchToDate);
      const searchUrl = operaVersion === 'opera3'
        ? `/api/opera3/gocardless/receipt-search?${params}`
        : `/api/gocardless/receipt-search?${params}`;
      const response = await authFetch(searchUrl);
      const data = await response.json();
      if (data.success) {
        setSearchResults(data.receipts || []);
        setSearchTotal(data.total || 0);
        setSearchTotalAmount(data.total_amount || 0);
      }
    } catch (error) {
      console.error('Failed to search receipts:', error);
    } finally {
      setSearchLoading(false);
    }
  };

  // Show clear history confirmation dialog
  const showClearHistoryConfirmation = () => {
    setShowClearConfirm(true);
  };

  // Clear import history (called after confirmation)
  const clearHistory = async () => {
    setShowClearConfirm(false);
    setIsClearing(true);
    try {
      const params = new URLSearchParams();
      if (historyFromDate) params.append('from_date', historyFromDate);
      if (historyToDate) params.append('to_date', historyToDate);
      const response = await authFetch(`/api/gocardless/import-history?${params}`, { method: 'DELETE' });
      const data = await response.json();
      if (data.success) {
        alert(`Cleared ${data.deleted_count} records`);
        fetchHistory(historyLimit, historyFromDate, historyToDate);
        fetchHistory(2); // Refresh summary
      } else {
        alert(`Error: ${data.error}`);
      }
    } catch (error) {
      console.error('Failed to clear history:', error);
      alert('Failed to clear history');
    } finally {
      setIsClearing(false);
    }
  };

  // Delete single history record to allow re-import
  const deleteHistoryRecord = async () => {
    if (!reImportRecord) return;
    setIsDeleting(true);
    try {
      const response = await authFetch(`/api/gocardless/import-history/${reImportRecord.id}`, { method: 'DELETE' });
      const data = await response.json();
      if (data.success) {
        fetchHistory(historyLimit, historyFromDate, historyToDate);
        fetchHistory(2); // Refresh summary
        setReImportRecord(null);
      } else {
        alert(`Error: ${data.error}`);
      }
    } catch (error) {
      console.error('Failed to delete history record:', error);
      alert('Failed to delete history record');
    } finally {
      setIsDeleting(false);
    }
  };

  // Fetch recent history on mount (last 2 for summary)
  useEffect(() => {
    fetchHistory(2);
  }, []);

  // Match customers for a specific email batch
  const matchBatchCustomers = async (batchIndex: number) => {
    const batch = emailBatches[batchIndex];
    if (!batch) return;

    // Update batch state to show matching
    setEmailBatches(prev => prev.map((b, i) =>
      i === batchIndex ? { ...b, isMatching: true } : b
    ));

    try {
      // Always reload customers for current company
      const custResponse = await authFetch('/api/bank-import/accounts/customers');
      const custData = await custResponse.json();
      if (custData.success && custData.accounts) {
        setCustomers(custData.accounts.map((c: { code: string; name: string }) => ({
          account: c.code,
          name: c.name
        })));
      }

      const response = await authFetch(gcImportUrl('/match-customers'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(batch.batch.payments)
      });
      const data = await response.json();

      if (data.success && data.payments) {
        setEmailBatches(prev => prev.map((b, i) =>
          i === batchIndex ? { ...b, isMatching: false, matchedPayments: data.payments } : b
        ));
      }
    } catch (error) {
      console.error('Failed to match customers:', error);
    } finally {
      setEmailBatches(prev => prev.map((b, i) =>
        i === batchIndex ? { ...b, isMatching: false } : b
      ));
    }
  };

  // Toggle batch expansion and match customers if needed
  const toggleBatch = async (batchIndex: number) => {
    const batch = emailBatches[batchIndex];
    const willExpand = !batch.isExpanded;

    // Initialize posting date from payment date or current date when expanding
    const initialPostingDate = batch.postingDate || batch.batch.payment_date || postDate;

    setEmailBatches(prev => prev.map((b, i) =>
      i === batchIndex ? { ...b, isExpanded: willExpand, postingDate: initialPostingDate } : b
    ));

    // Match customers when expanding for first time
    if (willExpand && !batch.matchedPayments?.some(p => p.match_status)) {
      await matchBatchCustomers(batchIndex);
    }
  };

  // Update posting date for a specific batch and revalidate period (client-side)
  const updateBatchPostingDate = (batchIndex: number, newDate: string) => {
    // Validate period client-side using current_period from scan
    let periodValid = true;
    let periodError: string | undefined = undefined;

    if (scanStats?.current_period && newDate) {
      const postDate = new Date(newDate);
      const postYear = postDate.getFullYear();
      const postPeriod = postDate.getMonth() + 1; // getMonth() is 0-indexed

      if (postYear !== scanStats.current_period.year || postPeriod !== scanStats.current_period.period) {
        periodValid = false;
        periodError = `Period ${postPeriod}/${postYear} is blocked. Current period is ${scanStats.current_period.period}/${scanStats.current_period.year}.`;
      }
    }

    setEmailBatches(prev => prev.map((b, i) =>
      i === batchIndex ? {
        ...b,
        postingDate: newDate,
        period_valid: periodValid,
        period_error: periodError
      } : b
    ));
  };

  // Import a specific email batch
  // Show confirmation dialog before import
  const showImportConfirmation = async (batchIndex: number) => {
    const batch = emailBatches[batchIndex];
    if (!batch || !batch.matchedPayments) return;

    // Check if customer matching has been done (matched_account will be set)
    const needsMatching = !batch.matchedPayments.some(p => p.match_status);

    if (needsMatching) {
      // Auto-trigger customer matching before showing confirmation
      // Set matching state
      setEmailBatches(prev => prev.map((b, i) =>
        i === batchIndex ? { ...b, isMatching: true } : b
      ));

      try {
        const response = await authFetch(gcImportUrl('/match-customers'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(batch.batch.payments)
        });
        const data = await response.json();

        if (data.success && data.payments) {
          // Check if all matched
          const unmatched = data.payments.filter((p: Payment) => !p.matched_account);
          if (unmatched.length > 0) {
            setEmailBatches(prev => prev.map((b, i) =>
              i === batchIndex ? { ...b, isMatching: false, isExpanded: true, matchedPayments: data.payments, importError: `${unmatched.length} payment(s) need customer accounts assigned` } : b
            ));
            return;
          }
          // All matched - update state and show confirmation
          setEmailBatches(prev => prev.map((b, i) =>
            i === batchIndex ? { ...b, isMatching: false, matchedPayments: data.payments } : b
          ));
          setConfirmBatchIndex(batchIndex);
          return;
        }
      } catch (error) {
        console.error('Failed to match customers:', error);
        setEmailBatches(prev => prev.map((b, i) =>
          i === batchIndex ? { ...b, isMatching: false, importError: 'Failed to match customers' } : b
        ));
        return;
      }
    }

    // Customer matching already done - validate all payments have matched accounts
    const unmatched = batch.matchedPayments.filter(p => !p.matched_account);
    if (unmatched.length > 0) {
      // Expand the batch to show the error and allow manual assignment
      setEmailBatches(prev => prev.map((b, i) =>
        i === batchIndex ? { ...b, isExpanded: true, importError: `${unmatched.length} payment(s) need customer accounts assigned` } : b
      ));
      return;
    }

    setConfirmBatchIndex(batchIndex);
  };

  // Cancel confirmation dialog
  const cancelImportConfirmation = () => {
    setConfirmBatchIndex(null);
  };

  // Confirm and proceed with import
  const confirmAndImport = () => {
    if (confirmBatchIndex !== null) {
      importEmailBatch(confirmBatchIndex);
      setConfirmBatchIndex(null);
    }
  };

  const importEmailBatch = async (batchIndex: number) => {
    const batch = emailBatches[batchIndex];
    if (!batch || !batch.matchedPayments) return;

    setEmailBatches(prev => prev.map((b, i) =>
      i === batchIndex ? { ...b, isImporting: true, importError: undefined } : b
    ));

    try {
      const payments = batch.matchedPayments.map((p, idx) => ({
        customer_account: p.matched_account,
        customer_name: p.customer_name || '',
        opera_customer_name: p.matched_name || '',
        amount: p.amount,
        description: p.description,
        auto_allocate: !autoAllocateDisabled.has(idx),
        gc_payment_id: p.gc_payment_id || '',
        mandate_id: p.mandate_id || '',
      }));

      // Use batch-specific posting date, fall back to global postDate
      const batchPostDate = batch.postingDate || postDate;
      // Use the actual GoCardless bank reference for better duplicate detection
      const batchReference = batch.batch.bank_reference || 'GoCardless';
      const batchSource = batch.source || 'api';
      const batchPayoutId = batch.payout_id || '';

      // Use same import endpoint for all sources - select Opera SE or Opera 3 based on config
      const baseUrl = operaVersion === 'opera3' ? '/api/opera3/gocardless/import' : '/api/gocardless/import';
      const opera3Param = operaVersion === 'opera3' && opera3DataPath ? `&data_path=${encodeURIComponent(opera3DataPath)}` : '';
      const destBankParams = batch.batch.dest_bank_account ? `&dest_bank_account=${encodeURIComponent(batch.batch.dest_bank_account)}` : '';
      const destSortParams = batch.batch.dest_bank_sort_code ? `&dest_bank_sort_code=${encodeURIComponent(batch.batch.dest_bank_sort_code)}` : '';
      const url = `${baseUrl}?bank_code=${bankCode}&post_date=${batchPostDate}&reference=${encodeURIComponent(batchReference)}&complete_batch=${completeBatch}&source=${batchSource}${batchPayoutId ? `&payout_id=${batchPayoutId}` : ''}${selectedBatchType ? `&cbtype=${selectedBatchType}` : ''}${feesNominalAccount && Math.abs(batch.batch.gocardless_fees) > 0 ? `&gocardless_fees=${Math.abs(batch.batch.gocardless_fees)}&vat_on_fees=${Math.abs(batch.batch.vat_on_fees || 0)}&fees_nominal_account=${feesNominalAccount}${feesPaymentType ? `&fees_payment_type=${feesPaymentType}` : ''}` : ''}${destBankParams}${destSortParams}${opera3Param}`;

      const response = await authFetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payments)
      });
      const data = await response.json();

      if (data.success) {
        // Archive email if this came from email source
        if (batch.source !== 'api' && batch.email_id && archiveFolder) {
          try {
            await authFetch(`/api/gocardless/archive-email?email_id=${batch.email_id}&archive_folder=${encodeURIComponent(archiveFolder)}`, {
              method: 'POST'
            });
          } catch {
            // Ignore archive errors - import was successful
          }
        }

        // Calculate total amount for the batch
        const batchTotal = batch.matchedPayments?.reduce((sum, p) => sum + (p.amount || 0), 0) || 0;

        // Show success modal
        setSuccessDetails({
          count: data.payments_imported || payments.length,
          amount: batchTotal,
          entryNumber: data.entry_number || ''
        });
        setShowSuccessModal(true);

        // Clear this batch from the list
        setEmailBatches(prev => prev.filter((_, i) => i !== batchIndex));
      } else {
        setEmailBatches(prev => prev.map((b, i) =>
          i === batchIndex ? { ...b, isImporting: false, importError: data.error } : b
        ));
      }
    } catch (error) {
      setEmailBatches(prev => prev.map((b, i) =>
        i === batchIndex ? { ...b, isImporting: false, importError: `Import failed: ${error}` } : b
      ));
    }
  };

  // Archive a duplicate batch (mark as processed without importing)
  const archiveBatch = async (batchIndex: number) => {
    const batch = emailBatches[batchIndex];
    if (!batch) return;

    setEmailBatches(prev => prev.map((b, i) =>
      i === batchIndex ? { ...b, isArchiving: true } : b
    ));

    try {
      const response = await authFetch(`/api/gocardless/archive-email?email_id=${batch.email_id}&archive_folder=${encodeURIComponent(archiveFolder)}`, {
        method: 'POST'
      });
      const data = await response.json();

      if (data.success) {
        // Remove the archived batch from the list
        setEmailBatches(prev => prev.filter((_, i) => i !== batchIndex));
        // Update stats
        if (scanStats) {
          setScanStats({
            ...scanStats,
            skipped_duplicates: Math.max(0, scanStats.skipped_duplicates - 1)
          });
        }
      } else {
        setEmailBatches(prev => prev.map((b, i) =>
          i === batchIndex ? { ...b, isArchiving: false, importError: data.error } : b
        ));
      }
    } catch (error) {
      setEmailBatches(prev => prev.map((b, i) =>
        i === batchIndex ? { ...b, isArchiving: false, importError: `Archive failed: ${error}` } : b
      ));
    }
  };

  // Skip payout to history without importing (for manual posts, foreign currency, duplicates)
  const skipToHistory = async (batchIndex: number, reason: string = 'foreign_currency') => {
    const batch = emailBatches[batchIndex];
    if (!batch || !batch.payout_id) return;

    setEmailBatches(prev => prev.map((b, i) =>
      i === batchIndex ? { ...b, isArchiving: true } : b
    ));

    try {
      const params = new URLSearchParams({
        payout_id: batch.payout_id,
        bank_reference: batch.batch.bank_reference,
        gross_amount: batch.batch.gross_amount.toString(),
        currency: batch.batch.currency || 'GBP',
        payment_count: batch.batch.payment_count.toString(),
        reason: reason
      });
      if (batch.batch.fx_amount) {
        params.set('fx_amount', batch.batch.fx_amount.toString());
      }

      const response = await authFetch(`/api/gocardless/skip-payout?${params}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(batch.batch.payments || []),
      });
      const data = await response.json();

      if (data.success) {
        // Remove the skipped batch from the list
        setEmailBatches(prev => prev.filter((_, i) => i !== batchIndex));
      } else {
        setEmailBatches(prev => prev.map((b, i) =>
          i === batchIndex ? { ...b, isArchiving: false, importError: data.error } : b
        ));
      }
    } catch (error) {
      setEmailBatches(prev => prev.map((b, i) =>
        i === batchIndex ? { ...b, isArchiving: false, importError: `Skip failed: ${error}` } : b
      ));
    }
  };

  // Scan payouts from GoCardless API
  const scanApiPayouts = async () => {
    setIsScanning(true);
    setScanError(null);
    setEmailBatches([]);
    setScanStats(null);
    if (currentCompanyId) {
      sessionStorage.removeItem(`gocardless_batches_${currentCompanyId}`);
      sessionStorage.removeItem(`gocardless_scanStats_${currentCompanyId}`);
    }

    try {
      // Always reload customers for current company (ensures correct after company switch)
      const custResponse = await authFetch('/api/bank-import/accounts/customers');
      const custData = await custResponse.json();
      if (custData.success && custData.accounts) {
        setCustomers(custData.accounts.map((c: { code: string; name: string }) => ({
          account: c.code,
          name: c.name
        })));
      }

      const response = await authFetch('/api/gocardless/api-payouts?limit=50');
      const data = await response.json();

      if (!data.success) {
        setScanError(data.error || 'Failed to fetch payouts from API');
        return;
      }

      // Use filter_stats from API if available
      const filterStats = data.filter_stats || {};
      setScanStats({
        total_payouts: filterStats.total_from_api || data.total_payouts || 0,
        available: data.total_payouts || 0,
        skipped_period_closed: filterStats.filtered_period_closed || 0,
        skipped_duplicates: filterStats.filtered_duplicate_in_opera || 0,
        skipped_already_imported: filterStats.filtered_already_in_history || 0,
        current_period: undefined
      });

      if (data.batches && data.batches.length > 0) {
        const batchesWithState = data.batches.map((b: EmailBatch) => ({
          ...b,
          isExpanded: false,
          isMatching: false,
          isImporting: false,
          isImported: false,
          matchedPayments: b.batch.payments
        }));
        setEmailBatches(batchesWithState);
      } else {
        // Build informative message showing why no payouts are available
        const parts: string[] = [];
        if (filterStats.total_from_api === 0) {
          parts.push('No payouts found from GoCardless API in the lookback period');
        } else {
          parts.push(`${filterStats.total_from_api} payout(s) found from API`);
          if (filterStats.filtered_already_in_history > 0)
            parts.push(`${filterStats.filtered_already_in_history} already imported`);
          if (filterStats.filtered_duplicate_in_opera > 0)
            parts.push(`${filterStats.filtered_duplicate_in_opera} already in cashbook`);
          if (filterStats.filtered_period_closed > 0)
            parts.push(`${filterStats.filtered_period_closed} period closed`);
          if (filterStats.filtered_error > 0)
            parts.push(`${filterStats.filtered_error} errors`);
        }
        setScanError(parts.length > 1 ? parts.join(' — ') : 'No payouts to import');
      }
    } catch (error) {
      setScanError(`Failed to fetch payouts: ${error}`);
    } finally {
      setIsScanning(false);
    }
  };

  // Revalidate existing batches against Opera (after parameter changes)
  const revalidateBatches = async () => {
    if (emailBatches.length === 0) return;

    setIsRevalidating(true);
    setScanError(null);

    try {
      const response = await authFetch('/api/gocardless/revalidate-batches', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(emailBatches)
      });
      const data = await response.json();

      if (!data.success) {
        setScanError(data.error || 'Failed to revalidate batches');
        return;
      }

      // Update batches with revalidated data, preserving UI state
      setEmailBatches(prev => data.batches.map((revalidated: EmailBatch, i: number) => ({
        ...revalidated,
        // Preserve UI state from previous batches
        isExpanded: prev[i]?.isExpanded || false,
        isMatching: prev[i]?.isMatching || false,
        isImporting: prev[i]?.isImporting || false,
        isImported: prev[i]?.isImported || false,
        matchedPayments: prev[i]?.matchedPayments || revalidated.batch.payments,
        importError: prev[i]?.importError,
        postingDate: prev[i]?.postingDate
      })));

      // Update scan stats with current period if available
      if (data.current_period) {
        setScanStats(prev => prev ? { ...prev, current_period: data.current_period } : null);
      }

    } catch (error) {
      setScanError(`Failed to revalidate: ${error}`);
    } finally {
      setIsRevalidating(false);
    }
  };

  // Update a payment's customer in a batch
  const updateBatchPayment = (batchIndex: number, paymentIndex: number, account: string, name: string) => {
    setEmailBatches(prev => prev.map((b, i) => {
      if (i !== batchIndex || !b.matchedPayments) return b;
      const newPayments = [...b.matchedPayments];
      newPayments[paymentIndex] = {
        ...newPayments[paymentIndex],
        matched_account: account,
        matched_name: name,
        match_status: account ? 'matched' : 'unmatched'
      };
      return { ...b, matchedPayments: newPayments, importError: undefined };
    }));
  };

  // Update a payment's matched account
  const updatePaymentAccount = (index: number, account: string, name: string) => {
    setMatchedPayments(prev => {
      const updated = [...prev];
      updated[index] = {
        ...updated[index],
        matched_account: account,
        matched_name: name,
        match_status: account ? 'matched' : 'unmatched'
      };
      return updated;
    });
  };

  // Import the batch
  const handleImport = async () => {
    const paymentsToImport = matchedPayments.filter(p => p.matched_account);

    if (paymentsToImport.length === 0) {
      setImportResult({ success: false, message: 'No payments have customer accounts assigned' });
      return;
    }

    setIsImporting(true);
    setImportResult(null);

    try {
      // Build URL with fees if available (including VAT element)
      const fees = parseResult?.gocardless_fees || 0;
      const vatOnFees = parseResult?.vat_on_fees || 0;
      // Select Opera SE or Opera 3 endpoint based on config
      const baseUrl = operaVersion === 'opera3' ? '/api/opera3/gocardless/import' : '/api/gocardless/import';
      const opera3Param = operaVersion === 'opera3' && opera3DataPath ? `&data_path=${encodeURIComponent(opera3DataPath)}` : '';

      let url = `${baseUrl}?bank_code=${bankCode}&post_date=${postDate}&reference=GoCardless&complete_batch=${completeBatch}&cbtype=${selectedBatchType}${opera3Param}`;
      if (fees > 0 && feesNominalAccount) {
        url += `&gocardless_fees=${fees}&vat_on_fees=${vatOnFees}&fees_nominal_account=${encodeURIComponent(feesNominalAccount)}`;
      }

      const response = await authFetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(paymentsToImport.map((p, idx) => ({
            customer_account: p.matched_account,
            amount: p.amount,
            description: p.description || p.customer_name,
            auto_allocate: !autoAllocateDisabled.has(idx),
            gc_payment_id: p.gc_payment_id || '',
            mandate_id: p.mandate_id || '',
          })))
        }
      );
      const data = await response.json();

      if (data.success) {
        // Store success details for modal
        setSuccessDetails({
          count: data.payments_imported,
          amount: paymentsToImport.reduce((sum, p) => sum + p.amount, 0),
          entryNumber: data.entry_number || ''
        });
        // Show success modal instead of inline message
        setShowSuccessModal(true);
        // Clear the inline result
        setImportResult(null);
      } else {
        setImportResult({ success: false, message: data.error || 'Import failed' });
      }
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      if (errorMsg.includes('fetch') || errorMsg.includes('network')) {
        setImportResult({ success: false, message: 'Cannot connect to server. Please check the API is running.' });
      } else {
        setImportResult({ success: false, message: `Import failed: ${errorMsg}` });
      }
    } finally {
      setIsImporting(false);
    }
  };

  // Handle success modal dismiss - clears form and refreshes data
  const handleSuccessModalDismiss = () => {
    setShowSuccessModal(false);
    setSuccessDetails(null);
    // Clear the form
    setParseResult(null);
    setMatchedPayments([]);
    setAutoAllocateDisabled(new Set());
    // Refresh history to show the new import
    fetchHistory(historyLimit);
  };

  const totalAmount = matchedPayments.reduce((sum, p) => sum + p.amount, 0);
  const matchedCount = matchedPayments.filter(p => p.matched_account).length;
  const unmatchedCount = matchedPayments.filter(p => !p.matched_account).length;

  return (
    <div className="space-y-6">
      <PageHeader icon={CreditCard} title="GoCardless Import" subtitle="Import GoCardless payouts into Opera">
        {historyData.length > 0 && (
          <div className="text-sm text-gray-600">
            <span className="font-medium">Recent:</span>
            {historyData.slice(0, 2).map((h, i) => (
              <span key={h.id} className="ml-2">
                {i > 0 && '• '}
                {new Date(h.import_date || h.email_date).toLocaleDateString()} - £{h.gross_amount?.toFixed(2) || '0.00'}
              </span>
            ))}
          </div>
        )}
        <button
          onClick={() => { setShowReceiptSearch(true); }}
          className="flex items-center gap-2 px-3 py-1.5 text-sm text-gray-600 hover:text-gray-900 hover:bg-gray-100 rounded-lg transition-colors"
        >
          <Search className="h-4 w-4" />
          Receipt Search
        </button>
        <button
          onClick={() => { setShowHistory(true); fetchHistory(historyLimit); }}
          className="flex items-center gap-2 px-3 py-1.5 text-sm text-gray-600 hover:text-gray-900 hover:bg-gray-100 rounded-lg transition-colors"
        >
          <History className="h-4 w-4" />
          History
        </button>
      </PageHeader>

      {/* Receipt Search Modal */}
      {showReceiptSearch && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
          <div className="bg-white rounded-lg shadow-xl w-full max-w-5xl max-h-[85vh] overflow-hidden">
            <div className="flex items-center justify-between p-4 border-b">
              <h2 className="text-lg font-semibold flex items-center gap-2">
                <Search className="h-5 w-5 text-blue-500" />
                GoCardless Receipt Search
              </h2>
              <button onClick={() => setShowReceiptSearch(false)} className="text-gray-400 hover:text-gray-600">
                <X className="h-5 w-5" />
              </button>
            </div>

            {/* Search Filters */}
            <div className="p-4 border-b bg-gray-50">
              <div className="flex flex-wrap items-end gap-4">
                <div className="flex-1 min-w-[200px]">
                  <label className="block text-xs font-medium text-gray-500 mb-1">Customer</label>
                  <input
                    type="text"
                    value={searchCustomer}
                    onChange={(e) => setSearchCustomer(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter') searchReceipts(); }}
                    placeholder="Name or account code..."
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-500 mb-1">From</label>
                  <input
                    type="date"
                    value={searchFromDate}
                    onChange={(e) => setSearchFromDate(e.target.value)}
                    className="px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-500 mb-1">To</label>
                  <input
                    type="date"
                    value={searchToDate}
                    onChange={(e) => setSearchToDate(e.target.value)}
                    className="px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                  />
                </div>
                <button
                  onClick={searchReceipts}
                  disabled={searchLoading}
                  className="px-4 py-2 bg-blue-600 text-white rounded-lg text-sm font-medium hover:bg-blue-700 disabled:opacity-50 transition-colors flex items-center gap-2"
                >
                  {searchLoading ? <RefreshCw className="h-4 w-4 animate-spin" /> : <Search className="h-4 w-4" />}
                  Search
                </button>
                {(searchCustomer || searchFromDate || searchToDate) && (
                  <button
                    onClick={() => { setSearchCustomer(''); setSearchFromDate(''); setSearchToDate(''); setSearchResults([]); setSearchTotal(0); setSearchTotalAmount(0); }}
                    className="px-3 py-2 text-sm text-gray-500 hover:text-gray-700 transition-colors"
                  >
                    Clear
                  </button>
                )}
              </div>
            </div>

            {/* Results */}
            <div className="overflow-auto" style={{ maxHeight: 'calc(85vh - 200px)' }}>
              {searchResults.length > 0 ? (
                <>
                  {/* Summary bar */}
                  <div className="px-4 py-2 bg-blue-50 border-b text-sm flex items-center justify-between">
                    <span className="text-blue-700 font-medium">{searchTotal} receipt{searchTotal !== 1 ? 's' : ''} found</span>
                    <span className="text-blue-600 font-semibold">Total: {getCurrencySymbol()}{searchTotalAmount.toFixed(2)}</span>
                  </div>
                  <table className="w-full text-sm">
                    <thead className="bg-gray-50 sticky top-0">
                      <tr>
                        <th className="text-left px-4 py-2.5 text-xs font-semibold text-gray-500 uppercase tracking-wider">Date</th>
                        <th className="text-left px-4 py-2.5 text-xs font-semibold text-gray-500 uppercase tracking-wider">Account</th>
                        <th className="text-left px-4 py-2.5 text-xs font-semibold text-gray-500 uppercase tracking-wider">Customer</th>
                        <th className="text-right px-4 py-2.5 text-xs font-semibold text-gray-500 uppercase tracking-wider">Amount</th>
                        <th className="text-left px-4 py-2.5 text-xs font-semibold text-gray-500 uppercase tracking-wider">Reference</th>
                        <th className="text-left px-4 py-2.5 text-xs font-semibold text-gray-500 uppercase tracking-wider">Batch</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-100">
                      {searchResults.map((r, idx) => (
                        <tr key={`${r.import_id}-${r.payment_id}-${idx}`} className="hover:bg-gray-50">
                          <td className="px-4 py-2.5 text-gray-600 whitespace-nowrap">
                            {r.receipt_date ? new Date(r.receipt_date).toLocaleDateString() : '-'}
                          </td>
                          <td className="px-4 py-2.5 font-mono text-gray-700">{r.customer_account}</td>
                          <td className="px-4 py-2.5 text-gray-800">
                            {r.customer_name}
                            {r.gc_customer_name && r.gc_customer_name !== r.customer_name && (
                              <span className="text-gray-400 text-xs ml-1">({r.gc_customer_name})</span>
                            )}
                          </td>
                          <td className="px-4 py-2.5 text-right font-medium text-gray-800">
                            {getCurrencySymbol(r.currency)}{r.amount?.toFixed(2)}
                          </td>
                          <td className="px-4 py-2.5 text-gray-500 text-xs">{r.invoice_ref || r.bank_reference || '-'}</td>
                          <td className="px-4 py-2.5 text-gray-500 text-xs">{r.batch_ref || '-'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </>
              ) : searchLoading ? (
                <div className="flex items-center justify-center py-16">
                  <RefreshCw className="h-5 w-5 animate-spin text-blue-500 mr-2" />
                  <span className="text-gray-500">Searching...</span>
                </div>
              ) : (
                <div className="flex flex-col items-center justify-center py-16 text-gray-400">
                  <Search className="h-10 w-10 mb-3 text-gray-300" />
                  <p className="text-sm">Search by customer name, account code, or date range</p>
                  <p className="text-xs mt-1">Enter search criteria above and click Search</p>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* History Modal */}
      {showHistory && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
          <div className="bg-white rounded-lg shadow-xl w-full max-w-4xl max-h-[85vh] overflow-hidden">
            <div className="flex items-center justify-between p-4 border-b">
              <h2 className="text-lg font-semibold">GoCardless Import History</h2>
              <button onClick={() => setShowHistory(false)} className="text-gray-400 hover:text-gray-600">
                <X className="h-5 w-5" />
              </button>
            </div>

            {/* Filters */}
            <div className="p-4 border-b bg-gray-50 flex flex-wrap items-end gap-4">
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">From Date</label>
                <input
                  type="date"
                  value={historyFromDate}
                  onChange={(e) => setHistoryFromDate(e.target.value)}
                  className="text-sm border border-gray-300 rounded px-2 py-1"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">To Date</label>
                <input
                  type="date"
                  value={historyToDate}
                  onChange={(e) => setHistoryToDate(e.target.value)}
                  className="text-sm border border-gray-300 rounded px-2 py-1"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">Show</label>
                <select
                  value={historyLimit}
                  onChange={(e) => setHistoryLimit(Number(e.target.value))}
                  className="text-sm border border-gray-300 rounded px-2 py-1"
                >
                  <option value={10}>Last 10</option>
                  <option value={25}>Last 25</option>
                  <option value={50}>Last 50</option>
                  <option value={100}>Last 100</option>
                </select>
              </div>
              <button
                onClick={() => fetchHistory(historyLimit, historyFromDate, historyToDate)}
                className="px-3 py-1 bg-blue-600 text-white text-sm rounded hover:bg-blue-700"
              >
                Filter
              </button>
              <button
                onClick={() => { setHistoryFromDate(''); setHistoryToDate(''); fetchHistory(historyLimit); }}
                className="px-3 py-1 bg-gray-200 text-gray-700 text-sm rounded hover:bg-gray-300"
              >
                Reset
              </button>
              <div className="flex-1" />
              <button
                onClick={showClearHistoryConfirmation}
                disabled={isClearing}
                className="px-3 py-1 bg-red-600 text-white text-sm rounded hover:bg-red-700 disabled:bg-gray-400"
              >
                {isClearing ? 'Clearing...' : 'Clear History'}
              </button>
            </div>

            <div className="overflow-y-auto max-h-[55vh] p-4">
              {historyLoading ? (
                <div className="text-center py-8 text-gray-500">Loading...</div>
              ) : historyData.length === 0 ? (
                <div className="text-center py-8 text-gray-500">No import history found</div>
              ) : (
                <table className="w-full text-sm">
                  <thead className="bg-gray-50">
                    <tr>
                      <th className="text-left p-2 font-medium text-gray-600">Date</th>
                      <th className="text-left p-2 font-medium text-gray-600">Reference</th>
                      <th className="text-center p-2 font-medium text-gray-600">Source</th>
                      <th className="text-right p-2 font-medium text-gray-600">Gross</th>
                      <th className="text-right p-2 font-medium text-gray-600">Fees</th>
                      <th className="text-right p-2 font-medium text-gray-600">VAT</th>
                      <th className="text-right p-2 font-medium text-gray-600">Net</th>
                      <th className="text-center p-2 font-medium text-gray-600">Payments</th>
                      <th className="text-center p-2 font-medium text-gray-600">Actions</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100">
                    {historyData.map((h) => {
                      // Determine currency symbol based on EUR indicator
                      const isEur = h.imported_by?.includes('EUR') || h.bank_reference?.includes('(EUR)');
                      const currencySymbol = isEur ? '€' : '£';
                      return (<>
                      <tr key={h.id} className="hover:bg-gray-50">
                        <td className="p-2 text-gray-900">{new Date(h.import_date || h.email_date).toLocaleDateString()}</td>
                        <td className="p-2 text-gray-600 font-mono text-xs">{h.bank_reference || '-'}</td>
                        <td className="p-2 text-center">
                          <span className={`px-2 py-0.5 rounded text-xs ${h.source === 'api' ? 'bg-blue-100 text-blue-700' : 'bg-purple-100 text-purple-700'}`}>
                            {h.source === 'api' ? 'API' : 'Email'}
                          </span>
                        </td>
                        <td className="p-2 text-right text-gray-900">{currencySymbol}{h.gross_amount?.toFixed(2) || '0.00'}</td>
                        <td className="p-2 text-right text-gray-500">{currencySymbol}{h.gocardless_fees?.toFixed(2) || '0.00'}</td>
                        <td className="p-2 text-right text-gray-500">{currencySymbol}{h.vat_on_fees?.toFixed(2) || '0.00'}</td>
                        <td className="p-2 text-right text-gray-600">{currencySymbol}{h.net_amount?.toFixed(2) || '0.00'}</td>
                        <td className="p-2 text-center text-gray-600">{h.payment_count || 0}</td>
                        <td className="p-2">
                          <div className="flex items-center justify-center gap-1">
                            <button
                              onClick={() => setExpandedHistoryId(expandedHistoryId === h.id ? null : h.id)}
                              className={`px-2 py-1 text-xs rounded whitespace-nowrap ${expandedHistoryId === h.id ? 'bg-blue-600 text-white' : 'bg-blue-100 text-blue-700 hover:bg-blue-200'}`}
                              title="View individual payments in this batch"
                            >
                              Review
                            </button>
                            <button
                              onClick={() => setReImportRecord({ id: h.id, reference: h.bank_reference || 'Unknown', amount: h.gross_amount || 0 })}
                              className="px-2 py-1 text-xs bg-amber-100 text-amber-700 rounded hover:bg-amber-200 whitespace-nowrap"
                              title="Remove from history to allow re-importing"
                            >
                              Re-import
                            </button>
                          </div>
                        </td>
                      </tr>
                      {expandedHistoryId === h.id && (() => {
                        let payments: Array<{ gc_customer_name?: string; customer_name?: string; opera_customer_name?: string; customer_account?: string; amount?: number; description?: string }> = [];
                        try {
                          if (h.payments_json) payments = JSON.parse(h.payments_json);
                        } catch { /* ignore parse errors */ }
                        return (
                          <tr key={`${h.id}-detail`}>
                            <td colSpan={9} className="p-0">
                              <div className="bg-blue-50 border-t border-b border-blue-200 px-4 py-3">
                                {payments.length === 0 ? (
                                  <p className="text-sm text-gray-500 italic">No payment details recorded for this batch. Re-import to capture details.</p>
                                ) : (
                                  <table className="w-full text-sm">
                                    <thead>
                                      <tr className="text-gray-600">
                                        <th className="text-left py-1 px-2 font-medium">GC Customer</th>
                                        <th className="text-left py-1 px-2 font-medium">GC Description</th>
                                        <th className="text-right py-1 px-2 font-medium">Amount</th>
                                        <th className="text-left py-1 px-2 font-medium">Opera Account</th>
                                        <th className="text-left py-1 px-2 font-medium">Opera Name</th>
                                      </tr>
                                    </thead>
                                    <tbody className="divide-y divide-blue-100">
                                      {payments.map((p, idx) => {
                                        // gc_customer_name is the new field; fall back to customer_name for older records
                                        const gcName = p.gc_customer_name || p.customer_name || '-';
                                        const operaName = p.opera_customer_name || '-';
                                        const isMismatch = p.opera_customer_name && p.gc_customer_name &&
                                          p.opera_customer_name.toLowerCase().replace(/\s+/g, '') !== p.gc_customer_name.toLowerCase().replace(/\s+/g, '');
                                        return (
                                        <tr key={idx} className={`hover:bg-blue-100/50 ${isMismatch ? 'bg-amber-50' : ''}`}>
                                          <td className="py-1 px-2">{gcName}</td>
                                          <td className="py-1 px-2 text-gray-500 text-xs">{p.description || '-'}</td>
                                          <td className="py-1 px-2 text-right">{currencySymbol}{(p.amount || 0).toFixed(2)}</td>
                                          <td className="py-1 px-2 font-mono text-xs">{p.customer_account || '-'}</td>
                                          <td className="py-1 px-2">{operaName}{isMismatch && <span className="ml-1 text-amber-600 text-xs" title="GoCardless name differs from Opera name">⚠</span>}</td>
                                        </tr>
                                        );
                                      })}
                                      <tr className="font-semibold bg-blue-100/50">
                                        <td className="py-1 px-2" colSpan={2}>Total ({payments.length} payment{payments.length !== 1 ? 's' : ''})</td>
                                        <td className="py-1 px-2 text-right">{currencySymbol}{payments.reduce((sum, p) => sum + (p.amount || 0), 0).toFixed(2)}</td>
                                        <td colSpan={2}></td>
                                      </tr>
                                    </tbody>
                                  </table>
                                )}
                              </div>
                            </td>
                          </tr>
                        );
                      })()}
                      </>);
                    })}
                  </tbody>
                </table>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Clear History Confirmation Modal */}
      {showClearConfirm && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
          <div className="bg-white rounded-lg shadow-xl max-w-md w-full mx-4 overflow-hidden">
            <div className="px-6 py-4 bg-red-600 text-white">
              <h3 className="text-lg font-semibold">Clear Import History</h3>
            </div>
            <div className="p-6">
              <p className="text-gray-700 mb-4 font-medium">
                Are you sure you want to delete import history records?
              </p>

              <div className="bg-gray-50 rounded-lg p-4 mb-4 space-y-2">
                <div className="flex justify-between">
                  <span className="text-gray-600">From Date:</span>
                  <span className="font-medium">{historyFromDate || 'Beginning of time'}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-gray-600">To Date:</span>
                  <span className="font-medium">{historyToDate || 'Now'}</span>
                </div>
                <div className="flex justify-between border-t pt-2 mt-2">
                  <span className="text-gray-600">Records to delete:</span>
                  <span className="font-medium text-red-600">
                    {!historyFromDate && !historyToDate
                      ? 'ALL records'
                      : `${historyData.length} record${historyData.length !== 1 ? 's' : ''} shown`}
                  </span>
                </div>
              </div>

              {!historyFromDate && !historyToDate && (
                <div className="p-3 bg-amber-50 border border-amber-200 rounded-lg mb-4 flex items-start gap-2">
                  <AlertCircle className="h-5 w-5 text-amber-600 flex-shrink-0 mt-0.5" />
                  <div className="text-sm">
                    <p className="font-medium text-amber-800">
                      Warning: No date range specified!
                    </p>
                    <p className="text-amber-700">
                      This will permanently delete ALL import history records.
                    </p>
                  </div>
                </div>
              )}

              <p className="text-sm text-gray-500">
                This action cannot be undone. The import history is for tracking purposes only and does not affect Opera data.
              </p>
            </div>
            <div className="px-6 py-4 bg-gray-50 flex justify-end gap-3">
              <button
                onClick={() => setShowClearConfirm(false)}
                className="px-4 py-2 text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-50"
              >
                Cancel
              </button>
              <button
                onClick={clearHistory}
                className="px-4 py-2 bg-red-600 text-white rounded-lg hover:bg-red-700 flex items-center gap-2"
              >
                <X className="h-4 w-4" />
                Delete Records
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Re-import Confirmation Modal */}
      {reImportRecord && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
          <div className="bg-white rounded-lg shadow-xl max-w-md w-full mx-4 overflow-hidden">
            <div className="px-6 py-4 bg-amber-600 text-white">
              <h3 className="text-lg font-semibold">Allow Re-import</h3>
            </div>
            <div className="p-6">
              <p className="text-gray-700 mb-4">
                Are you sure you want to allow re-importing this batch?
              </p>

              <div className="bg-gray-50 rounded-lg p-4 mb-4 space-y-2">
                <div className="flex justify-between">
                  <span className="text-gray-600">Reference:</span>
                  <span className="font-medium font-mono">{reImportRecord.reference}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-gray-600">Amount:</span>
                  <span className="font-medium">£{reImportRecord.amount.toFixed(2)}</span>
                </div>
              </div>

              <p className="text-sm text-gray-500">
                This will remove the record from import history, allowing the batch to be fetched and imported again.
                Use this after restoring Opera data when transactions need to be re-imported.
              </p>
            </div>
            <div className="px-6 py-4 bg-gray-50 flex justify-end gap-3">
              <button
                onClick={() => setReImportRecord(null)}
                disabled={isDeleting}
                className="px-4 py-2 text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-50 disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                onClick={deleteHistoryRecord}
                disabled={isDeleting}
                className="px-4 py-2 bg-amber-600 text-white rounded-lg hover:bg-amber-700 disabled:bg-gray-400 flex items-center gap-2"
              >
                {isDeleting ? (
                  <>
                    <div className="animate-spin h-4 w-4 border-2 border-white border-t-transparent rounded-full" />
                    Removing...
                  </>
                ) : (
                  <>
                    <RefreshCw className="h-4 w-4" />
                    Allow Re-import
                  </>
                )}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Step 1: Input GoCardless Data */}
      <div className="bg-white rounded-lg shadow p-6">
        <h2 className="text-lg font-semibold text-gray-900 mb-4 flex items-center gap-2">
          <span className="bg-blue-100 text-blue-700 rounded-full w-6 h-6 flex items-center justify-center text-sm">1</span>
          GoCardless Payment Data
        </h2>

        {/* API Scanning Mode - always use GoCardless API */}
        <div className="space-y-4">
            {/* Data Source Indicator */}
            <div className="flex items-center gap-2 text-sm">
                <Wifi className="h-4 w-4 text-green-600" />
                <span className="text-green-700 font-medium">Using GoCardless API</span>
                {apiSandbox && <span className="px-2 py-0.5 bg-amber-100 text-amber-700 text-xs rounded">Sandbox</span>}
            </div>

            <div className="flex items-center gap-4">
              <div className="flex-1 text-sm text-gray-600">
                {apiKeyConfigured ? (
                  <span className="text-green-600">API configured {apiKeyHint} - Fetching payouts directly from GoCardless (last 30 days)</span>
                ) : (
                  <span className="text-amber-600">API access token not configured - please add your token in Settings</span>
                )}
              </div>
              <button
                onClick={scanApiPayouts}
                disabled={isScanning || isRevalidating || !apiKeyConfigured}
                className="px-6 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:bg-gray-400"
                title={!apiKeyConfigured ? 'Configure API access token in Settings' : ''}
              >
                {isScanning ? 'Scanning...' : 'Fetch Payouts'}
              </button>
              {emailBatches.length > 0 && (
                <button
                  onClick={revalidateBatches}
                  disabled={isScanning || isRevalidating}
                  className="px-4 py-2 bg-gray-600 text-white rounded-lg hover:bg-gray-700 disabled:bg-gray-400 flex items-center gap-2"
                  title="Revalidate batches against Opera (use after changing periods or other Opera parameters)"
                >
                  <RefreshCw className={`h-4 w-4 ${isRevalidating ? 'animate-spin' : ''}`} />
                  {isRevalidating ? 'Revalidating...' : 'Rescan Opera'}
                </button>
              )}
            </div>

            {scanStats && (emailBatches.length > 0 || scanStats.skipped_already_imported > 0 || scanStats.skipped_duplicates > 0) && (
              <div className="p-3 bg-blue-50 border border-blue-200 rounded-lg text-sm">
                <div className="flex flex-wrap gap-4 text-blue-800">
                  {emailBatches.length > 0 && (
                    <span>Ready to import: {emailBatches.filter(b => !b.possible_duplicate && !b.is_value_mismatch && !b.is_foreign_currency).length}</span>
                  )}
                  {emailBatches.filter(b => b.is_value_mismatch).length > 0 && (
                    <span className="text-orange-700">Value mismatch: {emailBatches.filter(b => b.is_value_mismatch).length}</span>
                  )}
                  {scanStats.skipped_already_imported > 0 && (
                    <span className="text-green-700">Already imported: {scanStats.skipped_already_imported}</span>
                  )}
                  {scanStats.skipped_duplicates > 0 && (
                    <span className="text-amber-700">Already in cashbook: {scanStats.skipped_duplicates}</span>
                  )}
                </div>
              </div>
            )}

            {scanError && (
              <Alert variant={scanError.includes('already imported') || scanError.includes('already in cashbook') || scanError === 'No payouts to import' ? 'info' : 'error'} onDismiss={() => setScanError(null)}>{scanError}</Alert>
            )}

            {emailBatches.length > 0 && (
              <div className="space-y-4">
                <h3 className="font-medium text-gray-800">Found {emailBatches.length} GoCardless Batch{emailBatches.length !== 1 ? 'es' : ''}</h3>

                {emailBatches.map((batch, batchIndex) => (
                  <div key={batch.email_id} className={`border rounded-lg ${batch.isImported ? 'border-green-300 bg-green-50' : batch.is_value_mismatch ? 'border-orange-300 bg-orange-50' : batch.possible_duplicate ? 'border-amber-300 bg-amber-50' : batch.period_valid === false ? 'border-red-300 bg-red-50' : 'border-gray-200'}`}>
                    {/* Batch Header */}
                    <div
                      className="p-4 cursor-pointer hover:bg-gray-50 flex items-center justify-between"
                      onClick={() => toggleBatch(batchIndex)}
                    >
                      <div className="flex-1">
                        <div className="flex items-center gap-2">
                          {batch.isImported && <CheckCircle className="h-5 w-5 text-green-600" />}
                          {batch.is_value_mismatch && !batch.isImported && <span title="Value mismatch - reference exists in Opera with different amount"><AlertCircle className="h-5 w-5 text-orange-600" /></span>}
                          {batch.possible_duplicate && !batch.is_value_mismatch && !batch.isImported && <span title="Possible duplicate"><AlertCircle className="h-5 w-5 text-amber-600" /></span>}
                          {batch.period_valid === false && !batch.isImported && <span title="Period closed"><AlertCircle className="h-5 w-5 text-red-600" /></span>}
                          <span className="font-medium">{batch.email_subject || `GoCardless Payout - ${batch.batch.bank_reference || 'Unknown'}`}</span>
                        </div>
                        <div className="text-sm text-gray-500 mt-1">
                          {new Date(batch.email_date || batch.batch.payment_date || '').toLocaleDateString()} • {batch.batch.payment_count} payments •
                          Gross: {getCurrencySymbol(batch.batch.currency)}{batch.batch.gross_amount.toLocaleString(undefined, { minimumFractionDigits: 2 })} •
                          Fees: {getCurrencySymbol(batch.batch.currency)}{batch.batch.gocardless_fees.toLocaleString(undefined, { minimumFractionDigits: 2 })} •
                          Net: {getCurrencySymbol(batch.batch.currency)}{batch.batch.net_amount.toLocaleString(undefined, { minimumFractionDigits: 2 })}
                          {batch.batch.fx_amount && batch.batch.fx_currency && (
                            <span className="ml-1 font-medium text-purple-700">
                              (£{batch.batch.fx_amount.toLocaleString(undefined, { minimumFractionDigits: 2 })} GBP)
                            </span>
                          )}
                          {batch.batch.bank_reference && <span className="ml-2 text-blue-600">Ref: {batch.batch.bank_reference}</span>}
                        </div>
                        {/* Warning messages */}
                        {batch.ref_warning && !batch.isImported && (
                          <div className="text-xs text-red-600 mt-1 font-medium">
                            ⚠️ {batch.ref_warning}
                          </div>
                        )}
                        {batch.duplicate_warning && !batch.isImported && (
                          <div className="text-xs text-amber-600 mt-1">
                            ⚠️ {batch.duplicate_warning}
                          </div>
                        )}
                        {batch.bank_tx_warning && !batch.isImported && (
                          <div className="text-xs text-orange-600 mt-1">
                            ⚠️ {batch.bank_tx_warning}
                          </div>
                        )}
                        {batch.period_valid === false && !batch.isImported && (
                          <div className="text-xs text-red-600 mt-1">
                            ⚠️ {batch.period_error || 'Payment date is in a closed period'}
                          </div>
                        )}
                        {batch.is_foreign_currency && (
                          <div className="text-xs text-purple-600 mt-1 font-medium">
                            Foreign Currency ({batch.batch.currency}) - Must be posted manually to Opera
                            {batch.batch.fx_amount && (
                              <span> — Bank receives £{batch.batch.fx_amount.toLocaleString(undefined, { minimumFractionDigits: 2 })} GBP
                              {batch.batch.exchange_rate && ` (rate: ${parseFloat(batch.batch.exchange_rate).toFixed(4)})`}
                              </span>
                            )}
                          </div>
                        )}
                        {gcBankCode && gcBankCode !== bankCode && !batch.isImported && (
                          <div className="text-xs text-blue-600 mt-1">
                            {gcBankCode} → {bankCode} (auto-transfer net {getCurrencySymbol(batch.batch.currency)}{batch.batch.net_amount.toLocaleString(undefined, { minimumFractionDigits: 2 })})
                          </div>
                        )}
                      </div>
                      <div className="text-gray-400">
                        {batch.isExpanded ? '▼' : '▶'}
                      </div>
                    </div>

                    {/* Batch Details (Expanded) */}
                    {batch.isExpanded && (
                      <div className="border-t border-gray-200 p-4 space-y-4">
                        {/* Summary */}
                        <div className="grid grid-cols-5 gap-4 text-sm">
                          <div className="p-2 bg-gray-50 rounded">
                            <div className="text-gray-500">Gross</div>
                            <div className="font-semibold">{getCurrencySymbol(batch.batch.currency)}{batch.batch.gross_amount.toLocaleString(undefined, { minimumFractionDigits: 2 })}</div>
                          </div>
                          <div className="p-2 bg-gray-50 rounded">
                            <div className="text-gray-500">Fees</div>
                            <div className="font-semibold text-red-600">{getCurrencySymbol(batch.batch.currency)}{Math.abs(batch.batch.gocardless_fees).toLocaleString(undefined, { minimumFractionDigits: 2 })}</div>
                          </div>
                          <div className="p-2 bg-gray-50 rounded">
                            <div className="text-gray-500">VAT</div>
                            <div className="font-semibold text-red-600">{getCurrencySymbol(batch.batch.currency)}{Math.abs(batch.batch.vat_on_fees).toLocaleString(undefined, { minimumFractionDigits: 2 })}</div>
                          </div>
                          <div className="p-2 bg-blue-50 rounded">
                            <div className="text-gray-500">Net</div>
                            <div className="font-semibold text-blue-600">{getCurrencySymbol(batch.batch.currency)}{batch.batch.net_amount.toLocaleString(undefined, { minimumFractionDigits: 2 })}</div>
                          </div>
                          <div className={`p-2 rounded ${batch.period_valid === false ? 'bg-red-50' : 'bg-green-50'}`}>
                            <div className="text-gray-500 flex items-center gap-1">
                              Posting Date
                              {batch.postingDate && batch.postingDate !== batch.batch.payment_date && (
                                <span className="text-xs text-amber-600 font-medium">(edited)</span>
                              )}
                            </div>
                            <input
                              type="date"
                              className={`w-full p-1 border rounded text-sm font-semibold ${batch.period_valid === false ? 'border-red-300 text-red-600' : 'border-green-300 text-green-600'}`}
                              value={batch.postingDate || batch.batch.payment_date || ''}
                              onChange={(e) => updateBatchPostingDate(batchIndex, e.target.value)}
                            />
                            {batch.period_valid === false ? (
                              <button
                                onClick={() => updateBatchPostingDate(batchIndex, new Date().toISOString().split('T')[0])}
                                className="text-xs text-red-600 hover:text-red-800 mt-1 underline"
                              >
                                Period closed - Reset to today
                              </button>
                            ) : batch.batch.payment_date && batch.postingDate !== batch.batch.payment_date ? (
                              <button
                                onClick={() => updateBatchPostingDate(batchIndex, batch.batch.payment_date!)}
                                className="text-xs text-blue-600 hover:text-blue-800 mt-1"
                              >
                                Reset to email date
                              </button>
                            ) : null}
                          </div>
                        </div>

                        {/* Duplicate Warning */}
                        {batch.matchedPayments?.some(p => p.possible_duplicate) && (
                          <div className="p-3 bg-amber-50 border border-amber-200 rounded-lg flex items-start gap-2">
                            <AlertCircle className="h-5 w-5 text-amber-600 flex-shrink-0 mt-0.5" />
                            <div className="text-sm">
                              <p className="font-medium text-amber-800">
                                Possible duplicates detected
                              </p>
                              <p className="text-amber-700">
                                {batch.matchedPayments.filter(p => p.possible_duplicate).length} payment(s) may have already been imported.
                                Check highlighted rows below before importing.
                              </p>
                            </div>
                          </div>
                        )}

                        {/* Payments Table */}
                        {batch.isMatching ? (
                          <div className="text-center py-4 text-gray-500">
                            <div className="animate-spin h-6 w-6 border-2 border-blue-600 border-t-transparent rounded-full mx-auto mb-2" />
                            Matching customers...
                          </div>
                        ) : (
                          <table className="w-full text-sm">
                            <thead className="bg-gray-50">
                              <tr>
                                <th className="text-left p-2">Customer Name</th>
                                <th className="text-left p-2">Description</th>
                                <th className="text-right p-2">Amount</th>
                                <th className="text-left p-2 w-64">Opera Account</th>
                                <th className="text-center p-2 w-20" title="Auto-allocate receipt to outstanding invoices">Auto-Alloc</th>
                              </tr>
                            </thead>
                            <tbody>
                              {(batch.matchedPayments || batch.batch.payments).map((payment, paymentIndex) => (
                                <tr key={paymentIndex} className={`border-t ${payment.possible_duplicate ? 'bg-amber-50' : ''}`}>
                                  <td className="p-2">
                                    {payment.customer_name}
                                    {payment.possible_duplicate && (
                                      <div className="text-xs text-amber-600 flex items-center gap-1 mt-1">
                                        <AlertCircle className="h-3 w-3" />
                                        {payment.duplicate_warning || 'May have been imported before'}
                                      </div>
                                    )}
                                  </td>
                                  <td className="p-2 text-gray-600">{payment.description}</td>
                                  <td className="p-2 text-right font-mono">{getCurrencySymbol(batch.batch.currency)}{payment.amount.toLocaleString(undefined, { minimumFractionDigits: 2 })}</td>
                                  <td className="p-2">
                                    <CustomerSearch
                                      customers={customers}
                                      value={payment.matched_account || ''}
                                      onChange={(account, name) => updateBatchPayment(batchIndex, paymentIndex, account, name)}
                                    />
                                  </td>
                                  <td className="p-2 text-center">
                                    <input
                                      type="checkbox"
                                      checked={!autoAllocateDisabled.has(paymentIndex)}
                                      onChange={(e) => {
                                        const newSet = new Set(autoAllocateDisabled);
                                        if (e.target.checked) {
                                          newSet.delete(paymentIndex);
                                        } else {
                                          newSet.add(paymentIndex);
                                        }
                                        setAutoAllocateDisabled(newSet);
                                      }}
                                      className="h-4 w-4 text-blue-600 rounded border-gray-300 focus:ring-blue-500"
                                      title={autoAllocateDisabled.has(paymentIndex) ? 'Auto-allocate disabled - will post on account' : 'Auto-allocate enabled - will allocate to invoices'}
                                    />
                                  </td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        )}

                        {/* Import Button */}
                        {!batch.isImported && (
                          <div className="flex items-center justify-between pt-4 border-t">
                            {batch.importError && (
                              <div className="text-red-600 text-sm flex items-center gap-2">
                                <AlertCircle className="h-4 w-4" />
                                {batch.importError}
                              </div>
                            )}
                            {batch.period_valid === false && !batch.importError && (
                              <div className="text-red-600 text-sm flex items-center gap-2">
                                <AlertCircle className="h-4 w-4" />
                                Cannot import: {batch.period_error || 'Posting date is in a closed period'}
                              </div>
                            )}
                            <div className="flex-1" />
                            <div className="flex items-center gap-2">
                              {/* Archive button for email duplicates */}
                              {batch.possible_duplicate && !batch.is_foreign_currency && !batch.isImported && batch.source !== 'api' && (
                                <button
                                  onClick={() => archiveBatch(batchIndex)}
                                  disabled={batch.isArchiving}
                                  className="px-4 py-2 text-white rounded-lg disabled:bg-gray-400 flex items-center gap-2 bg-amber-500 hover:bg-amber-600"
                                  title="Archive this email - already posted to Opera"
                                >
                                  {batch.isArchiving ? (
                                    <>
                                      <div className="animate-spin h-4 w-4 border-2 border-white border-t-transparent rounded-full" />
                                      Archiving...
                                    </>
                                  ) : (
                                    <>
                                      <X className="h-4 w-4" />
                                      Archive (Already Posted)
                                    </>
                                  )}
                                </button>
                              )}
                              {/* Skip button for API duplicates */}
                              {batch.possible_duplicate && !batch.is_foreign_currency && !batch.isImported && batch.source === 'api' && (
                                <button
                                  onClick={() => skipToHistory(batchIndex)}
                                  disabled={batch.isArchiving}
                                  className="px-4 py-2 text-white rounded-lg disabled:bg-gray-400 flex items-center gap-2 bg-amber-500 hover:bg-amber-600"
                                  title="Skip this payout - already posted to Opera"
                                >
                                  {batch.isArchiving ? (
                                    <>
                                      <div className="animate-spin h-4 w-4 border-2 border-white border-t-transparent rounded-full" />
                                      Skipping...
                                    </>
                                  ) : (
                                    <>
                                      <X className="h-4 w-4" />
                                      Skip (Already Posted)
                                    </>
                                  )}
                                </button>
                              )}
                              {/* Send to History button for foreign currency batches */}
                              {batch.is_foreign_currency && !batch.isImported && (
                                <button
                                  onClick={() => batch.source === 'api' ? skipToHistory(batchIndex, 'foreign_currency') : archiveBatch(batchIndex)}
                                  disabled={batch.isArchiving}
                                  className="px-4 py-2 text-white rounded-lg disabled:bg-gray-400 flex items-center gap-2 bg-purple-500 hover:bg-purple-600"
                                  title="Send to history - foreign currency needs manual posting in Opera"
                                >
                                  {batch.isArchiving ? (
                                    <>
                                      <div className="animate-spin h-4 w-4 border-2 border-white border-t-transparent rounded-full" />
                                      Sending...
                                    </>
                                  ) : (
                                    <>
                                      <History className="h-4 w-4" />
                                      Send to History (Manual Post)
                                    </>
                                  )}
                                </button>
                              )}
                              {/* Skip to History button for any non-foreign-currency batch (manually entered, etc.) */}
                              {!batch.is_foreign_currency && !batch.isImported && !batch.possible_duplicate && (
                                <button
                                  onClick={() => skipToHistory(batchIndex, 'manual')}
                                  disabled={batch.isArchiving}
                                  className="px-3 py-2 text-gray-600 rounded-lg disabled:bg-gray-400 flex items-center gap-2 border border-gray-300 hover:bg-gray-100 text-sm"
                                  title="Skip import - batch was already entered manually in Opera"
                                >
                                  {batch.isArchiving ? (
                                    <>
                                      <div className="animate-spin h-4 w-4 border-2 border-gray-400 border-t-transparent rounded-full" />
                                      Skipping...
                                    </>
                                  ) : (
                                    <>
                                      <History className="h-4 w-4" />
                                      Skip to History
                                    </>
                                  )}
                                </button>
                              )}
                              <button
                                onClick={() => showImportConfirmation(batchIndex)}
                                disabled={batch.isImporting || batch.period_valid === false || batch.is_foreign_currency}
                                className="px-4 py-2 bg-green-600 text-white rounded-lg hover:bg-green-700 disabled:bg-gray-400 disabled:cursor-not-allowed flex items-center gap-2"
                                title={batch.is_foreign_currency ? `Foreign currency (${batch.batch.currency}) cannot be imported` : batch.period_valid === false ? 'Change posting date to a valid period' : batch.possible_duplicate ? 'Possible duplicate - review before importing' : ''}
                              >
                                {batch.isImporting ? (
                                  <>
                                    <div className="animate-spin h-4 w-4 border-2 border-white border-t-transparent rounded-full" />
                                    Importing...
                                  </>
                                ) : batch.is_foreign_currency ? (
                                  <>
                                    🌍 Foreign Currency
                                  </>
                                ) : (
                                  <>
                                    <ArrowRight className="h-4 w-4" />
                                    Import This Batch
                                  </>
                                )}
                              </button>
                            </div>
                          </div>
                        )}

                        {batch.isImported && (
                          <div className="space-y-1">
                            <div className="text-green-600 font-medium flex items-center gap-2">
                              <CheckCircle className="h-5 w-5" />
                              Successfully imported to Opera
                            </div>
                            {batch.archiveStatus && (
                              <div className={`text-sm ${batch.archiveStatus === 'archived' ? 'text-green-600' : 'text-amber-600'}`}>
                                {batch.archiveStatus === 'archived'
                                  ? `Email archived to ${archiveFolder}`
                                  : `Archive: ${batch.archiveStatus}`}
                              </div>
                            )}
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
        </div>
      </div>

      {/* Parse Error */}
      {parseResult && !parseResult.success && (
        <div className="bg-red-50 border border-red-200 rounded-lg p-4 flex items-start gap-3">
          <AlertCircle className="h-5 w-5 text-red-500 flex-shrink-0 mt-0.5" />
          <div>
            <p className="font-medium text-red-800">Failed to parse</p>
            <p className="text-sm text-red-600">{parseResult.error}</p>
          </div>
        </div>
      )}

      {/* Step 2: Review & Match */}
      {matchedPayments.length > 0 && (
        <div className="bg-white rounded-lg shadow p-6">
          <h2 className="text-lg font-semibold text-gray-900 mb-4 flex items-center gap-2">
            <span className="bg-blue-100 text-blue-700 rounded-full w-6 h-6 flex items-center justify-center text-sm">2</span>
            Review & Match Customers
          </h2>

          {/* Summary */}
          <div className="grid grid-cols-4 gap-4 mb-6">
            <div className="bg-gray-50 rounded-lg p-3 text-center">
              <p className="text-2xl font-bold text-gray-900">{matchedPayments.length}</p>
              <p className="text-sm text-gray-500">Payments</p>
            </div>
            <div className="bg-green-50 rounded-lg p-3 text-center">
              <p className="text-2xl font-bold text-green-600">{matchedCount}</p>
              <p className="text-sm text-gray-500">Matched</p>
            </div>
            <div className="bg-yellow-50 rounded-lg p-3 text-center">
              <p className="text-2xl font-bold text-yellow-600">{unmatchedCount}</p>
              <p className="text-sm text-gray-500">Need Review</p>
            </div>
            <div className="bg-blue-50 rounded-lg p-3 text-center">
              <p className="text-2xl font-bold text-blue-600">
                £{totalAmount.toLocaleString('en-GB', { minimumFractionDigits: 2 })}
              </p>
              <p className="text-sm text-gray-500">Total</p>
            </div>
          </div>

          {/* GoCardless Summary */}
          {parseResult && parseResult.gocardless_fees !== undefined && parseResult.gocardless_fees !== 0 && (
            <div className="mb-4 p-3 bg-gray-50 rounded-lg text-sm">
              <div className="flex justify-between">
                <span>Gross Amount:</span>
                <span className="font-medium">£{parseResult.gross_amount?.toLocaleString('en-GB', { minimumFractionDigits: 2 })}</span>
              </div>
              <div className="flex justify-between text-red-600">
                <span>GoCardless Fees:</span>
                <span>-£{Math.abs(parseResult.gocardless_fees || 0).toLocaleString('en-GB', { minimumFractionDigits: 2 })}</span>
              </div>
              {parseResult.vat_on_fees !== undefined && parseResult.vat_on_fees !== 0 && (
                <div className="flex justify-between text-red-600">
                  <span>VAT on Fees:</span>
                  <span>-£{Math.abs(parseResult.vat_on_fees).toLocaleString('en-GB', { minimumFractionDigits: 2 })}</span>
                </div>
              )}
              <div className="flex justify-between font-medium border-t pt-1 mt-1">
                <span>Net Amount:</span>
                <span>£{parseResult.net_amount?.toLocaleString('en-GB', { minimumFractionDigits: 2 })}</span>
              </div>
              <p className="text-xs text-gray-500 mt-2">
                Note: Fees and VAT should be posted separately as a nominal entry in Opera cashbook.
              </p>
            </div>
          )}

          {/* Payments Table */}
          <div>
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-gray-50">
                  <th className="text-left p-3 font-medium text-gray-700">Customer (from email)</th>
                  <th className="text-left p-3 font-medium text-gray-700">Description</th>
                  <th className="text-right p-3 font-medium text-gray-700">Amount</th>
                  <th className="text-left p-3 font-medium text-gray-700">Opera Account</th>
                  <th className="text-center p-3 font-medium text-gray-700 w-20" title="Auto-allocate receipt to outstanding invoices">Auto-Alloc</th>
                  <th className="text-center p-3 font-medium text-gray-700">Status</th>
                </tr>
              </thead>
              <tbody>
                {matchedPayments.map((payment, idx) => (
                  <tr key={idx} className={`border-b ${!payment.matched_account ? 'bg-yellow-50' : ''}`}>
                    <td className="p-3">
                      <div className="font-medium">{payment.customer_name}</div>
                      {payment.invoice_refs && payment.invoice_refs.length > 0 && (
                        <div className="text-xs text-gray-500">
                          Refs: {payment.invoice_refs.join(', ')}
                        </div>
                      )}
                    </td>
                    <td className="p-3 text-gray-600">{payment.description}</td>
                    <td className="p-3 text-right font-medium">
                      £{payment.amount.toLocaleString('en-GB', { minimumFractionDigits: 2 })}
                    </td>
                    <td className="p-3">
                      <CustomerSearch
                        customers={customers}
                        value={payment.matched_account || ''}
                        onChange={(account, name) => updatePaymentAccount(idx, account, name)}
                      />
                    </td>
                    <td className="p-3 text-center">
                      <input
                        type="checkbox"
                        checked={!autoAllocateDisabled.has(idx)}
                        onChange={(e) => {
                          const newSet = new Set(autoAllocateDisabled);
                          if (e.target.checked) {
                            newSet.delete(idx);
                          } else {
                            newSet.add(idx);
                          }
                          setAutoAllocateDisabled(newSet);
                        }}
                        className="h-4 w-4 text-blue-600 rounded border-gray-300 focus:ring-blue-500"
                        title={autoAllocateDisabled.has(idx) ? 'Auto-allocate disabled - will post on account' : 'Auto-allocate enabled - will allocate to invoices'}
                      />
                    </td>
                    <td className="p-3 text-center">
                      {payment.matched_account ? (
                        <span className="inline-flex items-center gap-1 px-2 py-1 bg-green-100 text-green-700 rounded-full text-xs">
                          <CheckCircle className="h-3 w-3" />
                          Matched
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1 px-2 py-1 bg-yellow-100 text-yellow-700 rounded-full text-xs">
                          <AlertCircle className="h-3 w-3" />
                          Select
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Step 3: Import */}
      {matchedPayments.length > 0 && (
        <div className="bg-white rounded-lg shadow p-6">
          <h2 className="text-lg font-semibold text-gray-900 mb-4 flex items-center gap-2">
            <span className="bg-blue-100 text-blue-700 rounded-full w-6 h-6 flex items-center justify-center text-sm">3</span>
            Import to Opera
          </h2>

          <div className="grid grid-cols-4 gap-4 mb-6">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                {gcBankCode && gcBankCode !== bankCode ? 'Destination Bank' : 'Bank Account'}
              </label>
              <select
                className="w-full p-2 border border-gray-300 rounded"
                value={bankCode}
                onChange={(e) => setBankCode(e.target.value)}
              >
                {bankAccounts.length === 0 ? (
                  <option value="">Loading bank accounts...</option>
                ) : (
                  bankAccounts.map(acc => (
                    <option key={acc.code} value={acc.code}>{acc.code} - {acc.description}</option>
                  ))
                )}
              </select>
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Posting Date</label>
              <input
                type="date"
                className="w-full p-2 border border-gray-300 rounded"
                value={postDate}
                onChange={(e) => setPostDate(e.target.value)}
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Cashbook Type</label>
              <select
                className="w-full p-2 border border-gray-300 rounded"
                value={selectedBatchType}
                onChange={(e) => setSelectedBatchType(e.target.value)}
              >
                {batchTypes.length === 0 ? (
                  <option value="">No batched receipt types available</option>
                ) : (
                  batchTypes.map(t => (
                    <option key={t.code} value={t.code}>{t.code} - {t.description}</option>
                  ))
                )}
              </select>
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Batch Status</label>
              <select
                className="w-full p-2 border border-gray-300 rounded"
                value={completeBatch ? 'complete' : 'review'}
                onChange={(e) => setCompleteBatch(e.target.value === 'complete')}
              >
                <option value="review">Leave for Review (incomplete)</option>
                <option value="complete">Complete Immediately</option>
              </select>
            </div>
          </div>

          <div className="grid grid-cols-4 gap-4 mb-6">
            <div className="col-span-2">
              <label className="block text-sm font-medium text-gray-700 mb-1">Email Archive Folder</label>
              <input
                type="text"
                className="w-full p-2 border border-gray-300 rounded"
                placeholder="Archive/GoCardless"
                value={archiveFolder}
                onChange={(e) => setArchiveFolder(e.target.value)}
              />
              <p className="text-xs text-gray-500 mt-1">Imported emails will be moved to this folder</p>
            </div>
          </div>

          {gcBankCode && gcBankCode !== bankCode && (
            <div className="mb-4 p-3 bg-blue-50 border border-blue-200 rounded-lg text-sm text-blue-800">
              Receipts + fees → <strong>{gcBankCode}</strong> (GC Control) → net payout transfers to <strong>{bankCode}</strong>
            </div>
          )}

          {unmatchedCount > 0 && (
            <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded-lg flex items-start gap-2">
              <AlertCircle className="h-5 w-5 text-red-500 flex-shrink-0 mt-0.5" />
              <div className="text-sm">
                <p className="font-medium text-red-800">
                  Cannot import: {unmatchedCount} payment(s) don't have customer accounts assigned
                </p>
                <p className="text-red-700">
                  All payments must have a customer account selected before importing.
                </p>
                <p className="text-red-600 mt-1 text-xs">
                  💡 Tip: If you've added or updated customers in Opera, use the "Rescan Opera" button to refresh matching.
                </p>
              </div>
            </div>
          )}

          {!postDate && (
            <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded-lg flex items-start gap-2">
              <AlertCircle className="h-5 w-5 text-red-500 flex-shrink-0 mt-0.5" />
              <p className="text-sm font-medium text-red-800">Posting date is required</p>
            </div>
          )}

          {!selectedBatchType && (
            <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded-lg flex items-start gap-2">
              <AlertCircle className="h-5 w-5 text-red-500 flex-shrink-0 mt-0.5" />
              <p className="text-sm font-medium text-red-800">Cashbook Type is required - select one above or set a default in Settings</p>
            </div>
          )}

          {importResult && (
            <div className={`mb-4 p-3 rounded-lg flex items-start gap-2 ${
              importResult.success ? 'bg-green-50 border border-green-200' : 'bg-red-50 border border-red-200'
            }`}>
              {importResult.success ? (
                <CheckCircle className="h-5 w-5 text-green-500 flex-shrink-0 mt-0.5" />
              ) : (
                <AlertCircle className="h-5 w-5 text-red-500 flex-shrink-0 mt-0.5" />
              )}
              <p className={`text-sm font-medium ${importResult.success ? 'text-green-800' : 'text-red-800'}`}>
                {importResult.message}
              </p>
            </div>
          )}

          {/* Debug: show why button might be disabled */}
          {(unmatchedCount > 0 || !postDate || !bankCode || !selectedBatchType) && (
            <div className="mb-2 text-xs text-gray-500">
              Import blocked: {unmatchedCount > 0 ? `${unmatchedCount} unmatched, ` : ''}{!postDate ? 'no date, ' : ''}{!bankCode ? 'no bank, ' : ''}{!selectedBatchType ? 'no cashbook type' : ''}
            </div>
          )}

          <div className="flex justify-end">
            <button
              onClick={handleImport}
              disabled={isImporting || unmatchedCount > 0 || !postDate || !bankCode || !selectedBatchType}
              className="flex items-center gap-2 px-6 py-2 bg-green-600 text-white rounded-lg hover:bg-green-700 disabled:bg-gray-400 disabled:cursor-not-allowed"
            >
              {isImporting ? (
                <>
                  <div className="animate-spin h-4 w-4 border-2 border-white border-t-transparent rounded-full" />
                  Importing...
                </>
              ) : (
                <>
                  <Upload className="h-4 w-4" />
                  Import {matchedPayments.length} Payment{matchedPayments.length !== 1 ? 's' : ''} to Opera
                  <ArrowRight className="h-4 w-4" />
                </>
              )}
            </button>
          </div>
        </div>
      )}

      {/* Import Confirmation Dialog */}
      {confirmBatchIndex !== null && emailBatches[confirmBatchIndex] && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
          <div className="bg-white rounded-lg shadow-xl max-w-lg w-full mx-4 overflow-hidden">
            <div className="px-6 py-4 bg-blue-600 text-white">
              <h3 className="text-lg font-semibold">Confirm Import to Opera</h3>
            </div>
            <div className="p-6">
              <p className="text-gray-700 mb-4">
                You are about to import the following GoCardless batch into Opera:
              </p>

              <div className="bg-gray-50 rounded-lg p-4 mb-4 space-y-2">
                <div className="flex justify-between">
                  <span className="text-gray-600">{emailBatches[confirmBatchIndex].source === 'api' ? 'Payout Reference:' : 'Email Subject:'}</span>
                  <span className="font-medium text-sm">{emailBatches[confirmBatchIndex].email_subject || emailBatches[confirmBatchIndex].batch.bank_reference || 'N/A'}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-gray-600">Payments:</span>
                  <span className="font-medium">{emailBatches[confirmBatchIndex].batch.payment_count}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-gray-600">Net Amount:</span>
                  <span className="font-medium text-green-600">
                    {getCurrencySymbol(emailBatches[confirmBatchIndex].batch.currency)}{emailBatches[confirmBatchIndex].batch.net_amount.toLocaleString(undefined, { minimumFractionDigits: 2 })}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-gray-600">Bank Reference:</span>
                  <span className="font-medium">{emailBatches[confirmBatchIndex].batch.bank_reference}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-gray-600">Post Date:</span>
                  <span className="font-medium">{postDate}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-gray-600">Bank Account:</span>
                  <span className="font-medium">{bankCode}</span>
                </div>
              </div>

              {/* Duplicate Warning in Confirmation */}
              {emailBatches[confirmBatchIndex].matchedPayments?.some(p => p.possible_duplicate) && (
                <div className="p-3 bg-red-50 border border-red-200 rounded-lg mb-4 flex items-start gap-2">
                  <AlertCircle className="h-5 w-5 text-red-600 flex-shrink-0 mt-0.5" />
                  <div className="text-sm">
                    <p className="font-medium text-red-800">
                      Warning: Possible duplicates detected!
                    </p>
                    <p className="text-red-700">
                      {emailBatches[confirmBatchIndex].matchedPayments?.filter(p => p.possible_duplicate).length} payment(s) may have already been imported to Opera.
                      Proceed with caution.
                    </p>
                  </div>
                </div>
              )}

              <div className="border-t pt-4 mb-4">
                <p className="text-sm font-medium text-gray-700 mb-2">Payments to post:</p>
                <div className="max-h-40 overflow-y-auto">
                  <table className="w-full text-sm">
                    <tbody>
                      {emailBatches[confirmBatchIndex].matchedPayments?.map((p, idx) => (
                        <tr key={idx} className={`border-b border-gray-100 ${p.possible_duplicate ? 'bg-amber-50' : ''}`}>
                          <td className="py-1">
                            {p.matched_name || p.customer_name}
                            {p.possible_duplicate && (
                              <span className="text-xs text-amber-600 ml-2">(possible duplicate)</span>
                            )}
                          </td>
                          <td className="py-1 text-right font-mono">{getCurrencySymbol(emailBatches[confirmBatchIndex].batch.currency)}{p.amount.toLocaleString(undefined, { minimumFractionDigits: 2 })}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>

              <p className="text-sm text-amber-600 mb-4">
                This will create receipt entries in the Opera cashbook. This action cannot be undone.
              </p>
            </div>
            <div className="px-6 py-4 bg-gray-50 flex justify-end gap-3">
              <button
                onClick={cancelImportConfirmation}
                className="px-4 py-2 text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-50"
              >
                Cancel
              </button>
              <button
                onClick={confirmAndImport}
                className="px-4 py-2 bg-green-600 text-white rounded-lg hover:bg-green-700 flex items-center gap-2"
              >
                <CheckCircle className="h-4 w-4" />
                Confirm Import
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Success Modal - shows after successful import */}
      {showSuccessModal && successDetails && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
          <div className="bg-white rounded-lg shadow-xl max-w-md w-full mx-4 overflow-hidden">
            <div className="px-6 py-4 bg-green-600 text-white flex items-center gap-3">
              <CheckCircle className="h-6 w-6" />
              <h3 className="text-lg font-semibold">Import Successful</h3>
            </div>
            <div className="p-6">
              <div className="text-center mb-6">
                <div className="w-16 h-16 bg-green-100 rounded-full flex items-center justify-center mx-auto mb-4">
                  <CheckCircle className="h-10 w-10 text-green-600" />
                </div>
                <p className="text-lg text-gray-800 font-medium">
                  {successDetails.count} payment{successDetails.count !== 1 ? 's' : ''} imported successfully
                </p>
                <p className="text-2xl font-bold text-green-600 mt-2">
                  £{successDetails.amount.toFixed(2)}
                </p>
                {successDetails.entryNumber && (
                  <p className="text-sm text-gray-500 mt-2">
                    Entry: {successDetails.entryNumber}
                  </p>
                )}
              </div>

              <div className="bg-gray-50 rounded-lg p-3 text-sm text-gray-600 mb-4">
                {completeBatch ? (
                  <p>✓ Batch completed and posted to Opera</p>
                ) : (
                  <p>✓ Batch created - pending review in Opera cashbook</p>
                )}
              </div>
            </div>
            <div className="px-6 py-4 bg-gray-50 flex justify-center">
              <button
                onClick={handleSuccessModalDismiss}
                className="px-8 py-2.5 bg-green-600 text-white rounded-lg hover:bg-green-700 font-medium"
              >
                OK
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
