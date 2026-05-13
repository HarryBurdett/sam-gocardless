import { useState, useEffect, useRef } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  CreditCard, CheckCircle, AlertCircle, Clock, RefreshCw, Plus,
  Send, X, Link, FileText, Users, Ban, History, Search,
  Pause, Play, Mail, ExternalLink
} from 'lucide-react';
import type { ReactNode } from 'react';
import { authFetch } from './api-shim';
import { PageHeader } from './PageHeader';
import { Alert } from './Alert';
import { GoCardlessSetupWizard } from './GoCardlessSetupWizard';

// Minimal Card surface used throughout this page — same shape as the
// legacy components/ui/Card so we don't have to mass-edit every usage.
function Card({
  className = '',
  padding = true,
  children,
}: {
  className?: string;
  padding?: boolean;
  children?: ReactNode;
}) {
  return (
    <div
      className={`bg-white rounded-xl shadow-sm border border-gray-200 ${padding ? 'p-4' : ''} ${className}`}
    >
      {children}
    </div>
  );
}

// Searchable customer dropdown component — uses React Query (same pattern as SalesOrders)
async function fetchCustomerSearch(search: string): Promise<Array<{account: string; name: string; postcode?: string}>> {
  // Standalone host exposes /auth/customers-search at the host layer
  // (not under /api/apps/gocardless), so we hit it with a plain fetch
  // rather than the gocardless-prefixed authFetch. The standalone
  // session cookie is sent automatically (same-origin). In SAM-plugged
  // mode this endpoint doesn't exist and the dropdown returns an empty
  // list — to be wired into SAM's own customer-search service later.
  const res = await fetch(
    `/auth/customers-search?q=${encodeURIComponent(search)}&limit=20`,
  );
  if (!res.ok) return [];
  const data = (await res.json()) as { customers?: Array<{ account: string; name: string; postcode?: string }> };
  return data.customers ?? [];
}

