/**
 * SAM frontend context shape.
 *
 * Mirrors `AppShell.tsx` (packages/frontend/src/plugins/AppShell.tsx)
 * — the `context` prop the host passes to the plugin's entry component.
 *
 * `api.fetch(path, options)` does:
 *   - prefixes /api/apps/<appId>
 *   - injects Authorization: Bearer <token>
 *   - injects X-Opera-Company when a company is selected
 *   - parses JSON
 */

export interface SamUser {
  userId?: string;
  email?: string;
  name?: string;
  role?: 'admin' | 'user' | 'sam-admin';
  appRole?: string | null;
  appConfig?: Record<string, unknown> | null;
}

export interface SamCompany {
  code: string;
  name?: string;
}

export interface SamApiClient {
  baseUrl: string;
  fetch: <T = unknown>(path: string, options?: RequestInit) => Promise<T>;
}

export interface SamPluginContext {
  appId: string;
  user: SamUser | null;
  token: string | null;
  currentCompany: SamCompany | null;
  api: SamApiClient;
  /** Optional events bus the host may inject (company:changed etc.) */
  events?: EventTarget;
}

export interface SamAppEntry {
  id: string;
  component: (props: { context: SamPluginContext }) => unknown;
}

declare global {
  interface Window {
    __SAM_APPS__?: Record<string, SamAppEntry>;
    __SAM_SHARED__?: {
      react?: typeof import('react');
      reactDom?: typeof import('react-dom');
    };
  }
}
