/**
 * GoCardless email parser — TS port of `sql_rag/gocardless_parser.py`.
 *
 * Faithful regex-based parser for GoCardless payout notification
 * emails. Extracts the per-customer payment table, summary totals,
 * bank reference, payment date and currency. Used by `scan-emails`,
 * `parse-content`, and `import-from-email`.
 *
 * No LLM involved — the format is stable enough that regex is
 * reliable, and the determinism matters for duplicate detection.
 */

const MONTH_NAMES: readonly string[] = [
  'january', 'february', 'march', 'april', 'may', 'june',
  'july', 'august', 'september', 'october', 'november', 'december',
];

export interface GoCardlessPayment {
  customer_name: string;
  description: string;
  amount: number;
  invoice_refs: string[];
  matched_account?: string | null;
  matched_name?: string | null;
  match_score?: number;
  match_status?: 'matched' | 'unmatched' | 'multiple';
}

export interface GoCardlessBatch {
  payments: GoCardlessPayment[];
  gross_amount: number;
  gocardless_fees: number;
  app_fees: number;
  vat_on_fees: number;
  net_amount: number;
  bank_reference: string | null;
  payment_date: Date | null;
  email_subject: string | null;
  currency: string;
}

export function parseAmount(amountStr: string): number {
  let cleaned = amountStr.replace(/[A-Z]{3}|\s/g, '');
  cleaned = cleaned.replace(/,/g, '');
  cleaned = cleaned.replace(/[−–]/g, '-');
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : 0;
}

export function detectTransactionCurrency(content: string): string {
  const summaryKeywords = [
    'gross', 'fees', 'vat', 'net', 'total', 'amount', 'exchange',
  ];
  const paymentCurrencies: string[] = [];
  for (const rawLine of content.split('\n')) {
    const line: string = rawLine ?? '';
    const lower = line.toLowerCase();
    if (summaryKeywords.some((kw) => lower.includes(kw))) continue;
    if (lower.includes('customer') && lower.includes('description')) continue;
    const m = /[\d,]+\.?\d+\s*(GBP|EUR|USD|CAD|AUD)\s*$/i.exec(line);
    const code = m?.[1];
    if (code) paymentCurrencies.push(code.toUpperCase());
  }
  if (paymentCurrencies.length === 0) return 'GBP';
  const counts = new Map<string, number>();
  for (const c of paymentCurrencies) {
    counts.set(c, (counts.get(c) ?? 0) + 1);
  }
  let best = 'GBP';
  let bestCount = 0;
  for (const [c, n] of counts) {
    if (n > bestCount) {
      best = c;
      bestCount = n;
    }
  }
  return best;
}

export function detectPayoutCurrency(content: string): string {
  const subjectMatch = /(?:paid|payout|payment)[^\n]*?(GBP|EUR|USD|CAD|AUD)/i.exec(content);
  if (subjectMatch?.[1]) return subjectMatch[1].toUpperCase();
  const netMatch = /Net amount[^\n]*?(GBP|EUR|USD|CAD|AUD)/i.exec(content);
  if (netMatch?.[1]) return netMatch[1].toUpperCase();
  return 'GBP';
}

export function detectCurrency(content: string): string {
  const tx = detectTransactionCurrency(content);
  if (tx !== 'GBP') return tx;
  return detectPayoutCurrency(content);
}

export function extractInvoiceRefs(description: string): string[] {
  const m = /INV(\d+(?:,\d+)*)/i.exec(description);
  const numbers = m?.[1];
  if (!numbers) return [];
  return numbers.split(',').map((n) => `INV${n.trim()}`);
}

function monthIndex(name: string): number | null {
  const idx = MONTH_NAMES.indexOf(name.toLowerCase());
  return idx === -1 ? null : idx;
}

function inferYearForMonth(monthIdx: number): number {
  const now = new Date();
  const currentYear = now.getFullYear();
  const currentMonth = now.getMonth();
  return monthIdx <= currentMonth + 1 ? currentYear : currentYear - 1;
}

