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
import type {
  EmailMailboxAdapter,
  ScannedEmail,
} from './scan-emails.js';
import type { SamEmailIngestService } from '../app-context.js';

interface CachedMessage {
  id: number;
  graphMessageId: string;
  subject: string | null;
  bodyText: string | null;
  bodyHtml: string | null;
  fromAddress: string | null;
  receivedAt: string | null;
}

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
  initialMailboxes?: Array<{ id: string; email_address?: string | null }>;
  cacheSize?: number;
  logger?: {
    info: (m: string, ...a: unknown[]) => void;
    warn: (m: string, ...a: unknown[]) => void;
    error: (m: string, ...a: unknown[]) => void;
  };
}

function pickField<T = unknown>(obj: unknown, ...keys: string[]): T | undefined {
  if (!obj || typeof obj !== 'object') return undefined;
  for (const k of keys) {
    const v = (obj as Record<string, unknown>)[k];
    if (v !== undefined && v !== null) return v as T;
  }
  return undefined;
}

function normaliseMessage(raw: unknown, id: number): CachedMessage {
  const graphId = pickField<string>(raw, 'id', 'message_id', 'messageId') ?? '';
  const subject = pickField<string>(raw, 'subject') ?? null;

  const fromObj = pickField<unknown>(raw, 'from', 'sender') ?? null;
  let fromAddress: string | null = null;
  if (typeof fromObj === 'string') fromAddress = fromObj;
  else if (fromObj && typeof fromObj === 'object') {
    const ea = pickField<{ address?: string }>(
      fromObj,
      'emailAddress',
      'email_address',
    );
    fromAddress =
      ea?.address ??
      pickField<string>(fromObj, 'address', 'email') ??
      null;
  }

  const receivedRaw = pickField<string | Date>(
    raw,
    'received_at',
    'receivedDateTime',
    'received',
  );
  const receivedAt =
    receivedRaw instanceof Date
      ? receivedRaw.toISOString()
      : typeof receivedRaw === 'string'
        ? receivedRaw
        : null;

  // Microsoft Graph delivers body as { content, contentType } where
  // contentType is 'text' or 'html'. Plugins may also pass plain
  // strings in `body_text` / `body_html`.
  const bodyText =
    pickField<string>(raw, 'body_text', 'bodyText') ??
    (() => {
      const b = pickField<unknown>(raw, 'body');
      if (b && typeof b === 'object') {
        const ct = pickField<string>(b, 'contentType', 'content_type');
        const content = pickField<string>(b, 'content');
        if (ct?.toLowerCase().startsWith('text') && content) return content;
      }
      return null;
    })();
  const bodyHtml =
    pickField<string>(raw, 'body_html', 'bodyHtml') ??
    (() => {
      const b = pickField<unknown>(raw, 'body');
      if (b && typeof b === 'object') {
        const ct = pickField<string>(b, 'contentType', 'content_type');
        const content = pickField<string>(b, 'content');
        if (ct?.toLowerCase().includes('html') && content) return content;
      }
      return null;
    })();

  return {
    id,
    graphMessageId: graphId,
    subject,
    bodyText,
    bodyHtml,
    fromAddress,
    receivedAt,
  };
}

export interface DefaultEmailIngestAdapter {
  mailbox: EmailMailboxAdapter;
  shutdown: () => Promise<void>;
}