function CustomerAccountSearch({
  value,
  valueName,
  onChange,
  placeholder = "Type to search customers...",
  initialSearch = "",
  onEscape
}: {
  value: string;
  valueName?: string;
  onChange: (account: string, name: string) => void;
  placeholder?: string;
  initialSearch?: string;
  onEscape?: () => void;
}) {
  const [search, setSearch] = useState(initialSearch);
  const [debouncedSearch, setDebouncedSearch] = useState(initialSearch);
  const [selectedName, setSelectedName] = useState(valueName || '');
  const wrapperRef = useRef<HTMLDivElement>(null);

  // Sync selectedName when valueName prop changes
  useEffect(() => {
    if (valueName) setSelectedName(valueName);
  }, [valueName]);

  // Sync search when initialSearch changes (e.g. different picker opened)
  useEffect(() => {
    if (initialSearch && !value) {
      setSearch(initialSearch);
      setDebouncedSearch(initialSearch);
    }
  }, [initialSearch, value]);

  // Close dropdown when clicking outside
  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (wrapperRef.current && !wrapperRef.current.contains(event.target as Node)) {
        setDebouncedSearch('');
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  // Debounce search — same pattern as SalesOrders
  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedSearch(search);
    }, 300);
    return () => clearTimeout(timer);
  }, [search]);

  // React Query for customer search — cached 30s, same as SalesOrders
  const { data: results = [], isLoading } = useQuery({
    queryKey: ['customer-search-gc', debouncedSearch],
    queryFn: () => fetchCustomerSearch(debouncedSearch),
    enabled: debouncedSearch.length >= 2 && !value,
    staleTime: 30000,
    gcTime: 60000,
  });

  const handleSelect = (c: {account: string; name: string}) => {
    onChange(c.account, c.name);
    setSelectedName(c.name);
    setSearch('');
    setDebouncedSearch('');
  };

  return (
    <div ref={wrapperRef} className="relative">
      {value ? (
        <div className="flex items-center gap-2 p-2 border border-green-300 bg-green-50 rounded text-sm">
          <span className="flex-1 truncate font-medium">{value}</span>
          <span className="text-gray-500 truncate">{selectedName || valueName}</span>
          <button
            type="button"
            onClick={() => { onChange('', ''); setSelectedName(''); setSearch(''); setDebouncedSearch(''); }}
            className="text-gray-400 hover:text-red-500"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      ) : (
        <div className="relative">
          <Search className="w-4 h-4 absolute left-3 top-1/2 transform -translate-y-1/2 text-gray-400" />
          <input
            type="text"
            className="w-full pl-9 pr-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-green-500 focus:border-green-500"
            placeholder={placeholder}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && results.length > 0) {
                e.preventDefault();
                handleSelect(results[0]);
              } else if (e.key === 'Escape') {
                e.preventDefault();
                setSearch('');
                setDebouncedSearch('');
                onEscape?.();
              }
            }}
          />
          {isLoading && (
            <RefreshCw className="w-4 h-4 absolute right-3 top-1/2 transform -translate-y-1/2 text-gray-400 animate-spin" />
          )}
        </div>
      )}
      {!value && debouncedSearch.length >= 2 && !isLoading && results.length === 0 && (
        <div className="absolute z-[60] w-full mt-1 bg-white border border-amber-300 rounded-lg shadow-lg px-3 py-2">
          <p className="text-xs text-amber-700">No customer found matching "{debouncedSearch}"</p>
        </div>
      )}
      {results.length > 0 && !value && (
        <div className="absolute z-[60] w-full mt-1 bg-white border border-gray-300 rounded-lg shadow-lg max-h-48 overflow-y-auto">
          {results.map((c) => (
            <button
              key={c.account}
              type="button"
              className="w-full text-left px-3 py-2 text-sm border-b border-gray-100 last:border-b-0 hover:bg-blue-50"
              onClick={() => handleSelect(c)}
            >
              <div className="font-medium">{c.name}</div>
              <div className="text-sm text-gray-500">{c.account}{c.postcode ? ` • ${c.postcode}` : ''}</div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

type TabType = 'invoices' | 'pending' | 'history' | 'mandates' | 'subscriptions';

interface Invoice {
  opera_account: string;
  customer_name: string;
  invoice_ref: string;
  invoice_date: string;
  due_date: string | null;
  days_until_due: number | null;
  amount: number;
  amount_formatted: string;
  original_amount?: number;
  is_overdue: boolean;
  is_due_by_advance?: boolean;
  has_mandate: boolean;
  mandate_id: string | null;
  mandate_status?: string | null;
  trans_type: string;
  trans_type_code?: number;
  is_subscription?: boolean;
  source_doc?: string;
  customer_ref?: string;
  payment_requested?: boolean;
  payment_request_info?: {
    status?: string;
    created_at?: string;
    amount?: number;
    charge_date?: string;
  };
}

interface CustomerGroup {
  account: string;
  name: string;
  email: string | null;
  has_mandate: boolean;
  mandate_id: string | null;
  invoices: Invoice[];
  total_due: number;
  total_due_formatted: string;
  invoice_count: number;
  unallocated_credit?: number;
  unallocated_credit_formatted?: string;
}

interface DueInvoicesResponse {
  customers: CustomerGroup[];
  invoices: Invoice[];
  summary: {
    total_customers: number;
    total_invoices: number;
    total_amount: number;
    total_amount_formatted: string;
    collectable_amount: number;
    collectable_formatted: string;
    customers_with_mandate: number;
    customers_without_mandate: number;
  };
  advance_date: string;
  today: string;
}

interface PaymentRequest {
  id: number;
  payment_id: string | null;
  mandate_id: string;
  opera_account: string;
  customer_name?: string;
  amount_pence: number;
  amount_formatted: string;
  currency: string;
  charge_date: string | null;
  description: string | null;
  invoice_refs: string[];
  status: string;
  payout_id: string | null;
  opera_receipt_ref: string | null;
  error_message: string | null;
  created_at: string;
  updated_at: string | null;
}

interface Mandate {
  id: number;
  opera_account: string;
  opera_name: string | null;
  gocardless_name: string | null;
  gocardless_customer_id: string | null;
  mandate_id: string;
  mandate_status: string;
  scheme: string;
  email: string | null;
  created_at: string;
  updated_at: string | null;
}

interface Stats {
  active_mandates: number;
  pending_count: number;
  pending_amount_formatted: string;
  month_collected_count: number;
  month_collected_formatted: string;
  failed_count_30d: number;
}

interface EligibleCustomer {
  account: string;
  name: string;
  balance: number;
  email: string | null;
  phone: string | null;
  contact: string | null;
  has_mandate: boolean;
  mandate_id: string | null;
  mandate_status: string | null;
}

interface LinkedDocument {
  doc_ref: string;
  amount_pence: number;
  amount_formatted: string;
  frequency: string;
  has_sub_tag: boolean;
}

interface Subscription {
  id: number;
  subscription_id: string;
  mandate_id: string;
  opera_account: string | null;
  opera_name: string | null;
  source_doc: string | null;
  source_docs: string[];
  linked_documents: LinkedDocument[];
  linked_document_count: number;
  amount_pence: number;
  amount_pounds: number;
  amount_formatted: string;
  currency: string;
  interval_unit: string;
  interval_count: number;
  frequency: string;
  day_of_month: number | null;
  name: string | null;
  status: string;
  start_date: string | null;
  end_date: string | null;
  created_at: string;
  updated_at: string | null;
  synced_at: string | null;
  opera_amount_pence: number | null;
  opera_amount_formatted: string | null;
  opera_frequency: string | null;
  has_sub_tag: boolean | null;
  mismatch: { details: string[] } | null;
}

interface RepeatDocument {
  doc_ref: string;
  opera_account: string;
  customer_name: string;
  frequency_code: string;
  frequency: string;
  interval_unit: string;
  interval_count: number;
  start_date: string | null;
  end_date: string | null;
  ex_vat: number;
  vat: number;
  total_inc_vat: number;
  amount_formatted: string;
  amount_pence: number;
  customer_ref: string;
  narration: string;
  has_mandate: boolean;
  mandate_id: string | null;
  has_subscription: boolean;
  subscription_id: string | null;
  subscription_status: string | null;
  mismatch: {
    details: string[];
    sub_amount_pence: number;
    sub_amount_formatted: string;
    doc_amount_pence: number;
    doc_amount_formatted: string;
  } | null;
  matching_subscription: {
    subscription_id: string;
    name: string;
    amount_formatted: string;
    status: string;
  } | null;
}

export default function GoCardlessRequests() {
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

  return <GoCardlessRequestsInner />;
}

function GoCardlessRequestsInner() {
  const queryClient = useQueryClient();
  const [activeTab, setActiveTab] = useState<TabType>('invoices');
  const [selectedInvoices, setSelectedInvoices] = useState<Set<string>>(new Set());
  const [advanceDate, setAdvanceDate] = useState<string>(() => {
    // Default to 7 days from now
    const d = new Date();
    d.setDate(d.getDate() + 7);
    return d.toISOString().split('T')[0];
  });
  const [activeDatePreset, setActiveDatePreset] = useState<string | null>('+7');
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  // Opera version detection — same pattern as GoCardlessImport.tsx
  const { data: operaConfigData } = useQuery({
    queryKey: ['operaConfig'],
    queryFn: async () => { const res = await authFetch('/api/config/opera'); return res.json(); },
    staleTime: 5 * 60 * 1000,
  });
  const isOpera3 = operaConfigData?.version === 'opera3';
  const opera3DataPath = operaConfigData?.opera3_server_path || operaConfigData?.opera3_base_path || '';

  // Helper: build API URL with Opera version routing
  const gcUrl = (path: string, extraParams?: Record<string, string>) => {
    const base = isOpera3 ? `/api/opera3/gocardless${path}` : `/api/gocardless${path}`;
    const params = new URLSearchParams();
    if (isOpera3 && opera3DataPath) params.set('data_path', opera3DataPath);
    if (extraParams) Object.entries(extraParams).forEach(([k, v]) => params.set(k, v));
    const qs = params.toString();
    return qs ? `${base}?${qs}` : base;
  };

  // Summary confirmation screen state
  const [showSummary, setShowSummary] = useState(false);

  // Link mandate modal state
  const [showLinkModal, setShowLinkModal] = useState(false);
  const [linkOperaAccount, setLinkOperaAccount] = useState('');
  const [linkMandateId, setLinkMandateId] = useState('');
  const [linkOperaName, setLinkOperaName] = useState('');
  const [linkGcName, setLinkGcName] = useState('');
  const [linkSuggestions, setLinkSuggestions] = useState<Array<{account: string; name: string; score: number; is_gc: boolean}>>([]);
  const [loadingSuggestions, setLoadingSuggestions] = useState(false);

  // Create Mandate modal state
  const [showCreateMandateModal, setShowCreateMandateModal] = useState(false);
  const [setupAccount, setSetupAccount] = useState('');
  const [setupAccountName, setSetupAccountName] = useState('');
  const [setupEmail, setSetupEmail] = useState('');
  const [loadingSetupEmail, setLoadingSetupEmail] = useState(false);

  // Stats query - cached, only refresh on interval or explicit refetch
  const { data: statsData } = useQuery({
    queryKey: ['gocardless-payment-stats'],
    queryFn: async () => {
      const res = await authFetch('/api/gocardless/payment-requests/stats');
      const data = await res.json();
      if (!data.success) throw new Error(data.error);
      return data as Stats & { success: boolean };
    },
    staleTime: 30000,         // Cache for 30 seconds
    refetchInterval: 60000,   // Refresh every 60 seconds (was 30s)
    refetchOnWindowFocus: false,
  });

  // Due invoices query (GC customers only, with advance date) - cached by date
  const { data: dueInvoicesData, isLoading: loadingDueInvoices, refetch: refetchDueInvoices } = useQuery({
    queryKey: ['gocardless-due-invoices', advanceDate, isOpera3],
    queryFn: async () => {
      const res = await authFetch(gcUrl('/due-invoices', { advance_date: advanceDate }));
      const data = await res.json();
      if (!data.success) throw new Error(data.error);
      return data as DueInvoicesResponse;
    },
    enabled: activeTab === 'invoices',
    staleTime: 2 * 60 * 1000,  // Cache for 2 minutes per date
    gcTime: 5 * 60 * 1000,
  });

  // Payment requests query - cached per status
  const { data: requestsData, isLoading: loadingRequests } = useQuery({
    queryKey: ['gocardless-payment-requests', activeTab],
    queryFn: async () => {
      const status = activeTab === 'pending' ? 'pending,pending_submission,submitted,confirmed' : undefined;
      const params = new URLSearchParams();
      if (status) params.set('status', status);
      const res = await authFetch(`/api/gocardless/payment-requests?${params}`);
      const data = await res.json();
      if (!data.success) throw new Error(data.error);
      return data as { requests: PaymentRequest[] };
    },
    enabled: activeTab === 'pending' || activeTab === 'history',
    staleTime: 60000,  // Cache for 1 minute
  });

  // Mandates query (linked to Opera) - cached, refresh on explicit action
  const { data: mandatesData, isLoading: loadingMandates, refetch: refetchMandates } = useQuery({
    queryKey: ['gocardless-mandates'],
    queryFn: async () => {
      const res = await authFetch('/api/gocardless/mandates');
      const data = await res.json();
      if (!data.success) throw new Error(data.error);
      return { mandates: data.mandates || [] } as { mandates: Mandate[] };
    },
    enabled: activeTab === 'mandates',
    staleTime: 5 * 60 * 1000,  // Cache for 5 minutes
    gcTime: 10 * 60 * 1000,
  });

  // Unposted payments warning — check for collected but unposted GoCardless payments
  const { data: unpostedData } = useQuery({
    queryKey: ['gcUnpostedPayments'],
    queryFn: async () => {
      const res = await authFetch(gcUrl('/unposted-payments'));
      return res.json();
    },
    staleTime: 2 * 60 * 1000,  // Cache for 2 minutes
  });

  // Sync mandates mutation
  const syncMandatesMutation = useMutation({
    mutationFn: async () => {
      const res = await authFetch(gcUrl('/mandates/sync'), {
        method: 'POST'
      });
      return res.json();
    },
    onSuccess: (data) => {
      if (data.success) {
        setSuccess(data.message || 'Mandates synced successfully');
        refetchMandates();
        refetchEligible();
      } else {
        setError(data.error);
      }
    }
  });

  // Pending mandate setups query
  const { data: pendingSetupsData, refetch: refetchPendingSetups } = useQuery({
    queryKey: ['gocardless-pending-setups'],
    queryFn: async () => {
      const res = await authFetch(gcUrl('/mandates/pending-setups'));
      const data = await res.json();
      if (!data.success) throw new Error(data.error);
      return data as { setups: Array<{
        id: number; opera_account: string; opera_name: string; customer_email: string;
        billing_request_id: string; authorisation_url: string; mandate_id: string;
        status: string; status_label: string; status_detail: string;
        email_sent_at: string; mandate_active_at: string; created_at: string;
      }>; pending_count: number };
    },
    enabled: activeTab === 'mandates',
    staleTime: 30 * 1000,
    gcTime: 5 * 60 * 1000,
  });

  // Create mandate setup mutation
  const createMandateSetupMutation = useMutation({
    mutationFn: async (params: { opera_account: string; opera_name: string; customer_email: string }) => {
      const res = await authFetch(gcUrl('/mandates/setup'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(params)
      });
      return res.json();
    },
    onSuccess: (data) => {
      if (data.success) {
        setShowCreateMandateModal(false);
        setSetupAccount('');
        setSetupAccountName('');
        setSetupEmail('');
        const emailMsg = data.email_sent
          ? `Email sent to ${data.setup?.customer_email || 'customer'}`
          : `Setup created but email not sent: ${data.email_error || 'unknown error'}`;
        setSuccess(`Mandate setup initiated for ${data.setup?.opera_name || data.setup?.opera_account}. ${emailMsg}`);
        refetchPendingSetups();
      } else {
        setError(data.error);
      }
    }
  });

  // Check mandate setups mutation
  const checkSetupsMutation = useMutation({
    mutationFn: async () => {
      const res = await authFetch(gcUrl('/mandates/check-setups'), { method: 'POST' });
      return res.json();
    },
    onSuccess: (data) => {
      if (data.success) {
        const completed = data.updates?.filter((u: any) => u.new_status === 'completed').length || 0;
        if (completed > 0) {
          setSuccess(`${completed} mandate setup(s) completed and linked to Opera`);
          refetchMandates();
          refetchEligible();
        } else if (data.updates?.length > 0) {
          setSuccess(`Checked ${data.updates.length} setup(s) — status updated`);
        } else {
          setSuccess(data.message || 'No updates');
        }
        refetchPendingSetups();
      } else {
        setError(data.error);
      }
    }
  });

  // Cancel mandate setup mutation
  const cancelSetupMutation = useMutation({
    mutationFn: async (setupId: number) => {
      const res = await authFetch(gcUrl(`/mandates/cancel-setup/${setupId}`), { method: 'POST' });
      return res.json();
    },
    onSuccess: (data) => {
      if (data.success) {
        setSuccess(data.message);
        refetchPendingSetups();
      } else {
        setError(data.error);
      }
    }
  });

  // Eligible customers query (customers with GC analysis code)
  // Cached with staleTime to avoid unnecessary refetches - only refresh on demand
  const { data: eligibleData, isLoading: _loadingEligible, refetch: refetchEligible } = useQuery({
    queryKey: ['gocardless-eligible-customers', isOpera3],
    queryFn: async () => {
      const res = await authFetch(gcUrl('/eligible-customers'));
      const data = await res.json();
      if (!data.success) throw new Error(data.error);
      return data as { customers: EligibleCustomer[]; count: number; with_mandate: number; without_mandate: number };
    },
    enabled: activeTab === 'mandates',
    staleTime: 5 * 60 * 1000,  // Cache for 5 minutes - don't refetch if data exists
    gcTime: 10 * 60 * 1000,   // Keep in memory for 10 minutes
  });

  // ============ Subscription state & queries ============
  const [showCreateSubModal, setShowCreateSubModal] = useState(false);
  const [repeatDocFreqFilter, setRepeatDocFreqFilter] = useState<string>('all');

  // Subscriptions list query
  const { data: subscriptionsData, isLoading: loadingSubscriptions, refetch: refetchSubscriptions } = useQuery({
    queryKey: ['gocardless-subscriptions', isOpera3],
    queryFn: async () => {
      const res = await authFetch(gcUrl('/subscriptions'));
      const data = await res.json();
      if (!data.success) throw new Error(data.error);
      return data as { subscriptions: Subscription[]; count: number };
    },
    enabled: activeTab === 'subscriptions',
    staleTime: 2 * 60 * 1000,
    gcTime: 5 * 60 * 1000,
  });

  // Track which subscription row is showing the link-document picker
  const [linkingSubId, setLinkingSubId] = useState<string | null>(null);
  const [linkPickerCustomer, setLinkPickerCustomer] = useState<string>('');  // selected customer account
  const [linkPickerCustomerName, setLinkPickerCustomerName] = useState<string>('');
  const linkPickerRef = useRef<HTMLDivElement>(null);

  // Close link picker when clicking outside or pressing Escape
  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (linkPickerRef.current && !linkPickerRef.current.contains(event.target as Node)) {
        setLinkingSubId(null);
      }
    }
    function handleEscape(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        event.preventDefault();
        setLinkingSubId(null);
      }
    }
    if (linkingSubId) {
      document.addEventListener('mousedown', handleClickOutside);
      document.addEventListener('keydown', handleEscape, true);  // capture phase — before global handler
      return () => {
        document.removeEventListener('mousedown', handleClickOutside);
        document.removeEventListener('keydown', handleEscape, true);
      };
    }
  }, [linkingSubId]);

  // Repeat documents query — mandate required for create modal
  const { data: repeatDocsData, isLoading: loadingRepeatDocs } = useQuery({
    queryKey: ['gocardless-repeat-documents', isOpera3],
    queryFn: async () => {
      const res = await authFetch(gcUrl('/repeat-documents'));
      const data = await res.json();
      if (!data.success) throw new Error(data.error);
      return data as { documents: RepeatDocument[]; count: number; with_mandate: number; with_subscription: number };
    },
    enabled: showCreateSubModal,
    staleTime: 60 * 1000,
  });

  // All repeat documents (no mandate filter) — for inline link picker on subscriptions tab
  const { data: allRepeatDocsData, isLoading: loadingAllRepeatDocs } = useQuery({
    queryKey: ['gocardless-repeat-documents-all', isOpera3],
    queryFn: async () => {
      const res = await authFetch(gcUrl('/repeat-documents?require_mandate=false'));
      const data = await res.json();
      if (!data.success) throw new Error(data.error);
      return data as { documents: RepeatDocument[]; count: number; with_mandate: number; with_subscription: number };
    },
    enabled: activeTab === 'subscriptions',
    staleTime: 60 * 1000,
  });

  // Link existing subscription to repeat document
  const linkSubMutation = useMutation({
    mutationFn: async (params: { subscription_id: string; source_doc: string }) => {
      const res = await authFetch('/api/gocardless/subscriptions/link', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(params)
      });
      return res.json();
    },
    onSuccess: (data) => {
      if (data.success) {
        setSuccess('Subscription linked to repeat document');
        refetchSubscriptions();
        queryClient.invalidateQueries({ queryKey: ['gocardless-repeat-documents'] });
      } else {
        setError(data.error);
      }
    },
    onError: (err: Error) => setError(err.message)
  });

  const unlinkSubMutation = useMutation({
    mutationFn: async (params: { subscription_id: string; source_doc?: string }) => {
      const res = await authFetch('/api/gocardless/subscriptions/unlink', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(params)
      });
      return res.json();
    },
    onSuccess: (data) => {
      if (data.success) {
        setSuccess('Document unlinked from subscription');
        refetchSubscriptions();
        queryClient.invalidateQueries({ queryKey: ['gocardless-repeat-documents'] });
      } else {
        setError(data.error);
      }
    },
    onError: (err: Error) => setError(err.message)
  });

  const syncFromOperaMutation = useMutation({
    mutationFn: async (subscriptionId: string) => {
      const res = await authFetch(gcUrl(`/subscriptions/${subscriptionId}/sync-from-opera`), {
        method: 'POST',
      });
      return res.json();
    },
    onSuccess: (data) => {
      if (data.success) {
        setSuccess(data.message || `Updated: ${data.old_amount_formatted} → ${data.new_amount_formatted}`);
        refetchSubscriptions();
        queryClient.invalidateQueries({ queryKey: ['gocardless-repeat-documents'] });
      } else {
        setError(data.error);
      }
    },
    onError: (err: Error) => setError(err.message)
  });

  // Create NEW subscription (only when no existing GC subscription matches)
  const createSubMutation = useMutation({
    mutationFn: async (params: { source_doc: string; day_of_month?: number }) => {
      const res = await authFetch(gcUrl('/subscriptions'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(params)
      });
      return res.json();
    },
    onSuccess: (data) => {
      if (data.success) {
        setSuccess('Subscription created successfully');
        setShowCreateSubModal(false);
        refetchSubscriptions();
        queryClient.invalidateQueries({ queryKey: ['gocardless-repeat-documents'] });
      } else {
        setError(data.error);
      }
    },
    onError: (err: Error) => setError(err.message)
  });

  // Pause subscription mutation
  const pauseSubMutation = useMutation({
    mutationFn: async (subscriptionId: string) => {
      const res = await authFetch(`/api/gocardless/subscriptions/${subscriptionId}/pause`, { method: 'POST' });
      return res.json();
    },
    onSuccess: (data) => {
      if (data.success) {
        setSuccess('Subscription paused');
        refetchSubscriptions();
      } else {
        setError(data.error);
      }
    }
  });

  // Resume subscription mutation
  const resumeSubMutation = useMutation({
    mutationFn: async (subscriptionId: string) => {
      const res = await authFetch(`/api/gocardless/subscriptions/${subscriptionId}/resume`, { method: 'POST' });
      return res.json();
    },
    onSuccess: (data) => {
      if (data.success) {
        setSuccess('Subscription resumed');
        refetchSubscriptions();
      } else {
        setError(data.error);
      }
    }
  });

  // Cancel subscription mutation
  const cancelSubMutation = useMutation({
    mutationFn: async (subscriptionId: string) => {
      const res = await authFetch(`/api/gocardless/subscriptions/${subscriptionId}/cancel`, { method: 'POST' });
      return res.json();
    },
    onSuccess: (data) => {
      if (data.success) {
        setSuccess('Subscription cancelled');
        refetchSubscriptions();
        queryClient.invalidateQueries({ queryKey: ['gocardless-repeat-documents'] });
      } else {
        setError(data.error);
      }
    }
  });

  // Sync subscriptions mutation
  const syncSubsMutation = useMutation({
    mutationFn: async () => {
      const res = await authFetch('/api/gocardless/subscriptions/sync', { method: 'POST' });
      return res.json();
    },
    onSuccess: (data) => {
      if (data.success) {
        setSuccess(data.message || 'Subscriptions synced');
        refetchSubscriptions();
      } else {
        setError(data.error);
      }
    }
  });

  // Request payment mutation
  const requestPaymentMutation = useMutation({
    mutationFn: async (params: { invoices: Invoice[] }) => {
      // Group by customer
      const byCustomer = params.invoices.reduce((acc, inv) => {
        if (!acc[inv.opera_account]) acc[inv.opera_account] = [];
        acc[inv.opera_account].push(inv);
        return acc;
      }, {} as Record<string, Invoice[]>);

      const requests = Object.entries(byCustomer).map(([account, invs]) => {
        // Use the latest due date among selected invoices as the charge date
        const dueDates = invs.map(i => i.due_date).filter((d): d is string => !!d);
        const chargeDate = dueDates.length > 0
          ? dueDates.sort((a, b) => a.localeCompare(b)).pop()!
          : undefined;
        return {
          opera_account: account,
          invoices: invs.map(i => i.invoice_ref),
          amount: Math.round(invs.reduce((sum, i) => sum + i.amount, 0) * 100),
          charge_date: chargeDate,
        };
      });

      const res = await authFetch(gcUrl('/payment-requests/bulk'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ requests })
      });
      return res.json();
    },
    onSuccess: (data) => {
      if (data.success || data.summary?.succeeded > 0) {
        // Build detailed confirmation message
        const results = data.results || [];
        const succeeded = results.filter((r: any) => r.success);
        const failed = results.filter((r: any) => !r.success);
        let msg = `${succeeded.length} payment(s) requested successfully`;
        if (succeeded.length > 0) {
          const details = succeeded.map((r: any) => {
            const amount = r.amount ? `£${(r.amount / 100).toFixed(2)}` : '';
            return `${r.opera_account} ${amount}`;
          }).join(', ');
          msg += `: ${details}`;
        }
        if (failed.length > 0) {
          msg += `. ${failed.length} failed: ${failed.map((r: any) => `${r.opera_account}: ${r.error}`).join('; ')}`;
        }
        setSuccess(msg);
        setSelectedInvoices(new Set());
        setShowSummary(false);
        queryClient.invalidateQueries({ queryKey: ['gocardless-payment-requests'] });
        queryClient.invalidateQueries({ queryKey: ['gocardless-payment-stats'] });
        queryClient.invalidateQueries({ queryKey: ['gocardless-unposted'] });
        refetchDueInvoices();
      } else {
        // Show detailed error from API
        const results = data.results || [];
        const errors = results.filter((r: any) => !r.success).map((r: any) => `${r.opera_account}: ${r.error}`);
        setError(errors.length > 0 ? errors.join('; ') : data.error || 'Failed to request payments');
      }
    },
    onError: (err: Error) => setError(err.message)
  });

  // Cancel payment mutation
  const cancelPaymentMutation = useMutation({
    mutationFn: async (requestId: number) => {
      const res = await authFetch(`/api/gocardless/payment-requests/${requestId}/cancel`, {
        method: 'POST'
      });
      return res.json();
    },
    onSuccess: (data) => {
      if (data.success) {
        setSuccess('Payment request cancelled');
        queryClient.invalidateQueries({ queryKey: ['gocardless-payment-requests'] });
        queryClient.invalidateQueries({ queryKey: ['gocardless-payment-stats'] });
      } else {
        setError(data.error);
      }
    }
  });

  // Link mandate mutation
  const linkMandateMutation = useMutation({
    mutationFn: async (params: { opera_account: string; mandate_id: string; opera_name?: string; confirm?: boolean }) => {
      const res = await authFetch(gcUrl('/mandates/link'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(params)
      });
      return res.json();
    },
    onSuccess: (data, variables) => {
      if (data.success) {
        let msg = 'Mandate linked successfully';
        if (data.gc_flag?.gc_removed_from) {
          msg += ` (GC flag removed from ${data.gc_flag.gc_removed_from}, set on ${data.gc_flag.gc_set_on})`;
        }
        setSuccess(msg);
        setShowLinkModal(false);
        setLinkOperaAccount('');
        setLinkMandateId('');
        setLinkOperaName('');
        setLinkGcName('');
        queryClient.invalidateQueries({ queryKey: ['gocardless-mandates'] });
        queryClient.invalidateQueries({ queryKey: ['gocardless-eligible-customers'] });
        queryClient.invalidateQueries({ queryKey: ['gocardless-collectable-invoices'] });
      } else if (data.needs_confirm) {
        // Ask user to confirm reassignment
        if (window.confirm(data.error)) {
          linkMandateMutation.mutate({ ...variables, confirm: true });
        }
      } else {
        setError(data.error || 'Failed to link mandate');
      }
    },
    onError: (error: Error) => {
      setError(error.message || 'Failed to link mandate — check the API is running');
    }
  });

  // Sync statuses mutation
  const syncStatusesMutation = useMutation({
    mutationFn: async () => {
      const res = await authFetch('/api/gocardless/payment-requests/sync', { method: 'POST' });
      return res.json();
    },
    onSuccess: (data) => {
      if (data.success) {
        setSuccess(`Synced ${data.updated} payment statuses`);
        queryClient.invalidateQueries({ queryKey: ['gocardless-payment-requests'] });
        queryClient.invalidateQueries({ queryKey: ['gocardless-payment-stats'] });
      } else {
        setError(data.error);
      }
    }
  });

  // Clear messages after delay
  useEffect(() => {
    if (success) {
      const timer = setTimeout(() => setSuccess(null), 5000);
      return () => clearTimeout(timer);
    }
  }, [success]);

  useEffect(() => {
    if (error) {
      const timer = setTimeout(() => setError(null), 10000);
      return () => clearTimeout(timer);
    }
  }, [error]);

  // Invoice selection helpers
  const toggleInvoice = (key: string) => {
    const newSet = new Set(selectedInvoices);
    if (newSet.has(key)) {
      newSet.delete(key);
    } else {
      newSet.add(key);
    }
    setSelectedInvoices(newSet);
  };

  const toggleCustomer = (account: string) => {
    const customer = dueInvoicesData?.customers.find(c => c.account === account);
    if (!customer || !customer.has_mandate) return;

    const newSet = new Set(selectedInvoices);
    const customerKeys = customer.invoices
      .filter(i => !i.payment_requested)
      .map(i => `${i.opera_account}:${i.invoice_ref}`);
    const allSelected = customerKeys.every(k => newSet.has(k));

    if (allSelected) {
      // Deselect all
      customerKeys.forEach(k => newSet.delete(k));
    } else {
      // Select all
      customerKeys.forEach(k => newSet.add(k));
    }
    setSelectedInvoices(newSet);
  };

  const selectAllWithMandate = () => {
    const keys = (dueInvoicesData?.invoices || [])
      .filter(i => i.has_mandate && !i.payment_requested)
      .map(i => `${i.opera_account}:${i.invoice_ref}`);
    setSelectedInvoices(new Set(keys));
  };

  const getSelectedInvoices = (): Invoice[] => {
    return (dueInvoicesData?.invoices || []).filter(
      i => selectedInvoices.has(`${i.opera_account}:${i.invoice_ref}`)
    );
  };

  const selectedTotal = getSelectedInvoices().reduce((sum, i) => sum + i.amount, 0);

  const isCustomerFullySelected = (account: string): boolean => {
    const customer = dueInvoicesData?.customers.find(c => c.account === account);
    if (!customer) return false;
    return customer.invoices.every(i => selectedInvoices.has(`${i.opera_account}:${i.invoice_ref}`));
  };

  const isCustomerPartiallySelected = (account: string): boolean => {
    const customer = dueInvoicesData?.customers.find(c => c.account === account);
    if (!customer) return false;
    const selected = customer.invoices.filter(i => selectedInvoices.has(`${i.opera_account}:${i.invoice_ref}`));
    return selected.length > 0 && selected.length < customer.invoices.length;
  };

  const getStatusBadge = (status: string) => {
    const badges: Record<string, { color: string; icon: React.ReactNode; label: string }> = {
      pending: { color: 'bg-yellow-100 text-yellow-800', icon: <Clock className="w-3 h-3" />, label: 'Pending' },
      pending_submission: { color: 'bg-yellow-100 text-yellow-800', icon: <Clock className="w-3 h-3" />, label: 'Awaiting Submission' },
      pending_customer_approval: { color: 'bg-blue-100 text-blue-800', icon: <Clock className="w-3 h-3" />, label: 'Customer Approval' },
      submitted: { color: 'bg-blue-100 text-blue-800', icon: <Send className="w-3 h-3" />, label: 'Submitted' },
      confirmed: { color: 'bg-green-100 text-green-800', icon: <CheckCircle className="w-3 h-3" />, label: 'Confirmed' },
      paid_out: { color: 'bg-green-100 text-green-800', icon: <CheckCircle className="w-3 h-3" />, label: 'Paid Out' },
      failed: { color: 'bg-red-100 text-red-800', icon: <AlertCircle className="w-3 h-3" />, label: 'Failed' },
      cancelled: { color: 'bg-gray-100 text-gray-800', icon: <Ban className="w-3 h-3" />, label: 'Cancelled' }
    };
    const badge = badges[status] || { color: 'bg-gray-100 text-gray-800', icon: null, label: status };
    return (
      <span className={`inline-flex items-center gap-1 px-2 py-1 rounded-full text-xs font-medium ${badge.color}`}>
        {badge.icon}
        {badge.label}
      </span>
    );
  };

  return (
    <div className="p-6 max-w-7xl mx-auto space-y-6">
      {/* Header */}
      <PageHeader icon={CreditCard} title="GoCardless Payment Requests" subtitle="Request Direct Debit payments from customers">
        <button
          onClick={() => syncStatusesMutation.mutate()}
          disabled={syncStatusesMutation.isPending}
          className="flex items-center gap-2 px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-50 disabled:opacity-50"
        >
          <RefreshCw className={`w-4 h-4 ${syncStatusesMutation.isPending ? 'animate-spin' : ''}`} />
          Sync Status
        </button>
      </PageHeader>

      {/* Messages */}
      {error && (
        <Alert variant="error" onDismiss={() => setError(null)}>{error}</Alert>
      )}

      {success && (
        <Alert variant="success" onDismiss={() => setSuccess(null)}>{success}</Alert>
      )}

      {/* Unposted payments warning */}
      {unpostedData?.has_unposted && (
        <div className="p-3 bg-amber-50 border border-amber-200 rounded-lg flex items-center justify-between">
          <div className="flex items-center gap-2">
            <AlertCircle className="w-4 h-4 text-amber-600 flex-shrink-0" />
            <span className="text-sm text-amber-800">
              <strong>{unpostedData.unposted_count} payment{unpostedData.unposted_count !== 1 ? 's' : ''}</strong> (£{unpostedData.unposted_total?.toLocaleString('en-GB', {minimumFractionDigits: 2})}) collected but not posted to Opera
            </span>
          </div>
          <a href="/cashbook/gocardless" className="px-3 py-1 text-sm bg-amber-600 text-white rounded hover:bg-amber-700">
            Go to Import
          </a>
        </div>
      )}

      {/* Stats Summary */}
      {statsData && (
        <div className="grid grid-cols-4 gap-4">
          <Card>
            <div className="flex items-center gap-2 text-gray-500 text-sm mb-1">
              <Users className="w-4 h-4" />
              Active Mandates
            </div>
            <div className="text-2xl font-semibold text-gray-900">{statsData.active_mandates}</div>
          </Card>
          <Card>
            <div className="flex items-center gap-2 text-gray-500 text-sm mb-1">
              <Clock className="w-4 h-4" />
              Pending
            </div>
            <div className="text-2xl font-semibold text-yellow-600">{statsData.pending_amount_formatted}</div>
            <div className="text-xs text-gray-500">{statsData.pending_count} payments</div>
          </Card>
          <Card>
            <div className="flex items-center gap-2 text-gray-500 text-sm mb-1">
              <CheckCircle className="w-4 h-4" />
              This Month
            </div>
            <div className="text-2xl font-semibold text-green-600">{statsData.month_collected_formatted}</div>
            <div className="text-xs text-gray-500">{statsData.month_collected_count} collected</div>
          </Card>
          <Card>
            <div className="flex items-center gap-2 text-gray-500 text-sm mb-1">
              <AlertCircle className="w-4 h-4" />
              Failed (30d)
            </div>
            <div className="text-2xl font-semibold text-red-600">{statsData.failed_count_30d}</div>
          </Card>
        </div>
      )}

      {/* Tabs */}
      <Card padding={false} className="overflow-hidden">
        <div className="border-b border-gray-200">
          <nav className="flex">
            {[
              { id: 'invoices', label: 'Outstanding Invoices', icon: FileText },
              { id: 'pending', label: 'Pending Requests', icon: Clock },
              { id: 'history', label: 'Payment History', icon: History },
              { id: 'mandates', label: 'Mandates', icon: Link },
              { id: 'subscriptions', label: 'Subscriptions', icon: RefreshCw }
            ].map(tab => (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id as TabType)}
                className={`flex items-center gap-2 px-6 py-3 text-sm font-medium border-b-2 -mb-px ${
                  activeTab === tab.id
                    ? 'border-green-500 text-green-600'
                    : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
                }`}
              >
                <tab.icon className="w-4 h-4" />
                {tab.label}
              </button>
            ))}
          </nav>
        </div>

        {/* Tab Content */}
        <div className="p-4">
          {/* Outstanding Invoices Tab */}
          {activeTab === 'invoices' && showSummary && (
            <div>
              {/* Summary Confirmation Screen */}
              <div className="mb-4">
                <button
                  onClick={() => setShowSummary(false)}
                  className="flex items-center gap-1 text-sm text-gray-600 hover:text-gray-900"
                >
                  <span className="text-lg leading-none">&larr;</span> Back to invoice selection
                </button>
              </div>

              <div className="bg-white border border-gray-200 rounded-lg overflow-hidden">
                <div className="bg-green-50 border-b border-green-200 px-5 py-4">
                  <h3 className="text-lg font-semibold text-green-900">Payment Request Summary</h3>
                  <p className="text-sm text-green-700 mt-1">
                    Please review the following payment requests before confirming.
                  </p>
                </div>

                <div className="divide-y divide-gray-200">
                  {(() => {
                    const selected = getSelectedInvoices();
                    const byCustomer = selected.reduce((acc, inv) => {
                      if (!acc[inv.opera_account]) acc[inv.opera_account] = { name: inv.customer_name, invoices: [] };
                      acc[inv.opera_account].invoices.push(inv);
                      return acc;
                    }, {} as Record<string, { name: string; invoices: Invoice[] }>);

                    return Object.entries(byCustomer).map(([account, { name, invoices }]) => {
                      const customerTotal = invoices.reduce((sum, i) => sum + i.amount, 0);
                      return (
                        <div key={account} className="px-5 py-4">
                          <div className="flex items-center justify-between mb-2">
                            <div>
                              <span className="font-medium text-gray-900">{name}</span>
                              <span className="text-sm text-gray-500 ml-2">({account})</span>
                            </div>
                            <span className="font-semibold text-gray-900">
                              {'\u00A3'}{customerTotal.toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                            </span>
                          </div>
                          <table className="w-full text-sm">
                            <tbody>
                              {invoices.map(inv => (
                                <tr key={inv.invoice_ref} className="text-gray-600">
                                  <td className="py-0.5 pr-4 font-mono">{inv.invoice_ref}</td>
                                  <td className="py-0.5 pr-4">{inv.invoice_date}</td>
                                  <td className="py-0.5 pr-4">
                                    {inv.is_overdue ? (
                                      <span className="text-red-600">{Math.abs(inv.days_until_due || 0)}d overdue</span>
                                    ) : inv.due_date ? (
                                      <span>Due {inv.due_date}</span>
                                    ) : '-'}
                                  </td>
                                  <td className="py-0.5 text-right font-medium text-gray-900">{inv.amount_formatted}</td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      );
                    });
                  })()}
                </div>

                {/* Grand total and actions */}
                <div className="bg-gray-50 border-t border-gray-200 px-5 py-4">
                  <div className="flex items-center justify-between">
                    <div className="text-sm text-gray-600">
                      {(() => {
                        const selected = getSelectedInvoices();
                        const customerCount = new Set(selected.map(i => i.opera_account)).size;
                        return `${selected.length} invoice${selected.length !== 1 ? 's' : ''} across ${customerCount} customer${customerCount !== 1 ? 's' : ''}`;
                      })()}
                    </div>
                    <div className="text-lg font-bold text-gray-900">
                      Total: {'\u00A3'}{selectedTotal.toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                    </div>
                  </div>

                  <div className="flex items-center justify-end gap-3 mt-4">
                    <button
                      onClick={() => setShowSummary(false)}
                      className="px-4 py-2 text-sm text-gray-700 border border-gray-300 rounded-lg hover:bg-gray-100"
                    >
                      Back
                    </button>
                    <button
                      onClick={() => requestPaymentMutation.mutate({ invoices: getSelectedInvoices() })}
                      disabled={requestPaymentMutation.isPending}
                      className="flex items-center gap-2 px-5 py-2 bg-green-600 text-white text-sm font-semibold rounded-lg hover:bg-green-700 disabled:opacity-50"
                    >
                      {requestPaymentMutation.isPending ? (
                        <RefreshCw className="w-4 h-4 animate-spin" />
                      ) : (
                        <Send className="w-4 h-4" />
                      )}
                      Confirm &amp; Request Payment
                    </button>
                  </div>
                </div>
              </div>
            </div>
          )}

          {activeTab === 'invoices' && !showSummary && (
            <div>
              {/* Advance Date Selector and Filters */}
              <div className="bg-gray-50 rounded-lg p-4 mb-4">
                <div className="flex flex-wrap items-center gap-4">
                  <div className="flex items-center gap-2">
                    <label className="text-sm font-medium text-gray-700">Show invoices due by:</label>
                    <input
                      type="date"
                      value={advanceDate}
                      onChange={e => { setAdvanceDate(e.target.value); setActiveDatePreset(null); }}
                      className="px-3 py-1.5 border border-gray-300 rounded-lg text-sm focus:ring-green-500 focus:border-green-500"
                    />
                  </div>
                  <div className="flex items-center gap-2">
                    {([
                      { id: 'today', label: 'Today', calc: () => new Date() },
                      { id: '+7', label: '+7 days', calc: () => { const d = new Date(); d.setDate(d.getDate() + 7); return d; } },
                      { id: '+14', label: '+14 days', calc: () => { const d = new Date(); d.setDate(d.getDate() + 14); return d; } },
                      { id: '+1m', label: '+1 month', calc: () => { const d = new Date(); d.setMonth(d.getMonth() + 1); return d; } },
                    ] as const).map(preset => (
                      <button
                        key={preset.id}
                        onClick={() => {
                          setAdvanceDate(preset.calc().toISOString().split('T')[0]);
                          setActiveDatePreset(preset.id);
                        }}
                        className={`px-2 py-1 text-xs rounded ${
                          activeDatePreset === preset.id
                            ? 'bg-green-100 border border-green-400 text-green-700 font-medium'
                            : 'bg-white border border-gray-300 hover:bg-gray-50'
                        }`}
                      >
                        {preset.label}
                      </button>
                    ))}
                  </div>
                  <div className="ml-auto flex items-center gap-2">
                    <button
                      onClick={selectAllWithMandate}
                      className="px-3 py-1.5 text-sm text-gray-700 border border-gray-300 rounded-lg hover:bg-gray-50 bg-white"
                    >
                      Select All
                    </button>
                    <button
                      onClick={() => refetchDueInvoices()}
                      className="p-2 text-gray-500 hover:text-gray-700"
                    >
                      <RefreshCw className="w-4 h-4" />
                    </button>
                  </div>
                </div>

                {/* Summary */}
                {dueInvoicesData?.summary && (
                  <div className="flex flex-wrap gap-4 mt-3 pt-3 border-t border-gray-200 text-sm">
                    <span className="text-gray-600">
                      <span className="font-medium text-gray-900">{dueInvoicesData.summary.total_customers}</span> customers
                    </span>
                    <span className="text-gray-600">
                      <span className="font-medium text-gray-900">{dueInvoicesData.summary.total_invoices}</span> invoices
                    </span>
                    <span className="text-gray-600">
                      Total: <span className="font-medium text-gray-900">{dueInvoicesData.summary.total_amount_formatted}</span>
                    </span>
                    <span className="text-green-600">
                      Collectable (with mandate): <span className="font-medium">{dueInvoicesData.summary.collectable_formatted}</span>
                    </span>
                    {dueInvoicesData.summary.customers_without_mandate > 0 && (
                      <span className="text-amber-600">
                        {dueInvoicesData.summary.customers_without_mandate} customers need mandate setup
                      </span>
                    )}
                  </div>
                )}
              </div>

              {/* Customers with Invoices */}
              {loadingDueInvoices ? (
                <div className="flex items-center justify-center py-12">
                  <RefreshCw className="w-6 h-6 text-gray-400 animate-spin" />
                </div>
              ) : dueInvoicesData?.customers.length === 0 ? (
                <div className="text-center py-12 text-gray-500">
                  <FileText className="w-12 h-12 mx-auto mb-3 text-gray-300" />
                  <p>No invoices due by {advanceDate}</p>
                  <p className="text-sm mt-1">Try selecting a later date or check that customers have 'GC' analysis code in Opera</p>
                </div>
              ) : (
                <div className="space-y-4">
                  {dueInvoicesData?.customers.map(customer => {
                    const isFullySelected = isCustomerFullySelected(customer.account);
                    const isPartiallySelected = isCustomerPartiallySelected(customer.account);
                    return (
                      <div
                        key={customer.account}
                        className={`border rounded-lg overflow-hidden ${
                          isFullySelected ? 'border-green-300 bg-green-50' :
                          isPartiallySelected ? 'border-green-200' : 'border-gray-200'
                        }`}
                      >
                        {/* Customer Header */}
                        <div
                          className={`flex items-center justify-between p-3 cursor-pointer ${
                            customer.has_mandate ? 'hover:bg-gray-50' : ''
                          }`}
                          onClick={() => customer.has_mandate && toggleCustomer(customer.account)}
                        >
                          <div className="flex items-center gap-3">
                            <input
                              type="checkbox"
                              checked={isFullySelected}
                              ref={el => {
                                if (el) el.indeterminate = isPartiallySelected;
                              }}
                              onChange={() => toggleCustomer(customer.account)}
                              disabled={!customer.has_mandate}
                              className="rounded border-gray-300 text-green-600 focus:ring-green-500 disabled:opacity-50"
                            />
                            <div>
                              <div className="font-medium text-gray-900">{customer.name}</div>
                              <div className="text-xs text-gray-500">
                                {customer.account} • {customer.invoice_count} invoice{customer.invoice_count !== 1 ? 's' : ''}
                                {customer.email && ` • ${customer.email}`}
                              </div>
                            </div>
                          </div>
                          <div className="flex items-center gap-4">
                            <div className="text-right">
                              <div className="font-medium text-gray-900">{customer.total_due_formatted}</div>
                            </div>
                            {customer.has_mandate ? (
                              <span className="inline-flex items-center gap-1 px-2 py-1 bg-green-100 text-green-700 rounded text-xs">
                                <CheckCircle className="w-3 h-3" />
                                DD Ready
                              </span>
                            ) : (
                              <button
                                onClick={(e) => {
                                  e.stopPropagation();
                                  setLinkOperaAccount(customer.account);
                                  setLinkOperaName(customer.name);
                                  setLinkMandateId('');
                                  setLinkGcName('');
                                  setShowLinkModal(true);
                                }}
                                className="inline-flex items-center gap-1 px-2 py-1 bg-amber-100 text-amber-700 rounded text-xs hover:bg-amber-200"
                              >
                                <Plus className="w-3 h-3" />
                                Link Mandate
                              </button>
                            )}
                          </div>
                        </div>

                        {/* Unallocated credit warning */}
                        {(customer.unallocated_credit ?? 0) > 0 && (
                          <div className="mx-3 mt-2 mb-1 p-2 bg-amber-50 border border-amber-200 rounded flex items-center gap-2">
                            <AlertCircle className="w-4 h-4 text-amber-600 flex-shrink-0" />
                            <span className="text-xs text-amber-800">
                              <strong>{customer.unallocated_credit_formatted}</strong> unallocated credit on account — may be a previous payment not yet allocated to invoices.
                              Allocate in Opera before collecting to avoid duplicate payment.
                            </span>
                          </div>
                        )}

                        {/* Invoices Table */}
                        <div className="border-t border-gray-200">
                          <table className="min-w-full divide-y divide-gray-200 table-fixed">
                            <colgroup>
                              <col className="w-10" />
                              <col style={{ width: '18%' }} />
                              <col style={{ width: '22%' }} />
                              <col style={{ width: '15%' }} />
                              <col style={{ width: '25%' }} />
                              <col style={{ width: '15%' }} />
                            </colgroup>
                            <thead className="bg-gray-50">
                              <tr>
                                <th className="px-3 py-2"></th>
                                <th className="px-3 py-2 text-left text-xs font-medium text-gray-500">Invoice</th>
                                <th className="px-3 py-2 text-left text-xs font-medium text-gray-500">Customer Ref</th>
                                <th className="px-3 py-2 text-left text-xs font-medium text-gray-500">Date</th>
                                <th className="px-3 py-2 text-left text-xs font-medium text-gray-500">Due Date</th>
                                <th className="px-3 py-2 text-right text-xs font-medium text-gray-500">Amount</th>
                              </tr>
                            </thead>
                            <tbody className="bg-white divide-y divide-gray-100">
                              {customer.invoices.map(invoice => {
                                const key = `${invoice.opera_account}:${invoice.invoice_ref}`;
                                const isSelected = selectedInvoices.has(key);
                                const isSub = invoice.is_subscription;
                                return (
                                  <tr
                                    key={key}
                                    className={`${isSelected ? 'bg-green-50' : ''} ${!customer.has_mandate || invoice.payment_requested ? 'opacity-60' : ''}`}
                                  >
                                    <td className="px-3 py-2">
                                      <input
                                        type="checkbox"
                                        checked={isSelected}
                                        onChange={() => toggleInvoice(key)}
                                        disabled={!customer.has_mandate || invoice.payment_requested}
                                        className="rounded border-gray-300 text-green-600 focus:ring-green-500 disabled:opacity-50"
                                      />
                                    </td>
                                    <td className="px-3 py-2 text-sm text-gray-900">
                                      {invoice.invoice_ref}
                                      {invoice.payment_requested && (
                                        <span
                                          className="ml-2 inline-flex items-center px-1.5 py-0.5 rounded text-xs font-medium bg-amber-100 text-amber-700"
                                          title={`Payment already requested${invoice.payment_request_info?.charge_date ? ` — charge date: ${invoice.payment_request_info.charge_date}` : ''}${invoice.payment_request_info?.status ? ` (${invoice.payment_request_info.status})` : ''}`}
                                        >
                                          <AlertCircle className="w-3 h-3 mr-0.5" />
                                          Requested
                                        </span>
                                      )}
                                      {isSub && (
                                        <span
                                          className="ml-2 inline-flex items-center px-1.5 py-0.5 rounded text-xs font-medium bg-purple-100 text-purple-700"
                                          title={`Covered by DD subscription${invoice.source_doc ? ` (${invoice.source_doc})` : ''}`}
                                        >
                                          SUB
                                        </span>
                                      )}
                                    </td>
                                    <td className="px-3 py-2 text-sm text-gray-500">{invoice.customer_ref || ''}</td>
                                    <td className="px-3 py-2 text-sm text-gray-500">{invoice.invoice_date}</td>
                                    <td className="px-3 py-2">
                                      {invoice.is_overdue ? (
                                        <span className="text-sm text-red-600 font-medium">
                                          {Math.abs(invoice.days_until_due || 0)} days overdue
                                        </span>
                                      ) : invoice.due_date ? (
                                        <span className="text-sm text-gray-500">
                                          {invoice.due_date}
                                          {invoice.days_until_due !== null && invoice.days_until_due > 0 && (
                                            <span className="text-gray-400 ml-1">({invoice.days_until_due}d)</span>
                                          )}
                                        </span>
                                      ) : (
                                        <span className="text-sm text-gray-400">-</span>
                                      )}
                                    </td>
                                    <td className="px-3 py-2 text-right text-sm font-medium text-gray-900">
                                      {invoice.amount_formatted}
                                    </td>
                                  </tr>
                                );
                              })}
                            </tbody>
                          </table>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}

              {/* Selection Actions */}
              {selectedInvoices.size > 0 && (
                <div className="mt-4 p-4 bg-green-50 border border-green-200 rounded-lg flex items-center justify-between sticky bottom-4">
                  <div>
                    <span className="text-sm font-medium text-green-800">
                      {selectedInvoices.size} invoice{selectedInvoices.size > 1 ? 's' : ''} selected
                    </span>
                    <span className="text-sm text-green-700 ml-2">
                      (Total: {'\u00A3'}{selectedTotal.toFixed(2)})
                    </span>
                  </div>
                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => setSelectedInvoices(new Set())}
                      className="px-3 py-1.5 text-sm text-gray-600 hover:text-gray-800"
                    >
                      Clear
                    </button>
                    <button
                      onClick={() => setShowSummary(true)}
                      className="flex items-center gap-2 px-4 py-2 bg-green-600 text-white text-sm font-medium rounded-lg hover:bg-green-700"
                    >
                      <Send className="w-4 h-4" />
                      Review &amp; Request Payment
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Pending Requests Tab */}
          {activeTab === 'pending' && (
            <div>
              {loadingRequests ? (
                <div className="flex items-center justify-center py-12">
                  <RefreshCw className="w-6 h-6 text-gray-400 animate-spin" />
                </div>
              ) : (
                <table className="min-w-full divide-y divide-gray-200">
                  <thead className="bg-gray-50">
                    <tr>
                      <th className="px-3 py-3 text-left text-xs font-medium text-gray-500 uppercase">Customer</th>
                      <th className="px-3 py-3 text-right text-xs font-medium text-gray-500 uppercase">Amount</th>
                      <th className="px-3 py-3 text-left text-xs font-medium text-gray-500 uppercase">Requested</th>
                      <th className="px-3 py-3 text-left text-xs font-medium text-gray-500 uppercase">Charge Date</th>
                      <th className="px-3 py-3 text-center text-xs font-medium text-gray-500 uppercase">Status</th>
                      <th className="px-3 py-3 text-center text-xs font-medium text-gray-500 uppercase">Actions</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-200">
                    {requestsData?.requests
                      .filter(r => ['pending', 'pending_submission', 'submitted', 'confirmed'].includes(r.status))
                      .map(req => (
                        <tr key={req.id}>
                          <td className="px-3 py-3">
                            <div className="text-sm font-medium text-gray-900">{req.customer_name || req.opera_account}</div>
                            <div className="text-xs text-gray-500">{req.invoice_refs.join(', ')}</div>
                          </td>
                          <td className="px-3 py-3 text-right text-sm font-medium">{req.amount_formatted}</td>
                          <td className="px-3 py-3 text-sm text-gray-500">
                            {new Date(req.created_at).toLocaleDateString()}
                          </td>
                          <td className="px-3 py-3 text-sm text-gray-500">{req.charge_date || '-'}</td>
                          <td className="px-3 py-3 text-center">{getStatusBadge(req.status)}</td>
                          <td className="px-3 py-3 text-center">
                            {['pending', 'pending_submission'].includes(req.status) && (
                              <button
                                onClick={() => cancelPaymentMutation.mutate(req.id)}
                                disabled={cancelPaymentMutation.isPending}
                                className="text-red-600 hover:text-red-800 text-sm"
                              >
                                Cancel
                              </button>
                            )}
                          </td>
                        </tr>
                      ))}
                  </tbody>
                </table>
              )}
              {requestsData?.requests.filter(r => ['pending', 'pending_submission', 'submitted', 'confirmed'].includes(r.status)).length === 0 && (
                <div className="text-center py-12 text-gray-500">
                  No pending payment requests
                </div>
              )}
            </div>
          )}

          {/* Payment History Tab */}
          {activeTab === 'history' && (
            <div>
              {loadingRequests ? (
                <div className="flex items-center justify-center py-12">
                  <RefreshCw className="w-6 h-6 text-gray-400 animate-spin" />
                </div>
              ) : (
                <table className="min-w-full divide-y divide-gray-200">
                  <thead className="bg-gray-50">
                    <tr>
                      <th className="px-3 py-3 text-left text-xs font-medium text-gray-500 uppercase">Customer</th>
                      <th className="px-3 py-3 text-right text-xs font-medium text-gray-500 uppercase">Amount</th>
                      <th className="px-3 py-3 text-left text-xs font-medium text-gray-500 uppercase">Date</th>
                      <th className="px-3 py-3 text-center text-xs font-medium text-gray-500 uppercase">Status</th>
                      <th className="px-3 py-3 text-left text-xs font-medium text-gray-500 uppercase">Receipt Ref</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-200">
                    {requestsData?.requests.map(req => (
                      <tr key={req.id}>
                        <td className="px-3 py-3">
                          <div className="text-sm font-medium text-gray-900">{req.customer_name || req.opera_account}</div>
                          <div className="text-xs text-gray-500">{req.invoice_refs.join(', ')}</div>
                        </td>
                        <td className="px-3 py-3 text-right text-sm font-medium">{req.amount_formatted}</td>
                        <td className="px-3 py-3 text-sm text-gray-500">
                          {new Date(req.created_at).toLocaleDateString()}
                        </td>
                        <td className="px-3 py-3 text-center">{getStatusBadge(req.status)}</td>
                        <td className="px-3 py-3 text-sm text-gray-500">
                          {req.opera_receipt_ref || (req.error_message ? (
                            <span className="text-red-500 text-xs">{req.error_message}</span>
                          ) : '-')}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          )}

          {/* Mandates Tab */}
          {activeTab === 'mandates' && (
            <div className="space-y-6">
              {/* Action buttons */}
              <div className="flex items-center justify-end gap-2">
                {(pendingSetupsData?.pending_count ?? 0) > 0 && (
                  <button
                    onClick={() => checkSetupsMutation.mutate()}
                    disabled={checkSetupsMutation.isPending}
                    className="flex items-center gap-2 px-3 py-1.5 text-sm text-blue-600 hover:text-blue-800 border border-blue-300 rounded-lg hover:bg-blue-50 disabled:opacity-50"
                  >
                    <RefreshCw className={`w-4 h-4 ${checkSetupsMutation.isPending ? 'animate-spin' : ''}`} />
                    {checkSetupsMutation.isPending ? 'Checking...' : 'Check Pending Setups'}
                  </button>
                )}
                <button
                  onClick={() => syncMandatesMutation.mutate()}
                  disabled={syncMandatesMutation.isPending}
                  className="flex items-center gap-2 px-3 py-1.5 text-sm text-gray-600 hover:text-gray-800 border border-gray-300 rounded-lg hover:bg-gray-50 disabled:opacity-50"
                >
                  <RefreshCw className={`w-4 h-4 ${syncMandatesMutation.isPending ? 'animate-spin' : ''}`} />
                  {syncMandatesMutation.isPending ? 'Syncing...' : 'Sync from GoCardless'}
                </button>
                <button
                  onClick={() => {
                    setSetupAccount('');
                    setSetupAccountName('');
                    setSetupEmail('');
                    setShowCreateMandateModal(true);
                  }}
                  className="flex items-center gap-2 px-3 py-1.5 text-sm font-medium text-white bg-green-600 rounded-lg hover:bg-green-700"
                >
                  <Plus className="w-4 h-4" />
                  Create Mandate
                </button>
              </div>

              {/* Pending Mandate Setups */}
              {(pendingSetupsData?.setups?.filter(s => !['completed', 'failed', 'cancelled'].includes(s.status)).length ?? 0) > 0 && (
                <div>
                  <h3 className="text-sm font-semibold text-gray-900 flex items-center gap-2 mb-3">
                    <Mail className="w-4 h-4 text-blue-600" />
                    Pending Mandate Setups
                  </h3>
                  <div className="overflow-hidden rounded-lg border border-blue-200">
                    <table className="min-w-full divide-y divide-blue-200">
                      <thead className="bg-blue-50">
                        <tr>
                          <th className="px-3 py-2 text-left text-xs font-medium text-blue-800 uppercase">Account</th>
                          <th className="px-3 py-2 text-left text-xs font-medium text-blue-800 uppercase">Customer</th>
                          <th className="px-3 py-2 text-left text-xs font-medium text-blue-800 uppercase">Email</th>
                          <th className="px-3 py-2 text-center text-xs font-medium text-blue-800 uppercase">Status</th>
                          <th className="px-3 py-2 text-left text-xs font-medium text-blue-800 uppercase">Sent</th>
                          <th className="px-3 py-2 text-center text-xs font-medium text-blue-800 uppercase">Action</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-blue-100 bg-white">
                        {pendingSetupsData?.setups
                          ?.filter(s => !['completed', 'failed', 'cancelled'].includes(s.status))
                          .map(setup => (
                          <tr key={setup.id}>
                            <td className="px-3 py-2 text-sm font-medium text-gray-900">{setup.opera_account}</td>
                            <td className="px-3 py-2 text-sm text-gray-700">{setup.opera_name || '-'}</td>
                            <td className="px-3 py-2 text-sm text-gray-500">{setup.customer_email}</td>
                            <td className="px-3 py-2 text-center">
                              <span className={`inline-flex px-2 py-1 text-xs rounded-full ${
                                setup.status === 'email_sent' ? 'bg-blue-100 text-blue-800' :
                                setup.status === 'authorisation_pending' ? 'bg-amber-100 text-amber-800' :
                                setup.status === 'mandate_created' ? 'bg-green-100 text-green-800' :
                                'bg-gray-100 text-gray-800'
                              }`}>
                                {setup.status_label}
                              </span>
                            </td>
                            <td className="px-3 py-2 text-sm text-gray-500">
                              {setup.email_sent_at ? new Date(setup.email_sent_at).toLocaleDateString('en-GB') : '-'}
                            </td>
                            <td className="px-3 py-2 text-center">
                              <div className="flex items-center justify-center gap-1">
                                {setup.authorisation_url && (
                                  <a
                                    href={setup.authorisation_url}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className="inline-flex items-center gap-1 px-2 py-1 text-xs text-blue-700 bg-blue-100 rounded hover:bg-blue-200"
                                    title="Open authorisation URL"
                                  >
                                    <ExternalLink className="w-3 h-3" />
                                  </a>
                                )}
                                <button
                                  onClick={() => cancelSetupMutation.mutate(setup.id)}
                                  disabled={cancelSetupMutation.isPending}
                                  className="inline-flex items-center gap-1 px-2 py-1 text-xs text-red-700 bg-red-100 rounded hover:bg-red-200"
                                  title="Cancel setup"
                                >
                                  <Ban className="w-3 h-3" />
                                </button>
                              </div>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  {(pendingSetupsData?.setups?.some(s => s.status_detail) ?? false) && (
                    <p className="text-xs text-gray-500 mt-1">
                      {pendingSetupsData?.setups?.find(s => s.status_detail)?.status_detail}
                    </p>
                  )}
                </div>
              )}

              {/* Section 1: Customers with Mandates */}
              <div>
                <h3 className="text-sm font-semibold text-gray-900 flex items-center gap-2 mb-3">
                  <CheckCircle className="w-4 h-4 text-green-600" />
                  Customers with Mandates
                </h3>
                {loadingMandates ? (
                  <div className="flex items-center justify-center py-8">
                    <RefreshCw className="w-5 h-5 text-gray-400 animate-spin" />
                  </div>
                ) : mandatesData?.mandates && mandatesData.mandates.length > 0 ? (
                  <div className="overflow-hidden rounded-lg border border-green-200">
                    <table className="min-w-full divide-y divide-green-200">
                      <thead className="bg-green-50">
                        <tr>
                          <th className="px-3 py-2 text-left text-xs font-medium text-green-800 uppercase">Account</th>
                          <th className="px-3 py-2 text-left text-xs font-medium text-green-800 uppercase">Opera Name</th>
                          <th className="px-3 py-2 text-left text-xs font-medium text-green-800 uppercase">GoCardless Name</th>
                          <th className="px-3 py-2 text-left text-xs font-medium text-green-800 uppercase">Mandate ID</th>
                          <th className="px-3 py-2 text-center text-xs font-medium text-green-800 uppercase">Status</th>
                          <th className="px-3 py-2 text-center text-xs font-medium text-green-800 uppercase">Link</th>
                          <th className="px-3 py-2 text-center text-xs font-medium text-green-800 uppercase">Delete</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-green-100 bg-white">
                        {mandatesData.mandates.map(mandate => {
                          const isLinked = mandate.opera_account && mandate.opera_account !== '__UNLINKED__';
                          return (
                            <tr key={mandate.mandate_id}>
                              <td className="px-3 py-2 text-sm font-medium text-gray-900">
                                {isLinked ? mandate.opera_account : <span className="text-amber-600 italic">Not linked</span>}
                              </td>
                              <td className="px-3 py-2 text-sm text-gray-700">{isLinked ? (mandate.opera_name || '-') : '-'}</td>
                              <td className="px-3 py-2 text-sm text-gray-700">{mandate.gocardless_name || mandate.opera_name || '-'}</td>
                              <td className="px-3 py-2 text-sm text-gray-500 font-mono">{mandate.mandate_id}</td>
                              <td className="px-3 py-2 text-center">
                                <span className={`inline-flex px-2 py-1 text-xs rounded-full ${
                                  mandate.mandate_status === 'active'
                                    ? 'bg-green-100 text-green-800'
                                    : 'bg-gray-100 text-gray-800'
                                }`}>
                                  {mandate.mandate_status}
                                </span>
                              </td>
                              <td className="px-3 py-2 text-center">
                                <button
                                  onClick={async () => {
                                    const gcName = mandate.gocardless_name || mandate.opera_name || '';
                                    setLinkMandateId(mandate.mandate_id);
                                    setLinkGcName(gcName);
                                    setLinkOperaAccount(isLinked ? mandate.opera_account : '');
                                    setLinkOperaName(isLinked ? (mandate.opera_name || '') : '');
                                    setLinkSuggestions([]);
                                    setShowLinkModal(true);
                                    // Auto-suggest Opera customer match for unlinked mandates
                                    if (!isLinked && gcName) {
                                      setLoadingSuggestions(true);
                                      try {
                                        const res = await authFetch(gcUrl('/mandates/suggest-match', { gc_name: gcName }));
                                        const data = await res.json();
                                        if (data.success && data.suggestions?.length > 0) {
                                          setLinkSuggestions(data.suggestions);
                                          // Auto-select the top match if score >= 0.8
                                          const best = data.suggestions[0];
                                          if (best.score >= 0.8) {
                                            setLinkOperaAccount(best.account);
                                            setLinkOperaName(best.name);
                                          }
                                        }
                                      } catch { /* ignore */ }
                                      setLoadingSuggestions(false);
                                    }
                                  }}
                                  className={`inline-flex items-center gap-1 px-2 py-1 text-xs font-medium rounded ${
                                    isLinked
                                      ? 'text-green-700 bg-green-100 hover:bg-green-200'
                                      : 'text-white bg-green-600 hover:bg-green-700'
                                  }`}
                                >
                                  <Link className="w-3 h-3" />
                                  {isLinked ? 'Linked' : 'Link'}
                                </button>
                              </td>
                              <td className="px-3 py-2 text-center">
                                {mandate.mandate_status === 'active' ? (
                                  <button
                                    onClick={() => {
                                      if (window.confirm(
                                        `DELETE MANDATE\n${'='.repeat(30)}\n\nThis will permanently cancel the Direct Debit mandate for:\n${mandate.opera_name || mandate.gocardless_name || mandate.mandate_id}\n\nThe customer will no longer be able to make payments via this mandate.\nA new mandate will need to be set up if required.\n\nAre you sure?`
                                      )) {
                                        authFetch(gcUrl(`/mandates/${mandate.mandate_id}/cancel`), { method: 'POST' })
                                          .then(r => r.json())
                                          .then(d => {
                                            if (d.success) {
                                              refetchMandates();
                                            } else {
                                              alert(`Failed to cancel: ${d.error}`);
                                            }
                                          })
                                          .catch(err => alert(`Error: ${err.message}`));
                                      }
                                    }}
                                    className="inline-flex items-center gap-1 px-2 py-1 text-xs font-medium rounded text-red-700 bg-red-100 hover:bg-red-200"
                                  >
                                    <Ban className="w-3 h-3" />
                                    Delete
                                  </button>
                                ) : (
                                  <span className="text-xs text-gray-400">{mandate.mandate_status}</span>
                                )}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                ) : (
                  <p className="text-sm text-gray-500 py-4">No mandates found. Click "Sync from GoCardless" to fetch mandates.</p>
                )}
              </div>

              {/* Section 2: Customers without Mandates */}
              {(eligibleData?.customers?.filter(c => !c.has_mandate).length ?? 0) > 0 && (
                <div>
                  <h3 className="text-sm font-semibold text-gray-900 flex items-center gap-2 mb-3">
                    <AlertCircle className="w-4 h-4 text-amber-600" />
                    Customers without Mandates
                  </h3>
                  <div className="overflow-hidden rounded-lg border border-amber-200">
                    <table className="min-w-full divide-y divide-amber-200">
                      <thead className="bg-amber-50">
                        <tr>
                          <th className="px-3 py-2 text-left text-xs font-medium text-amber-800 uppercase">Account</th>
                          <th className="px-3 py-2 text-left text-xs font-medium text-amber-800 uppercase">Customer Name</th>
                          <th className="px-3 py-2 text-right text-xs font-medium text-amber-800 uppercase">Balance</th>
                          <th className="px-3 py-2 text-left text-xs font-medium text-amber-800 uppercase">Email</th>
                          <th className="px-3 py-2 text-center text-xs font-medium text-amber-800 uppercase">Action</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-amber-100 bg-white">
                        {eligibleData?.customers?.filter(c => !c.has_mandate).map(customer => (
                          <tr key={customer.account}>
                            <td className="px-3 py-2 text-sm font-medium text-gray-900">{customer.account}</td>
                            <td className="px-3 py-2 text-sm text-gray-700">{customer.name}</td>
                            <td className="px-3 py-2 text-sm text-right text-gray-700">
                              £{customer.balance.toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                            </td>
                            <td className="px-3 py-2 text-sm text-gray-500">{customer.email || '-'}</td>
                            <td className="px-3 py-2 text-center">
                              <div className="flex items-center justify-center gap-1">
                                <button
                                  onClick={async () => {
                                    setSetupAccount(customer.account);
                                    setSetupAccountName(customer.name);
                                    setSetupEmail(customer.email || '');
                                    if (!customer.email) {
                                      setLoadingSetupEmail(true);
                                      try {
                                        const res = await authFetch(gcUrl(`/customer-email/${customer.account}`));
                                        const data = await res.json();
                                        if (data.success && data.email) setSetupEmail(data.email);
                                      } catch { /* ignore */ }
                                      setLoadingSetupEmail(false);
                                    }
                                    setShowCreateMandateModal(true);
                                  }}
                                  className="inline-flex items-center gap-1 px-2 py-1 text-xs font-medium text-white bg-green-600 rounded hover:bg-green-700"
                                >
                                  <Mail className="w-3 h-3" />
                                  Create Mandate
                                </button>
                                <button
                                  onClick={() => {
                                    setLinkOperaAccount(customer.account);
                                    setLinkOperaName(customer.name);
                                    setLinkMandateId('');
                                    setLinkGcName('');
                                    setShowLinkModal(true);
                                  }}
                                  className="inline-flex items-center gap-1 px-2 py-1 text-xs font-medium text-amber-700 bg-amber-100 rounded hover:bg-amber-200"
                                  title="Link an existing GoCardless mandate"
                                >
                                  <Link className="w-3 h-3" />
                                  Link
                                </button>
                              </div>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
            </div>
          )}
          {/* Subscriptions Tab */}
          {activeTab === 'subscriptions' && (
            <div className="space-y-4">
              {/* Action buttons */}
              <div className="flex items-center justify-between">
                <p className="text-sm text-gray-500">
                  Manage recurring Direct Debit subscriptions linked to Opera repeat documents.
                </p>
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => syncSubsMutation.mutate()}
                    disabled={syncSubsMutation.isPending}
                    className="flex items-center gap-2 px-3 py-1.5 text-sm text-gray-600 hover:text-gray-800 border border-gray-300 rounded-lg hover:bg-gray-50 disabled:opacity-50"
                  >
                    <RefreshCw className={`w-4 h-4 ${syncSubsMutation.isPending ? 'animate-spin' : ''}`} />
                    {syncSubsMutation.isPending ? 'Syncing...' : 'Sync'}
                  </button>
                  <button
                    onClick={() => setShowCreateSubModal(true)}
                    className="flex items-center gap-2 px-3 py-1.5 text-sm font-medium text-white bg-green-600 rounded-lg hover:bg-green-700"
                  >
                    <Plus className="w-4 h-4" />
                    Create
                  </button>
                </div>
              </div>

              {/* Subscriptions table */}
              {loadingSubscriptions ? (
                <div className="flex items-center justify-center py-12">
                  <RefreshCw className="w-6 h-6 text-gray-400 animate-spin" />
                </div>
              ) : (subscriptionsData?.subscriptions?.length ?? 0) === 0 ? (
                <div className="text-center py-12 text-gray-500">
                  <RefreshCw className="w-12 h-12 mx-auto mb-3 text-gray-300" />
                  <p>No subscriptions found</p>
                  <p className="text-sm mt-1">Create a subscription from an Opera repeat document with department 'SUB'</p>
                </div>
              ) : (
                <div className="rounded-lg border border-gray-300 shadow-sm overflow-visible">
                  <table className="min-w-full divide-y divide-gray-300">
                    <thead className="bg-gray-100">
                      <tr>
                        <th className="px-4 py-2.5 text-left text-xs font-semibold text-gray-600 uppercase tracking-wide">Customer</th>
                        <th className="px-4 py-2.5 text-left text-xs font-semibold text-gray-600 uppercase tracking-wide">Linked Documents</th>
                        <th className="px-4 py-2.5 text-right text-xs font-semibold text-gray-600 uppercase tracking-wide">GC Amount</th>
                        <th className="px-4 py-2.5 text-right text-xs font-semibold text-gray-600 uppercase tracking-wide">Opera Total</th>
                        <th className="px-4 py-2.5 text-left text-xs font-semibold text-gray-600 uppercase tracking-wide">Frequency</th>
                        <th className="px-4 py-2.5 text-center text-xs font-semibold text-gray-600 uppercase tracking-wide">Status</th>
                        <th className="px-4 py-2.5 text-center text-xs font-semibold text-gray-600 uppercase tracking-wide">Actions</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-200 bg-white">
                      {subscriptionsData?.subscriptions.map(sub => (
                        <tr key={sub.subscription_id} className="hover:bg-gray-50">
                          <td className="px-4 py-3">
                            <div className="text-sm font-medium text-gray-900">{sub.opera_name || '-'}</div>
                            <div className="text-xs text-gray-500">{sub.opera_account}</div>
                          </td>
                          <td className="px-4 py-3">
                            {/* Linked documents as a clean table-like layout */}
                            {(sub.linked_documents || []).length > 0 ? (
                              <div className="space-y-0.5">
                                {(sub.linked_documents || []).map(doc => (
                                  <div key={doc.doc_ref} className="flex items-center justify-between gap-2 group">
                                    <div className="flex items-center gap-1.5">
                                      <span className="text-xs font-mono text-gray-700">{doc.doc_ref}</span>
                                      {doc.has_sub_tag ? (
                                        <span className="px-1 py-px text-[10px] bg-purple-50 text-purple-600 rounded" title="SUB tag set">SUB</span>
                                      ) : (
                                        <span className="px-1 py-px text-[10px] bg-red-50 text-red-600 rounded" title="SUB tag NOT set — invoices may be collected twice!">No SUB</span>
                                      )}
                                    </div>
                                    <div className="flex items-center gap-1">
                                      <span className="text-xs text-gray-500 tabular-nums">{doc.amount_formatted}</span>
                                      <button
                                        className="opacity-0 group-hover:opacity-100 text-red-400 hover:text-red-600 transition-opacity p-0.5"
                                        onClick={() => unlinkSubMutation.mutate({ subscription_id: sub.subscription_id, source_doc: doc.doc_ref })}
                                        title={`Unlink ${doc.doc_ref}`}
                                      >
                                        <X className="w-3 h-3" />
                                      </button>
                                    </div>
                                  </div>
                                ))}
                              </div>
                            ) : (
                              <span className="text-xs text-gray-400 italic">No documents linked</span>
                            )}
                            {/* Add document button + picker */}
                            <div className="relative mt-1" ref={linkingSubId === sub.subscription_id ? linkPickerRef : undefined}>
                              <button
                                onClick={() => {
                                  if (linkingSubId === sub.subscription_id) {
                                    setLinkingSubId(null);
                                  } else {
                                    const rawName = sub.opera_name || '';
                                    const cleanName = rawName
                                      .replace(/\b(ltd|limited|plc|llc|llp|inc|co|company|uk|group)\b\.?/gi, '')
                                      .replace(/\s+/g, ' ')
                                      .trim();
                                    setLinkPickerCustomer('');
                                    setLinkPickerCustomerName(cleanName || rawName);
                                    setLinkingSubId(sub.subscription_id);
                                  }
                                }}
                                className={`inline-flex items-center gap-1 px-2 py-0.5 text-xs rounded ${
                                  (sub.source_docs || []).length > 0
                                    ? 'text-gray-400 hover:text-blue-600 hover:bg-blue-50'
                                    : 'text-blue-600 bg-blue-50 border border-blue-200 hover:bg-blue-100'
                                }`}
                                title="Link repeat document"
                              >
                                <Plus className="w-3 h-3" />
                                {(sub.source_docs || []).length > 0 ? 'Add' : 'Link document'}
                              </button>
                              {linkingSubId === sub.subscription_id && (
                                <div className="absolute z-50 left-0 bottom-full mb-1 w-80 bg-white border border-gray-300 rounded-lg shadow-lg max-h-96 flex flex-col overflow-visible">
                                  <div className="px-2 py-2 border-b border-gray-200 bg-gray-50 flex-shrink-0">
                                    <CustomerAccountSearch
                                      value={linkPickerCustomer}
                                      valueName={linkPickerCustomerName}
                                      onChange={(account, name) => {
                                        setLinkPickerCustomer(account);
                                        setLinkPickerCustomerName(name);
                                      }}
                                      placeholder="Search all customers..."
                                      initialSearch={linkPickerCustomerName}
                                      onEscape={() => setLinkingSubId(null)}
                                    />
                                  </div>
                                  {linkPickerCustomer ? (
                                    loadingAllRepeatDocs ? (
                                      <div className="flex items-center justify-center py-4">
                                        <RefreshCw className="w-4 h-4 text-gray-400 animate-spin" />
                                      </div>
                                    ) : (() => {
                                      const alreadyLinked = new Set(sub.source_docs || []);
                                      const allDocs = (allRepeatDocsData?.documents || []).filter(d => !d.has_subscription && !alreadyLinked.has(d.doc_ref));
                                      const filteredDocs = allDocs.filter(d => d.opera_account.trim() === linkPickerCustomer.trim());

                                      return (
                                        <div className="overflow-y-auto flex-1">
                                          <div className="px-3 py-2 bg-green-50 border-b border-green-200 text-xs text-green-800">
                                            Selected: <strong>{linkPickerCustomerName || linkPickerCustomer}</strong> — {filteredDocs.length} document{filteredDocs.length !== 1 ? 's' : ''} available
                                          </div>
                                          {filteredDocs.length === 0 ? (
                                            <div className="px-3 py-3 text-xs text-amber-700 bg-amber-50 text-center">
                                              No active repeat documents for {linkPickerCustomerName || linkPickerCustomer}. Check the customer has an active repeat invoice in Opera (not finished or expired).
                                            </div>
                                          ) : (
                                            filteredDocs.map(doc => (
                                              <button
                                                key={doc.doc_ref}
                                                className="w-full text-left px-3 py-2 text-sm border-b border-gray-100 hover:bg-blue-50"
                                                onClick={() => {
                                                  linkSubMutation.mutate({ subscription_id: sub.subscription_id, source_doc: doc.doc_ref });
                                                  setLinkingSubId(null);
                                                }}
                                              >
                                                <div className="flex items-center justify-between">
                                                  <span className="font-mono text-xs">{doc.doc_ref}</span>
                                                  <span className="text-xs text-gray-600">{doc.amount_formatted}</span>
                                                </div>
                                                <div className="text-xs text-gray-400">{doc.frequency}{doc.customer_ref ? ` \u2022 ${doc.customer_ref}` : ''}</div>
                                              </button>
                                            ))
                                          )}
                                        </div>
                                      );
                                    })()
                                  ) : (
                                    <div className="px-3 py-3 text-xs text-gray-500 text-center">
                                      Search for a customer to view their repeat documents
                                    </div>
                                  )}
                                </div>
                              )}
                            </div>
                          </td>
                          <td className="px-4 py-3 text-right">
                            <div className="text-sm font-medium text-gray-900 tabular-nums">{sub.amount_formatted}</div>
                          </td>
                          <td className="px-4 py-3 text-right">
                            {sub.opera_amount_formatted ? (
                              <div>
                                <div className={`text-sm font-medium tabular-nums ${sub.mismatch ? 'text-amber-700' : 'text-gray-900'}`}>
                                  {sub.opera_amount_formatted}
                                </div>
                                {(sub.linked_documents || []).length > 1 && (
                                  <div className="text-[10px] text-gray-400">{(sub.linked_documents || []).length} docs</div>
                                )}
                                {sub.mismatch && (
                                  <button
                                    onClick={() => {
                                      if (window.confirm(`LIVE GoCardless Action\n${'='.repeat(30)}\n\nThis will UPDATE the recurring Direct Debit for:\n${sub.opera_name || sub.opera_account}\n\nCurrent GC amount: ${sub.amount_formatted}\nNew amount (from Opera): ${sub.opera_amount_formatted}\n\nThe customer's next DD collection will be at the new amount.\n\nAre you sure?`)) {
                                        syncFromOperaMutation.mutate(sub.subscription_id);
                                      }
                                    }}
                                    disabled={syncFromOperaMutation.isPending}
                                    className="mt-0.5 inline-flex items-center gap-0.5 px-1.5 py-0.5 text-xs font-medium text-white bg-amber-600 rounded hover:bg-amber-700 disabled:opacity-50"
                                    title={sub.mismatch.details.join(', ')}
                                  >
                                    <RefreshCw className={`w-3 h-3 ${syncFromOperaMutation.isPending ? 'animate-spin' : ''}`} />
                                    Sync
                                  </button>
                                )}
                              </div>
                            ) : (
                              <span className="text-xs text-gray-400">-</span>
                            )}
                          </td>
                          <td className="px-4 py-3 text-sm text-gray-700">{sub.frequency}</td>
                          <td className="px-4 py-3 text-center">
                            <span className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-medium ${
                              sub.status === 'active' ? 'bg-green-100 text-green-800' :
                              sub.status === 'paused' ? 'bg-yellow-100 text-yellow-800' :
                              sub.status === 'cancelled' ? 'bg-red-100 text-red-800' :
                              'bg-gray-100 text-gray-800'
                            }`}>
                              {sub.status === 'active' && <CheckCircle className="w-3 h-3" />}
                              {sub.status === 'paused' && <Pause className="w-3 h-3" />}
                              {sub.status === 'cancelled' && <Ban className="w-3 h-3" />}
                              {sub.status.charAt(0).toUpperCase() + sub.status.slice(1)}
                            </span>
                          </td>
                          <td className="px-4 py-3 text-center">
                            <div className="flex items-center justify-center gap-1">
                              {sub.status === 'active' && (
                                <button
                                  onClick={() => {
                                    if (window.confirm(`LIVE GoCardless Action\n${'='.repeat(30)}\n\nThis will PAUSE the recurring Direct Debit for:\n${sub.opera_name || sub.opera_account || 'Unknown customer'}\n\nAmount: ${sub.amount_formatted} ${sub.frequency || ''}\n\nWhile paused, no collections will be taken from the customer.\nYou can resume the subscription later.\n\nAre you sure?`)) {
                                      pauseSubMutation.mutate(sub.subscription_id);
                                    }
                                  }}
                                  disabled={pauseSubMutation.isPending}
                                  className="inline-flex items-center gap-1 px-2 py-1 text-xs text-yellow-700 bg-yellow-50 border border-yellow-200 rounded hover:bg-yellow-100 disabled:opacity-50"
                                  title="Pause subscription"
                                >
                                  <Pause className="w-3 h-3" />
                                  Pause
                                </button>
                              )}
                              {sub.status === 'paused' && (
                                <button
                                  onClick={() => {
                                    if (window.confirm(`LIVE GoCardless Action\n${'='.repeat(30)}\n\nThis will RESUME the recurring Direct Debit for:\n${sub.opera_name || sub.opera_account || 'Unknown customer'}\n\nAmount: ${sub.amount_formatted} ${sub.frequency || ''}\n\nCollections will restart from the next scheduled date.\n\nAre you sure?`)) {
                                      resumeSubMutation.mutate(sub.subscription_id);
                                    }
                                  }}
                                  disabled={resumeSubMutation.isPending}
                                  className="inline-flex items-center gap-1 px-2 py-1 text-xs text-green-700 bg-green-50 border border-green-200 rounded hover:bg-green-100 disabled:opacity-50"
                                  title="Resume subscription"
                                >
                                  <Play className="w-3 h-3" />
                                  Resume
                                </button>
                              )}
                              {sub.status !== 'cancelled' && (
                                <button
                                  onClick={() => {
                                    if (window.confirm(`LIVE GoCardless Action\n${'='.repeat(30)}\n\nThis will PERMANENTLY CANCEL the recurring Direct Debit for:\n${sub.opera_name || sub.opera_account}\n\nAmount: ${sub.amount_formatted} ${sub.frequency}\n\nThis CANNOT be undone. The customer will no longer be collected from.\n\nAre you sure?`)) {
                                      cancelSubMutation.mutate(sub.subscription_id);
                                    }
                                  }}
                                  disabled={cancelSubMutation.isPending}
                                  className="inline-flex items-center gap-1 px-2 py-1 text-xs text-red-700 bg-red-50 border border-red-200 rounded hover:bg-red-100 disabled:opacity-50"
                                  title="Cancel subscription"
                                >
                                  <X className="w-3 h-3" />
                                  Cancel
                                </button>
                              )}
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}
        </div>
      </Card>

      {/* Create Subscription Modal */}
      {showCreateSubModal && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-start justify-center z-50 overflow-y-auto py-8">
          <div className="bg-white rounded-lg shadow-xl w-full max-w-2xl p-6 my-auto">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-lg font-semibold">Create Subscriptions</h3>
              <button onClick={() => setShowCreateSubModal(false)} className="text-gray-400 hover:text-gray-600">
                <X className="w-5 h-5" />
              </button>
            </div>

            <p className="text-sm text-gray-500 mb-4">
              Create new GoCardless subscriptions from Opera repeat documents.
              Customers need an active mandate to create subscriptions.
            </p>

            {/* Frequency type filter */}
            {repeatDocsData && repeatDocsData.documents.length > 0 && (() => {
              const freqCounts = repeatDocsData.documents.reduce<Record<string, { label: string; count: number }>>((acc, d) => {
                const code = d.frequency_code || '?';
                if (!acc[code]) acc[code] = { label: d.frequency || code, count: 0 };
                acc[code].count++;
                return acc;
              }, {});
              return (
                <div className="flex items-center gap-2 mb-3">
                  <label className="text-sm text-gray-600">Type:</label>
                  <select
                    value={repeatDocFreqFilter}
                    onChange={e => setRepeatDocFreqFilter(e.target.value)}
                    className="border border-gray-300 rounded-md px-3 py-1.5 text-sm bg-white focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                  >
                    <option value="all">All ({repeatDocsData.documents.length})</option>
                    {Object.entries(freqCounts).sort(([,a],[,b]) => b.count - a.count).map(([code, { label, count }]) => (
                      <option key={code} value={code}>{code} — {label} ({count})</option>
                    ))}
                  </select>
                </div>
              );
            })()}

            {repeatDocsData && (
              <div className="flex gap-2 text-xs mb-3">
                <span className="px-2.5 py-1 text-gray-600">{repeatDocsData.count} repeat documents</span>
                <span className="px-2.5 py-1 text-blue-600">{repeatDocsData.with_subscription} linked</span>
              </div>
            )}

            {loadingRepeatDocs ? (
              <div className="flex items-center justify-center py-8">
                <RefreshCw className="w-5 h-5 text-gray-400 animate-spin" />
              </div>
            ) : (repeatDocsData?.documents?.length ?? 0) === 0 ? (
              <div className="text-center py-8 text-gray-500">
                <FileText className="w-10 h-10 mx-auto mb-2 text-gray-300" />
                <p>No repeat documents found</p>
                <p className="text-xs mt-1">Repeat documents are cumulative invoices (ih_docstat='U') in Opera</p>
              </div>
            ) : (
              <div className="space-y-2">
                {repeatDocsData?.documents.filter(doc =>
                  repeatDocFreqFilter === 'all' || doc.frequency_code === repeatDocFreqFilter
                ).map(doc => (
                  <div
                    key={doc.doc_ref}
                    className={`border rounded-lg p-3 ${
                      doc.has_subscription
                        ? 'border-gray-200 bg-gray-50 opacity-60'
                        : 'border-green-200 hover:border-green-400 cursor-pointer'
                    }`}
                  >
                    <div className="flex items-center justify-between">
                      <div className="flex-1">
                        <div className="flex items-center gap-2">
                          <span className="font-medium text-gray-900">{doc.customer_name}</span>
                          <span className="text-xs text-gray-500 font-mono">({doc.opera_account})</span>
                        </div>
                        <div className="flex items-center gap-3 mt-1 text-sm text-gray-600">
                          <span className="font-mono text-xs">{doc.doc_ref}</span>
                          <span>{doc.amount_formatted} inc VAT</span>
                          <span>{doc.frequency}</span>
                          {doc.customer_ref && <span className="text-gray-400">{doc.customer_ref}</span>}
                        </div>
                        {doc.start_date && (
                          <div className="text-xs text-gray-400 mt-0.5">
                            Contract: {doc.start_date} to {doc.end_date || 'ongoing'}
                          </div>
                        )}
                      </div>
                      <div className="ml-4 flex flex-col gap-1 items-end">
                        {doc.has_subscription ? (
                          <div className="flex flex-col gap-1 items-end">
                            <div className="flex items-center gap-2">
                              <span className="inline-flex items-center gap-1 px-2 py-1 text-xs bg-green-100 text-green-700 rounded">
                                <CheckCircle className="w-3 h-3" />
                                Linked ({doc.subscription_status || 'active'})
                              </span>
                              <button
                                onClick={() => {
                                  if (window.confirm(`Unlink subscription from ${doc.doc_ref}?`)) {
                                    unlinkSubMutation.mutate({ subscription_id: doc.subscription_id!, source_doc: doc.doc_ref });
                                  }
                                }}
                                disabled={unlinkSubMutation.isPending}
                                className="inline-flex items-center gap-1 px-2 py-1 text-xs text-gray-500 hover:text-red-600 hover:bg-red-50 rounded"
                              >
                                <X className="w-3 h-3" />
                                Unlink
                              </button>
                            </div>
                            {doc.mismatch && (
                              <div className="flex items-center gap-2">
                                <span className="text-xs text-amber-700 bg-amber-50 border border-amber-200 px-2 py-1 rounded">
                                  <AlertCircle className="w-3 h-3 inline mr-1" />
                                  {doc.mismatch.details[0]}
                                </span>
                                <button
                                  onClick={() => {
                                    if (window.confirm(`LIVE GoCardless Action\n${'='.repeat(30)}\n\nThis will UPDATE the recurring Direct Debit for:\n${doc.customer_name}\n\nCurrent amount: ${doc.mismatch!.sub_amount_formatted}\nNew amount: ${doc.mismatch!.doc_amount_formatted}\n\nThe customer's next DD collection will be at the new amount.\n\nAre you sure?`)) {
                                      syncFromOperaMutation.mutate(doc.subscription_id!);
                                    }
                                  }}
                                  disabled={syncFromOperaMutation.isPending}
                                  className="inline-flex items-center gap-1 px-2 py-1 text-xs font-medium text-white bg-amber-600 rounded hover:bg-amber-700 disabled:opacity-50"
                                >
                                  {syncFromOperaMutation.isPending ? (
                                    <RefreshCw className="w-3 h-3 animate-spin" />
                                  ) : (
                                    <RefreshCw className="w-3 h-3" />
                                  )}
                                  Update GC
                                </button>
                              </div>
                            )}
                          </div>
                        ) : doc.matching_subscription ? (
                          <>
                            <div className="text-xs text-gray-500 text-right">
                              Match: {doc.matching_subscription.name || doc.matching_subscription.subscription_id}
                              <span className="ml-1 text-gray-400">({doc.matching_subscription.amount_formatted})</span>
                            </div>
                            <button
                              onClick={() => {
                                linkSubMutation.mutate({
                                  subscription_id: doc.matching_subscription!.subscription_id,
                                  source_doc: doc.doc_ref
                                });
                              }}
                              disabled={linkSubMutation.isPending}
                              className="inline-flex items-center gap-1 px-3 py-1.5 text-xs font-medium text-white bg-blue-600 rounded hover:bg-blue-700 disabled:opacity-50"
                            >
                              {linkSubMutation.isPending ? (
                                <RefreshCw className="w-3 h-3 animate-spin" />
                              ) : (
                                <Link className="w-3 h-3" />
                              )}
                              Link Existing
                            </button>
                          </>
                        ) : (
                          <button
                            onClick={() => {
                              if (window.confirm(`LIVE GoCardless Action\n${'='.repeat(30)}\n\nThis will CREATE a new recurring Direct Debit for:\n${doc.customer_name}\n\nAmount: ${doc.amount_formatted}\nFrequency: ${doc.frequency}\nDocument: ${doc.doc_ref}\n\nThe customer will be charged ${doc.amount_formatted} ${doc.frequency?.toLowerCase() || ''} via Direct Debit starting from their next collection date.\n\nAre you sure?`)) {
                                createSubMutation.mutate({ source_doc: doc.doc_ref });
                              }
                            }}
                            disabled={createSubMutation.isPending}
                            className="inline-flex items-center gap-1 px-3 py-1.5 text-xs font-medium text-white bg-green-600 rounded hover:bg-green-700 disabled:opacity-50"
                          >
                            {createSubMutation.isPending ? (
                              <RefreshCw className="w-3 h-3 animate-spin" />
                            ) : (
                              <Plus className="w-3 h-3" />
                            )}
                            Create New
                          </button>
                        )}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}

            <div className="flex justify-end mt-6">
              <button
                onClick={() => setShowCreateSubModal(false)}
                className="px-4 py-2 text-sm text-gray-700 border border-gray-300 rounded-lg hover:bg-gray-50"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Create Mandate Modal */}
      {showCreateMandateModal && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-start justify-center z-50 overflow-y-auto py-8">
          <div className="bg-white rounded-lg shadow-xl w-full max-w-md p-6 my-auto">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-lg font-semibold">Create Mandate</h3>
              <button onClick={() => setShowCreateMandateModal(false)} className="text-gray-400 hover:text-gray-600">
                <X className="w-5 h-5" />
              </button>
            </div>

            <p className="text-sm text-gray-600 mb-4">
              Search for an Opera customer, then send them an email with a link to set up their Direct Debit mandate through GoCardless.
            </p>

            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Opera Customer
                </label>
                <CustomerAccountSearch
                  value={setupAccount}
                  valueName={setupAccountName}
                  onChange={async (account, name) => {
                    setSetupAccount(account);
                    setSetupAccountName(name);
                    if (account) {
                      setLoadingSetupEmail(true);
                      try {
                        const res = await authFetch(gcUrl(`/customer-email/${account}`));
                        const data = await res.json();
                        if (data.success && data.email) {
                          setSetupEmail(data.email);
                        } else {
                          setSetupEmail('');
                        }
                      } catch {
                        setSetupEmail('');
                      }
                      setLoadingSetupEmail(false);
                    } else {
                      setSetupEmail('');
                    }
                  }}
                  placeholder="Type to search Opera customers..."
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Customer Email
                </label>
                {loadingSetupEmail ? (
                  <div className="flex items-center gap-2 px-3 py-2 border border-gray-200 rounded-lg bg-gray-50">
                    <RefreshCw className="w-4 h-4 text-gray-400 animate-spin" />
                    <span className="text-sm text-gray-500">Loading email from Opera...</span>
                  </div>
                ) : (
                  <input
                    type="email"
                    value={setupEmail}
                    onChange={e => setSetupEmail(e.target.value)}
                    placeholder="customer@example.com"
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-green-500 focus:border-green-500"
                  />
                )}
                <p className="text-xs text-gray-500 mt-1">
                  The authorisation link will be sent to this email address. You can override the Opera default if needed.
                </p>
              </div>

              {setupAccount && setupEmail && (
                <div className="p-3 bg-blue-50 border border-blue-200 rounded-lg text-sm">
                  <p className="font-medium text-blue-900">
                    An email will be sent to <span className="font-mono">{setupEmail}</span> with a secure link to set up a Direct Debit mandate via GoCardless.
                  </p>
                  <p className="text-blue-700 mt-1">
                    Once the customer completes the authorisation, the mandate will be automatically linked to {setupAccountName || setupAccount} and the account flagged as GC.
                  </p>
                </div>
              )}
            </div>

            <div className="flex justify-end gap-3 mt-6">
              <button
                onClick={() => setShowCreateMandateModal(false)}
                className="px-4 py-2 text-sm text-gray-700 border border-gray-300 rounded-lg hover:bg-gray-50"
              >
                Cancel
              </button>
              <button
                onClick={() => createMandateSetupMutation.mutate({
                  opera_account: setupAccount,
                  opera_name: setupAccountName,
                  customer_email: setupEmail,
                })}
                disabled={!setupAccount || !setupEmail || createMandateSetupMutation.isPending}
                className="flex items-center gap-2 px-4 py-2 text-sm font-medium text-white bg-green-600 rounded-lg hover:bg-green-700 disabled:opacity-50"
              >
                <Send className="w-4 h-4" />
                {createMandateSetupMutation.isPending ? 'Sending...' : 'Send Authorisation Email'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Link Mandate Modal */}
      {showLinkModal && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-start justify-center z-50 overflow-y-auto py-8">
          <div className="bg-white rounded-lg shadow-xl w-full max-w-md p-6 my-auto">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-lg font-semibold">Link GoCardless Mandate</h3>
              <button onClick={() => setShowLinkModal(false)} className="text-gray-400 hover:text-gray-600">
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="space-y-4">
              {/* GoCardless mandate info — visual reference for the user */}
              {linkMandateId && linkGcName && (
                <div className="p-3 bg-blue-50 border border-blue-200 rounded-lg">
                  <p className="text-xs font-medium text-blue-600 uppercase tracking-wide mb-1">GoCardless Mandate</p>
                  <p className="text-sm font-semibold text-blue-900">{linkGcName}</p>
                  <p className="text-xs text-blue-700 font-mono">{linkMandateId}</p>
                </div>
              )}

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  GoCardless Mandate ID
                </label>
                <input
                  type="text"
                  value={linkMandateId}
                  onChange={e => setLinkMandateId(e.target.value)}
                  placeholder="e.g., MD00XXXXXXXX"
                  className={`w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-green-500 focus:border-green-500 ${linkGcName ? 'bg-gray-50' : ''}`}
                  readOnly={!!linkGcName}
                />
                {!linkGcName && (
                  <p className="text-xs text-gray-500 mt-1">
                    Find mandate IDs in your GoCardless dashboard under Customers &gt; Mandates
                  </p>
                )}
              </div>

              {/* Suggested matches based on GoCardless name */}
              {loadingSuggestions && (
                <p className="text-xs text-gray-500 italic">Finding best Opera customer match...</p>
              )}
              {linkSuggestions.length > 0 && (
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Suggested Match{linkSuggestions.length > 1 ? 'es' : ''}
                  </label>
                  <div className="space-y-1">
                    {linkSuggestions.map((s) => (
                      <button
                        key={s.account}
                        onClick={() => {
                          setLinkOperaAccount(s.account);
                          setLinkOperaName(s.name);
                        }}
                        className={`w-full text-left px-3 py-2 rounded-lg border text-sm flex items-center justify-between ${
                          linkOperaAccount === s.account
                            ? 'border-green-500 bg-green-50 text-green-900'
                            : 'border-gray-200 hover:border-gray-300 hover:bg-gray-50'
                        }`}
                      >
                        <span>
                          <span className="font-mono text-xs text-gray-500 mr-2">{s.account}</span>
                          <span className="font-medium">{s.name}</span>
                          {s.is_gc && <span className="ml-2 px-1.5 py-0.5 text-xs bg-green-100 text-green-700 rounded">GC</span>}
                        </span>
                        <span className={`text-xs font-medium ${
                          s.score >= 0.9 ? 'text-green-600' : s.score >= 0.7 ? 'text-amber-600' : 'text-gray-400'
                        }`}>
                          {Math.round(s.score * 100)}%
                        </span>
                      </button>
                    ))}
                  </div>
                </div>
              )}

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  {linkSuggestions.length > 0 ? 'Or search manually' : 'Opera Account Code'}
                </label>
                <CustomerAccountSearch
                  value={linkOperaAccount}
                  valueName={linkOperaName}
                  onChange={(account, name) => {
                    setLinkOperaAccount(account);
                    setLinkOperaName(name);
                  }}
                  placeholder="Type to search Opera customers..."
                />
              </div>

              {/* Show eligible customers for quick selection */}
              {eligibleData?.customers && eligibleData.customers.length > 0 && !linkGcName && !linkSuggestions.length && (
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Or select from eligible customers:
                  </label>
                  <select
                    value={linkOperaAccount}
                    onChange={e => {
                      if (!e.target.value) return;
                      const selected = eligibleData.customers.find(c => c.account === e.target.value);
                      if (selected) {
                        setLinkOperaAccount(selected.account);
                        setLinkOperaName(selected.name);
                      }
                    }}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-green-500 focus:border-green-500"
                  >
                    <option value="">-- Select customer --</option>
                    {eligibleData.customers
                      .sort((a, b) => a.name.localeCompare(b.name))
                      .map(c => (
                        <option
                          key={c.account}
                          value={c.account}
                          disabled={c.has_mandate}
                        >
                          {c.account} - {c.name}{c.has_mandate ? ' (already linked)' : ''}
                        </option>
                      ))
                    }
                  </select>
                </div>
              )}
            </div>

            <div className="flex justify-end gap-3 mt-6">
              <button
                onClick={() => setShowLinkModal(false)}
                className="px-4 py-2 text-sm text-gray-700 border border-gray-300 rounded-lg hover:bg-gray-50"
              >
                Cancel
              </button>
              <button
                onClick={() => linkMandateMutation.mutate({
                  opera_account: linkOperaAccount,
                  mandate_id: linkMandateId,
                  opera_name: linkOperaName || undefined
                })}
                disabled={!linkOperaAccount || !linkMandateId || linkMandateMutation.isPending}
                className="px-4 py-2 text-sm font-medium text-white bg-green-600 rounded-lg hover:bg-green-700 disabled:opacity-50"
              >
                {linkMandateMutation.isPending ? 'Linking...' : 'Link Mandate'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
