import type { ReactNode } from 'react';

/**
 * Single source of truth for the version label rendered next to
 * every page header (e.g. "GoCardless Import - Live Version 1.4").
 * Bump on each release.
 *
 * 1.4 — Phase B2+B3 of per-company isolation: migration 009 +
 *       companyCode plumbed through every remaining per-company
 *       table — gocardless_mandates, gocardless_imports,
 *       mandate_setup_requests, gocardless_payment_requests,
 *       gocardless_subscriptions, gocardless_subscription_documents,
 *       gocardless_partner_signups. Cross-tenant isolation is now
 *       complete across the entire plugin.
 *
 * 1.2 — Phase A: cross-company settings isolation (migration 008 +
 *       companyScope fail-loud helper + companyCode plumbed through
 *       loadSettings/saveSettings and every (appDb)-only helper).
 *       Plus earlier production fixes: cross-pstid ntran balance
 *       check (f2d8fa2) and defensive sessionStorage scoping
 *       (1481dbe).
 */
export const LIVE_VERSION = '1.4';

interface PageHeaderProps {
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  subtitle?: string;
  children?: ReactNode;
}

export function PageHeader({ icon: Icon, title, subtitle, children }: PageHeaderProps) {
  return (
    <div className="flex items-center justify-between">
      <div className="flex items-center gap-3">
        <div className="w-10 h-10 bg-blue-50 rounded-xl flex items-center justify-center">
          <Icon className="h-5 w-5 text-blue-600" />
        </div>
        <div>
          <h1 className="text-xl font-bold text-gray-900">
            {title}
            <span className="ml-2 text-xs font-medium text-gray-400">
              Live Version {LIVE_VERSION}
            </span>
          </h1>
          {subtitle && <p className="text-sm text-gray-500">{subtitle}</p>}
        </div>
      </div>
      {children && <div className="flex items-center gap-2">{children}</div>}
    </div>
  );
}
