/**
 * Default GoCardless email-ingest adapter.
 *
 * Bridges SAM's `ctx.emailIngest` onto the gocardless plugin's
 * `EmailMailboxAdapter`. Subscribes via `registerHandler`, keeps a
 * bounded in-memory cache keyed by sequential numeric IDs (the
 * frontend table needs stable integer keys; Graph message IDs are
 * opaque strings), and exposes a `list({ search, fromDate, toDate,
 * pageSize })` interface that filters the cache by subject/body text.
 *
 * Activates when `ctx.emailIngest` is wired AND the tenant has
 * configured at least one mailbox via `ctx.config.mailboxes`. Mirrors
 * the bank-reconcile adapter — same lifecycle, same per-plugin cache,
 * same shutdown semantics — but a different list contract.
 */
import type { EmailMailboxAdapter } from './scan-emails.js';
import type { SamEmailIngestService } from '../app-context.js';
interface IngestOptions {
    emailIngest: SamEmailIngestService;
    /**
     * App ID. Used only to filter `onOwnershipChange` events.
     */
    appId: string;
    /**
     * Optional starter mailbox list. When omitted (the production
     * path), the adapter calls `listMyMailboxes()` itself.
     */
    initialMailboxes?: Array<{
        id: string;
        email_address?: string | null;
    }>;
    cacheSize?: number;
    logger?: {
        info: (m: string, ...a: unknown[]) => void;
        warn: (m: string, ...a: unknown[]) => void;
        error: (m: string, ...a: unknown[]) => void;
    };
}
export interface DefaultEmailIngestAdapter {
    mailbox: EmailMailboxAdapter;
    shutdown: () => Promise<void>;
}
export declare function createDefaultEmailIngestAdapter(options: IngestOptions): DefaultEmailIngestAdapter;
export {};
//# sourceMappingURL=default-email-ingest.d.ts.map