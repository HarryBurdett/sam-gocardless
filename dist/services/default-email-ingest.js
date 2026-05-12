function pickField(obj, ...keys) {
    if (!obj || typeof obj !== 'object')
        return undefined;
    for (const k of keys) {
        const v = obj[k];
        if (v !== undefined && v !== null)
            return v;
    }
    return undefined;
}
function normaliseMessage(raw, id) {
    const graphId = pickField(raw, 'id', 'message_id', 'messageId') ?? '';
    const subject = pickField(raw, 'subject') ?? null;
    const fromObj = pickField(raw, 'from', 'sender') ?? null;
    let fromAddress = null;
    if (typeof fromObj === 'string')
        fromAddress = fromObj;
    else if (fromObj && typeof fromObj === 'object') {
        const ea = pickField(fromObj, 'emailAddress', 'email_address');
        fromAddress =
            ea?.address ??
                pickField(fromObj, 'address', 'email') ??
                null;
    }
    const receivedRaw = pickField(raw, 'received_at', 'receivedDateTime', 'received');
    const receivedAt = receivedRaw instanceof Date
        ? receivedRaw.toISOString()
        : typeof receivedRaw === 'string'
            ? receivedRaw
            : null;
    // Microsoft Graph delivers body as { content, contentType } where
    // contentType is 'text' or 'html'. Plugins may also pass plain
    // strings in `body_text` / `body_html`.
    const bodyText = pickField(raw, 'body_text', 'bodyText') ??
        (() => {
            const b = pickField(raw, 'body');
            if (b && typeof b === 'object') {
                const ct = pickField(b, 'contentType', 'content_type');
                const content = pickField(b, 'content');
                if (ct?.toLowerCase().startsWith('text') && content)
                    return content;
            }
            return null;
        })();
    const bodyHtml = pickField(raw, 'body_html', 'bodyHtml') ??
        (() => {
            const b = pickField(raw, 'body');
            if (b && typeof b === 'object') {
                const ct = pickField(b, 'contentType', 'content_type');
                const content = pickField(b, 'content');
                if (ct?.toLowerCase().includes('html') && content)
                    return content;
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
export function createDefaultEmailIngestAdapter(options) {
    const log = options.logger ?? console;
    const cap = options.cacheSize ?? 1_000;
    const cache = new Map();
    const byGraphId = new Map();
    let nextId = 1;
    /** mailboxId → detach function returned by registerHandler */
    const handlers = new Map();
    /** detach functions for ownership/activity subscriptions */
    const eventDetachers = [];
    function evictIfFull() {
        while (cache.size > cap) {
            const oldest = cache.keys().next().value;
            if (oldest === undefined)
                break;
            const m = cache.get(oldest);
            cache.delete(oldest);
            if (m)
                byGraphId.delete(m.graphMessageId);
        }
    }
    function ingest(raw) {
        const graphId = pickField(raw, 'id', 'message_id', 'messageId') ?? '';
        if (graphId && byGraphId.has(graphId)) {
            const id = byGraphId.get(graphId);
            return cache.get(id);
        }
        const id = nextId++;
        const msg = normaliseMessage(raw, id);
        cache.set(id, msg);
        if (msg.graphMessageId)
            byGraphId.set(msg.graphMessageId, id);
        evictIfFull();
        return msg;
    }
    function attachHandler(mailboxId) {
        if (handlers.has(mailboxId))
            return;
        const detach = options.emailIngest.registerHandler(mailboxId, (...args) => {
            ingest(args[0]);
            return undefined;
        });
        handlers.set(mailboxId, detach);
    }
    function detachHandler(mailboxId) {
        const d = handlers.get(mailboxId);
        if (d) {
            try {
                d();
            }
            catch {
                // ignore
            }
            handlers.delete(mailboxId);
        }
    }
    function applyMailboxList(rows) {
        for (const r of rows) {
            const id = typeof r.id === 'string' ? r.id : null;
            if (!id)
                continue;
            attachHandler(id);
        }
        log.info?.(`[gocardless email-ingest] attached to ${handlers.size} mailbox(es)`);
    }
    if (options.initialMailboxes) {
        applyMailboxList(options.initialMailboxes);
    }
    else {
        Promise.resolve(options.emailIngest.listMyMailboxes())
            .then((rows) => {
            applyMailboxList(rows.map((r) => ({
                id: typeof r.id === 'string' ? r.id : undefined,
                email_address: typeof r.email_address === 'string' ? r.email_address : null,
            })));
        })
            .catch((err) => {
            log.warn?.(`[gocardless email-ingest] listMyMailboxes failed: ${err instanceof Error ? err.message : String(err)}`);
        });
    }
    try {
        const detachOwnership = options.emailIngest.onOwnershipChange(async (event) => {
            const e = event;
            if (!e?.mailboxId)
                return;
            if (e.newOwnerAppId === options.appId &&
                e.previousOwnerAppId !== options.appId) {
                attachHandler(e.mailboxId);
            }
            else if (e.previousOwnerAppId === options.appId &&
                e.newOwnerAppId !== options.appId) {
                detachHandler(e.mailboxId);
            }
        });
        eventDetachers.push(detachOwnership);
    }
    catch {
        // optional in some SAM versions
    }
    const mailbox = {
        async sync() {
            // ctx.emailIngest syncs continuously in the background.
        },
        async list({ search, fromDate, toDate, pageSize }) {
            const needle = (search ?? '').toLowerCase().trim();
            const since = fromDate?.getTime() ?? null;
            const until = toDate?.getTime() ?? null;
            const items = [];
            for (const m of cache.values()) {
                if (m.receivedAt) {
                    const t = Date.parse(m.receivedAt);
                    if (Number.isFinite(t)) {
                        if (since !== null && t < since)
                            continue;
                        if (until !== null && t > until)
                            continue;
                    }
                }
                if (needle) {
                    const haystack = `${m.subject ?? ''} ${m.bodyText ?? ''}`.toLowerCase();
                    if (!haystack.includes(needle))
                        continue;
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
            }
            catch {
                // ignore
            }
        }
        for (const [, d] of handlers) {
            try {
                d();
            }
            catch {
                // ignore
            }
        }
        handlers.clear();
        cache.clear();
        byGraphId.clear();
    }
    return { mailbox, shutdown };
}
//# sourceMappingURL=default-email-ingest.js.map