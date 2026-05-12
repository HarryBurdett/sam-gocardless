import { describe, it, expect, vi } from 'vitest';
import { createDefaultEmailIngestAdapter } from '../src/services/default-email-ingest.js';
import type { SamEmailIngestService } from '../src/app-context.js';

interface FakeIngest extends SamEmailIngestService {
  push: (msg: unknown, mailboxId?: string) => void;
  fireOwnership: (event: {
    mailboxId: string;
    previousOwnerAppId?: string | null;
    newOwnerAppId?: string | null;
  }) => Promise<void>;
}

function makeIngest(opts: {
  myMailboxes?: Array<{ id: string; email_address: string }>;
} = {}): FakeIngest {
  const handlersByMailbox = new Map<string, (msg: unknown) => unknown>();
  const ownershipListeners: Array<(event: unknown) => Promise<void>> = [];
  return {
    async claimMailbox() {
      return { mailboxId: 'mb-claim' };
    },
    async releaseMailbox() {},
    async listMyMailboxes() {
      return opts.myMailboxes ?? [];
    },
    registerHandler(id: string, fn) {
      handlersByMailbox.set(id, fn as (msg: unknown) => unknown);
      return () => handlersByMailbox.delete(id);
    },
    fetchAttachment: vi.fn(async () => ({
      bytes: Buffer.from(''),
      name: 'x',
      contentType: 'application/pdf',
    })),
    async getAttachmentText() {
      return { name: 'x', contentType: 'text/plain', text: '', truncated: false };
    },
    onOwnershipChange(fn) {
      ownershipListeners.push(fn as (event: unknown) => Promise<void>);
      return () => undefined;
    },
    onActivityChange() {
      return () => undefined;
    },
    push(msg, mailboxId = 'mb1') {
      const h = handlersByMailbox.get(mailboxId);
      if (h) h(msg);
    },
    async fireOwnership(event) {
      for (const l of ownershipListeners) await l(event);
    },
  } as FakeIngest;
}