export function parseGocardlessEmail(content: string): GoCardlessBatch {
  const payments: GoCardlessPayment[] = [];
  let gross_amount = 0;
  let gocardless_fees = 0;
  let app_fees = 0;
  let vat_on_fees = 0;
  let net_amount = 0;
  let bank_reference: string | null = null;
  let payment_date: Date | null = null;
  let email_subject: string | null = null;

  const cleanedLines: string[] = content
    .trim()
    .split('\n')
    .map((l) => (l ?? '').trim())
    .filter((l) => l.length > 0);

  for (const line of cleanedLines) {
    if (line.toLowerCase().startsWith('subject:')) {
      email_subject = line.split(':').slice(1).join(':').trim();
      const am = /([\d,]+\.?\d*)\s*GBP/.exec(email_subject);
      if (am?.[1]) net_amount = parseAmount(am[1]);
      break;
    }
  }

  for (const line of cleanedLines) {
    if (line.toLowerCase().includes('reference:')) {
      const rm = /reference:\s*(\S+)/i.exec(line);
      if (rm?.[1]) {
        bank_reference = rm[1];
        break;
      }
    }
  }

  for (const line of cleanedLines) {
    const lower = line.toLowerCase();
    if (
      lower.includes('arrive by') ||
      lower.includes('should arrive') ||
      lower.includes('paid on')
    ) {
      const monthDay = /(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d+)(?:st|nd|rd|th)?/i.exec(line);
      const mdName = monthDay?.[1];
      const mdDayStr = monthDay?.[2];
      if (mdName && mdDayStr) {
        const mIdx = monthIndex(mdName);
        const day = Number(mdDayStr);
        if (mIdx !== null && Number.isFinite(day)) {
          const year = inferYearForMonth(mIdx);
          payment_date = new Date(Date.UTC(year, mIdx, day));
        }
        break;
      }
      const dayMonth = /(\d+)(?:st|nd|rd|th)?\s+(January|February|March|April|May|June|July|August|September|October|November|December)/i.exec(line);
      const dmDayStr = dayMonth?.[1];
      const dmName = dayMonth?.[2];
      if (dmDayStr && dmName) {
        const day = Number(dmDayStr);
        const mIdx = monthIndex(dmName);
        if (mIdx !== null && Number.isFinite(day)) {
          const year = inferYearForMonth(mIdx);
          payment_date = new Date(Date.UTC(year, mIdx, day));
        }
        break;
      }
    }
  }

  let inPaymentTable = false;
  let currentCustomer: string | null = null;
  let currentDescription: string | null = null;
  const headerPartsSeen = new Set<string>();

  const summaryKeywordsForFreeText = [
    'gross', 'fees', 'vat', 'net', 'exchange', 'arrive', 'reference',
  ];

  const getAmountFromLineOrNext = (
    currentLine: string,
    nextIdx: number,
  ): number | null => {
    const cur = /-?[\d,]+\.?\d*\s*(?:GBP|EUR|USD)/i.exec(currentLine);
    if (cur?.[0]) return parseAmount(cur[0]);
    if (nextIdx < cleanedLines.length) {
      const nl = (cleanedLines[nextIdx] ?? '').trim();
      const nm = /^-?[\d,]+\.?\d*\s*(?:GBP|EUR|USD)?$/i.exec(nl);
      if (nm?.[0]) return parseAmount(nm[0]);
    }
    return null;
  };

  for (let i = 0; i < cleanedLines.length; i++) {
    const line: string = cleanedLines[i] ?? '';
    const trimmedLower = line.toLowerCase().trim();

    if (
      trimmedLower.includes('customer') &&
      trimmedLower.includes('description') &&
      trimmedLower.includes('amount')
    ) {
      inPaymentTable = true;
      headerPartsSeen.clear();
      continue;
    }

    if (trimmedLower === 'customer') {
      headerPartsSeen.add('customer');
      continue;
    }
    if (trimmedLower === 'description') {
      headerPartsSeen.add('description');
      continue;
    }
    if (trimmedLower === 'amount') {
      headerPartsSeen.add('amount');
      if (
        headerPartsSeen.has('customer') &&
        headerPartsSeen.has('description') &&
        headerPartsSeen.has('amount')
      ) {
        inPaymentTable = true;
        headerPartsSeen.clear();
      }
      continue;
    }

    const lower = line.toLowerCase();

    if (lower.includes('gross amount')) {
      const a = getAmountFromLineOrNext(line, i + 1);
      if (a !== null) gross_amount = a;
      inPaymentTable = false;
      continue;
    }
    if (lower.includes('gocardless fees')) {
      const a = getAmountFromLineOrNext(line, i + 1);
      if (a !== null) gocardless_fees = Math.abs(a);
      continue;
    }
    if (lower.includes('app fees')) {
      const a = getAmountFromLineOrNext(line, i + 1);
      if (a !== null) app_fees = Math.abs(a);
      continue;
    }
    if (lower.includes('vat total fees') || lower.includes('vat on fees')) {
      const a = getAmountFromLineOrNext(line, i + 1);
      if (a !== null) vat_on_fees = Math.abs(a);
      continue;
    }
    if (lower.includes('net amount')) {
      const a = getAmountFromLineOrNext(line, i + 1);
      if (a !== null) net_amount = a;
      continue;
    }

    if (!inPaymentTable) continue;

    const amountMatch = /([\d,]+\.?\d+)\s*(?:GBP|EUR|USD|CAD|AUD)\s*$/i.exec(line);
    if (amountMatch?.[1]) {
      const amount = parseAmount(amountMatch[1]);
      const prefix = line.slice(0, amountMatch.index).trim();
      let customer_name: string;
      let description: string;

      if (prefix.length > 0) {
        const parts = prefix
          .split(/\t+|\s{2,}/)
          .map((p) => p.trim())
          .filter((p) => p.length > 0);
        if (parts.length >= 2) {
          customer_name = parts[0] ?? '';
          description = parts.slice(1).join(' ');
        } else if (parts.length === 1) {
          customer_name = parts[0] ?? '';
          description = '';
        } else {
          continue;
        }
      } else if (currentCustomer) {
        customer_name = currentCustomer;
        description = currentDescription ?? '';
        currentCustomer = null;
        currentDescription = null;
      } else {
        continue;
      }

      payments.push({
        customer_name,
        description,
        amount,
        invoice_refs: extractInvoiceRefs(description),
      });
      continue;
    }

    if (
      line.trim().length > 0 &&
      !summaryKeywordsForFreeText.some((kw) => lower.includes(kw))
    ) {
      if (!currentCustomer) {
        currentCustomer = line.trim();
      } else if (!currentDescription) {
        currentDescription = line.trim();
      }
    }
  }

  if (gross_amount === 0 && payments.length > 0) {
    gross_amount = payments.reduce((acc, p) => acc + p.amount, 0);
  }

  const currency = detectCurrency(content);

  return {
    payments,
    gross_amount,
    gocardless_fees,
    app_fees,
    vat_on_fees,
    net_amount,
    bank_reference,
    payment_date,
    email_subject,
    currency,
  };
}

export function batchTotalFees(b: GoCardlessBatch): number {
  return Math.abs(b.gocardless_fees) + Math.abs(b.app_fees) + Math.abs(b.vat_on_fees);
}

export function batchCalculatedGross(b: GoCardlessBatch): number {
  return b.payments.reduce((acc, p) => acc + p.amount, 0);
}
