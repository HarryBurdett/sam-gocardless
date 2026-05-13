/**
 * GoCardless plugin entry component.
 *
 * Renders the three legacy pages (Import wizard, Requests/Mandates/
 * Subscriptions, Settings) behind a small top-tab nav. The Partner
 * OAuth callback view is rendered when the host's URL carries the
 * GoCardless redirect parameters.
 *
 * The wrapper mounts inside SAM's plugin shell — the SAM AppShell
 * still owns global chrome (top bar, app switcher, etc.). In the
 * standalone host, the tab nav here is the only navigation surface.
 */
import { useEffect, useMemo, useState } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  CreditCard,
  Send,
  Settings as SettingsIcon,
  LogOut,
} from 'lucide-react';
import type { SamPluginContext } from './sam';
import { setSamContext } from './api-shim';
import { GoCardlessImport } from './GoCardlessImport';
import GoCardlessRequests from './Requests';
import { GoCardlessSettings } from './Settings';
import { GoCardlessCallback } from './PartnerCallback';

type Tab = 'import' | 'requests' | 'settings' | 'callback';

const TABS: ReadonlyArray<{ id: Tab; label: string; icon: React.ComponentType<{ className?: string }> }> = [
  { id: 'import', label: 'Import', icon: CreditCard },
  { id: 'requests', label: 'Requests / Mandates', icon: Send },
  { id: 'settings', label: 'Settings', icon: SettingsIcon },
];

function detectInitialTab(): Tab {
  // GoCardless redirects the merchant back with a ?code & ?state pair
  // for the partner OAuth flow. Show the callback view in that case.
  if (typeof window !== 'undefined') {
    const params = new URLSearchParams(window.location.search);
    if (params.has('code') && params.has('state')) return 'callback';
  }
  return 'import';
}

export default function GoCardless({ context }: { context: SamPluginContext }) {
  useEffect(() => {
    setSamContext(context);
  }, [context]);

  const [tab, setTab] = useState<Tab>(detectInitialTab);

  const queryClient = useMemo(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: { retry: 1, refetchOnWindowFocus: false },
        },
      }),
    [],
  );

  const companyLabel = context.currentCompany?.name ?? context.currentCompany?.code ?? null;

  async function handleLogout() {
    try {
      await fetch('/auth/logout', { method: 'POST' });
    } finally {
      window.location.href = '/login.html';
    }
  }

  return (
    <div className="gocardless-app">
      <QueryClientProvider client={queryClient}>
        <div className="min-h-screen bg-gray-50">
          <div className="border-b border-gray-200 bg-white">
            <div className="max-w-7xl mx-auto px-6 py-3 flex items-center justify-between">
              <nav className="flex items-center gap-1">
                {TABS.map(({ id, label, icon: Icon }) => (
                  <button
                    key={id}
                    type="button"
                    onClick={() => setTab(id)}
                    className={
                      'flex items-center gap-2 px-3 py-1.5 rounded-lg text-sm font-medium transition-colors ' +
                      (tab === id
                        ? 'bg-blue-50 text-blue-700'
                        : 'text-gray-600 hover:bg-gray-100 hover:text-gray-900')
                    }
                  >
                    <Icon className="h-4 w-4" />
                    {label}
                  </button>
                ))}
              </nav>
              <div className="flex items-center gap-3">
                {companyLabel && (
                  <span className="text-xs px-2 py-1 bg-gray-100 text-gray-700 rounded-full font-medium">
                    {companyLabel}
                  </span>
                )}
                <button
                  type="button"
                  onClick={handleLogout}
                  className="flex items-center gap-2 px-3 py-1.5 text-sm text-gray-600 hover:text-gray-900 hover:bg-gray-100 rounded-lg transition-colors"
                  title="Log out / switch company"
                >
                  <LogOut className="h-4 w-4" />
                  Log out
                </button>
              </div>
            </div>
          </div>

          <div className="max-w-7xl mx-auto px-6 py-6">
            {tab === 'import' && <GoCardlessImport />}
            {tab === 'requests' && <GoCardlessRequests />}
            {tab === 'settings' && <GoCardlessSettings />}
            {tab === 'callback' && (
              <GoCardlessCallback onNavigate={(t) => setTab(t === 'import' ? 'import' : t === 'settings' ? 'settings' : 'requests')} />
            )}
          </div>
        </div>
      </QueryClientProvider>
    </div>
  );
}