describe('createDefaultEmailIngestAdapter (gocardless)', () => {
  it('bootstraps from listMyMailboxes — production path', async () => {
    const ingest = makeIngest({
      myMailboxes: [{ id: 'mb1', email_address: 'ops@example.com' }],
    });
    const a = createDefaultEmailIngestAdapter({
      emailIngest: ingest,
      appId: 'gocardless',
    });
    await new Promise((r) => setTimeout(r, 5));
    ingest.push(
      {
        id: 'g1',
        subject: 'GoCardless payout £1,234.56',
        receivedDateTime: '2026-04-15T09:00:00Z',
        body: { contentType: 'Text', content: 'Net amount: £1,234.56' },
        from: { emailAddress: { address: 'noreply@gocardless.com' } },
      },
      'mb1',
    );
    const r = await a.mailbox.list({
      search: '',
      fromDate: new Date('2026-01-01'),
      pageSize: 10,
    });
    expect(r.emails.length).toBe(1);
    expect(r.emails[0]?.body_text).toContain('Net amount');
    expect(r.emails[0]?.from_address).toBe('noreply@gocardless.com');
    await a.shutdown();
  });

  it('attaches when SAM Admin assigns a mailbox', async () => {
    const ingest = makeIngest();
    const a = createDefaultEmailIngestAdapter({
      emailIngest: ingest,
      appId: 'gocardless',
    });
    await new Promise((r) => setTimeout(r, 5));
    await ingest.fireOwnership({
      mailboxId: 'mb-new',
      previousOwnerAppId: null,
      newOwnerAppId: 'gocardless',
    });
    ingest.push(
      { id: 'g1', subject: 'After', receivedDateTime: '2026-04-15' },
      'mb-new',
    );
    const r = await a.mailbox.list({
      search: '',
      fromDate: new Date('2026-01-01'),
      pageSize: 10,
    });
    expect(r.emails.length).toBe(1);
  });

  it('test-path initialMailboxes bypasses listMyMailboxes', async () => {
    const ingest = makeIngest();
    const listSpy = vi.spyOn(ingest, 'listMyMailboxes');
    const a = createDefaultEmailIngestAdapter({
      emailIngest: ingest,
      appId: 'gocardless',
      initialMailboxes: [{ id: 'mb-test', email_address: 'test@x' }],
    });
    expect(listSpy).not.toHaveBeenCalled();
    ingest.push(
      { id: 'g1', subject: 'X', receivedDateTime: '2026-04-15' },
      'mb-test',
    );
    const r = await a.mailbox.list({
      search: '',
      fromDate: new Date('2026-01-01'),
      pageSize: 5,
    });
    expect(r.emails.length).toBe(1);
  });

  it('filters by search keyword in subject + body', async () => {
    const ingest = makeIngest({
      myMailboxes: [{ id: 'mb1', email_address: 'ops@example.com' }],
    });
    const a = createDefaultEmailIngestAdapter({
      emailIngest: ingest,
      appId: 'gocardless',
    });
    await new Promise((r) => setTimeout(r, 5));
    ingest.push(
      {
        id: 'g1',
        subject: 'GoCardless payout',
        receivedDateTime: '2026-04-15T09:00:00Z',
        body_text: 'gross amount 100',
      },
      'mb1',
    );
    ingest.push(
      {
        id: 'g2',
        subject: 'Random newsletter',
        receivedDateTime: '2026-04-15T09:00:00Z',
        body_text: 'unrelated',
      },
      'mb1',
    );
    const r = await a.mailbox.list({
      search: 'payout',
      fromDate: new Date('2026-01-01'),
      pageSize: 10,
    });
    expect(r.emails.length).toBe(1);
    expect(r.emails[0]?.subject).toBe('GoCardless payout');
  });

  it('filters by toDate', async () => {
    const ingest = makeIngest({
      myMailboxes: [{ id: 'mb1', email_address: 'ops@example.com' }],
    });
    const a = createDefaultEmailIngestAdapter({
      emailIngest: ingest,
      appId: 'gocardless',
    });
    await new Promise((r) => setTimeout(r, 5));
    ingest.push({ id: 'g1', subject: 'A', receivedDateTime: '2026-04-15' }, 'mb1');
    ingest.push({ id: 'g2', subject: 'B', receivedDateTime: '2026-06-15' }, 'mb1');
    const r = await a.mailbox.list({
      search: '',
      fromDate: new Date('2026-01-01'),
      toDate: new Date('2026-05-01'),
      pageSize: 10,
    });
    expect(r.emails.map((e) => e.subject).sort()).toEqual(['A']);
  });

  it('dedupes by graph message id', async () => {
    const ingest = makeIngest({
      myMailboxes: [{ id: 'mb1', email_address: 'ops@example.com' }],
    });
    const a = createDefaultEmailIngestAdapter({
      emailIngest: ingest,
      appId: 'gocardless',
    });
    await new Promise((r) => setTimeout(r, 5));
    ingest.push({ id: 'g1', subject: 'A', receivedDateTime: '2026-04-15' }, 'mb1');
    ingest.push({ id: 'g1', subject: 'A', receivedDateTime: '2026-04-15' }, 'mb1');
    const r = await a.mailbox.list({
      search: '',
      fromDate: new Date('2026-01-01'),
      pageSize: 10,
    });
    expect(r.emails.length).toBe(1);
  });

  it('honours pageSize', async () => {
    const ingest = makeIngest({
      myMailboxes: [{ id: 'mb1', email_address: 'ops@example.com' }],
    });
    const a = createDefaultEmailIngestAdapter({
      emailIngest: ingest,
      appId: 'gocardless',
    });
    await new Promise((r) => setTimeout(r, 5));
    for (let i = 0; i < 5; i++) {
      ingest.push(
        { id: `g${i}`, subject: `S${i}`, receivedDateTime: `2026-04-1${i}` },
        'mb1',
      );
    }
    const r = await a.mailbox.list({
      search: '',
      fromDate: new Date('2026-01-01'),
      pageSize: 2,
    });
    expect(r.emails.length).toBe(2);
  });
});