export function createDefaultEmailIngestAdapter(
  options: IngestOptions,
): DefaultEmailIngestAdapter {
  const log = options.logger ?? console;
  const cap = options.cacheSize ?? 1_000;
  const cache = new Map<number, CachedMessage>();
  const byGraphId = new Map<string, number>();
  let nextId = 1;
  /** mailboxId → detach function returned by registerHandler */
  const handlers = new Map<string, () => void>();
  /** detach functions for ownership/activity subscriptions */
  const eventDetachers: Array<() => void> = [];

  function evictIfFull() {
    while (cache.size > cap) {
      const oldest = cache.keys().next().value as number | undefined;
      if (oldest === undefined) break;
      const m = cache.get(oldest);
      cache.delete(oldest);
      if (m) byGraphId.delete(m.graphMessageId);
    }
  }

  function ingest(raw: unknown): CachedMessage {
    const graphId =
      pickField<string>(raw, 'id', 'message_id', 'messageId') ?? '';
    if (graphId && byGraphId.has(graphId)) {
      const id = byGraphId.get(graphId)!;
      return cache.get(id)!;
    }
    const id = nextId++;
    const msg = normaliseMessage(raw, id);
    cache.set(id, msg);
    if (msg.graphMessageId) byGraphId.set(msg.graphMessageId, id);
    evictIfFull();
    return msg;
  }

  function attachHandler(mailboxId: string): void {
    if (handlers.has(mailboxId)) return;
    const detach = options.emailIngest.registerHandler(
      mailboxId,
      (...args: unknown[]) => {
        ingest(args[0]);
        return undefined;
      },
    );
    handlers.set(mailboxId, detach);
  }

  function detachHandler(mailboxId: string): void {
    const d = handlers.get(mailboxId);
    if (d) {
      try {
        d();
      } catch {
        // ignore
      }
      handlers.delete(mailboxId);
    }
  }

  function applyMailboxList(
    rows: Array<{ id?: string; email_address?: string | null }>,
  ): void {
    for (const r of rows) {
      const id = typeof r.id === 'string' ? r.id : null;
      if (!id) continue;
      attachHandler(id);
    }
    log.info?.(
      `[gocardless email-ingest] attached to ${handlers.size} mailbox(es)`,
    );
  }

  if (options.initialMailboxes) {
    applyMailboxList(options.initialMailboxes);
  } else {
    Promise.resolve(options.emailIngest.listMyMailboxes())
      .then((rows) => {
        applyMailboxList(
          (rows as Array<Record<string, unknown>>).map((r) => ({
            id: typeof r.id === 'string' ? r.id : undefined,
            email_address:
              typeof r.email_address === 'string' ? r.email_address : null,
          })),
        );
      })
      .catch((err: unknown) => {
        log.warn?.(
          `[gocardless email-ingest] listMyMailboxes failed: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      });
  }

  try {
    const detachOwnership = options.emailIngest.onOwnershipChange(
      async (event: unknown) => {
        const e = event as {
          mailboxId?: string;
          previousOwnerAppId?: string | null;
          newOwnerAppId?: string | null;
        };
        if (!e?.mailboxId) return;
        if (
          e.newOwnerAppId === options.appId &&
          e.previousOwnerAppId !== options.appId
        ) {
          attachHandler(e.mailboxId);
        } else if (
          e.previousOwnerAppId === options.appId &&
          e.newOwnerAppId !== options.appId
        ) {
          detachHandler(e.mailboxId);
        }
      },
    );
    eventDetachers.push(detachOwnership);
  } catch {
    // optional in some SAM versions
  }

  const mailbox: EmailMailboxAdapter = {
    async sync() {
      // ctx.emailIngest syncs continuously in the background.
    },
    async list({ search, fromDate, toDate, pageSize }) {
      const needle = (search ?? '').toLowerCase().trim();
      const since = fromDate?.getTime() ?? null;
      const until = toDate?.getTime() ?? null;
      const items: ScannedEmail[] = [];
      for (const m of cache.values()) {
        if (m.receivedAt) {
          const t = Date.parse(m.receivedAt);
          if (Number.isFinite(t)) {
            if (since !== null && t < since) continue;
            if (until !== null && t > until) continue;
          }
        }
        if (needle) {
          const haystack = `${m.subject ?? ''} ${m.bodyText ?? ''}`.toLowerCase();
          if (!haystack.includes(needle)) continue;
        }
        items.push({
          id: m.id,
          subject: m.subject,
          body_text: m.bodyText,
          body_html: m.bodyHtml,
          received_at: m.receivedAt,
          from_address: m.fromAddress,
        });
      }
      // Newest first.
      items.sort((a, b) => {
        const ax = a.received_at ? Date.parse(String(a.received_at)) : 0;
        const bx = b.received_at ? Date.parse(String(b.received_at)) : 0;
        return bx - ax;
      });
      return { emails: items.slice(0, pageSize) };
    },
  };

  async function shutdown() {
    for (const d of eventDetachers.splice(0)) {
      try {
        d();
      } catch {
        // ignore
      }
    }
    for (const [, d] of handlers) {
      try {
        d();
      } catch {
        // ignore
      }
    }
    handlers.clear();
    cache.clear();
    byGraphId.clear();
  }

  return { mailbox, shutdown };
}
