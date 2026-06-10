import type { ReactNode } from 'react';

/**
 * Single source of truth for the version label rendered next to
 * every page header (e.g. "GoCardless Import - Live Version 1.4").
 *
 * The value is injected at BUILD TIME by Vite via the `define`
 * block in vite.config.ts, which reads `package.json#version`.
 * Future releases only need to bump package.json + manifest.json
 * — this label updates automatically. No more three-place edits.
 *
 * Falls back to 'dev' when the global isn't defined (e.g. running
 * a non-Vite test harness directly against the source).
 *
 * Display form is `major.minor` (e.g. "1.4") to match the existing
 * label convention. The full semver remains in __APP_VERSION__ if
 * a more precise display is ever wanted.
 */
declare const __APP_VERSION__: string | undefined;

const FULL_VERSION =
  typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : 'dev';

export const LIVE_VERSION =
  FULL_VERSION === 'dev'
    ? 'dev'
    : FULL_VERSION.split('.').slice(0, 2).join('.');

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
