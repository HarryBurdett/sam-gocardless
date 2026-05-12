import { describe, it, expect } from 'vitest';
import {
  parseAmount,
  detectCurrency,
  detectTransactionCurrency,
  detectPayoutCurrency,
  extractInvoiceRefs,
  parseGocardlessEmail,
  batchTotalFees,
  batchCalculatedGross,
} from '../src/services/parser.js';

// ---------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------

describe('parseAmount', () => {
  it('parses bare numbers', () => {
    expect(parseAmount('123.45')).toBe(123.45);
  });
  it('strips currency codes and whitespace', () => {
    expect(parseAmount('7,380.00 GBP')).toBe(7380);
  });
  it('treats unicode minus signs as negatives', () => {
    expect(parseAmount('−42.10')).toBe(-42.1);
    expect(parseAmount('–42.10')).toBe(-42.1);
  });
  it('returns 0 for unparseable input', () => {
    expect(parseAmount('abc')).toBe(0);
  });
});

describe('extractInvoiceRefs', () => {
  it('returns empty array when no INV reference', () => {
    expect(extractInvoiceRefs('Intsys Opera 3 Support')).toEqual([]);
  });
  it('captures a single INV reference', () => {
    expect(extractInvoiceRefs('Intsys INV26365')).toEqual(['INV26365']);
  });
  it('captures comma-separated INV references', () => {
    expect(extractInvoiceRefs('Intsys INV26362,26363')).toEqual([
      'INV26362',
      'INV26363',
    ]);
  });
});

describe('detectTransactionCurrency', () => {
  it('returns GBP when no payment lines', () => {
    expect(detectTransactionCurrency('Net amount 100.00 GBP')).toBe('GBP');
  });
  it('detects EUR from payment lines', () => {
    const c = [
      'Customer    Description    Amount',
      'Acme Ltd    INV1   615.00 EUR',
      'Net amount 530.00 GBP',
    ].join('\n');
    expect(detectTransactionCurrency(c)).toBe('EUR');
  });
});

describe('detectPayoutCurrency', () => {
  it('detects GBP from subject', () => {
    expect(detectPayoutCurrency('Subject: You were paid 100 GBP today')).toBe('GBP');
  });
  it('falls back to GBP when nothing matches', () => {
    expect(detectPayoutCurrency('hello')).toBe('GBP');
  });
});

describe('detectCurrency', () => {
  it('prefers transaction currency over payout currency', () => {
    const c = [
      'Customer    Description    Amount',
      'Acme   INV1   615.00 EUR',
      'Beta   INV2   100.00 EUR',
      'Net amount 530.00 GBP',
    ].join('\n');
    expect(detectCurrency(c)).toBe('EUR');
  });
});

// ---------------------------------------------------------------------
// Full email parser
// ---------------------------------------------------------------------

const SAMPLE_HORIZONTAL = `Subject: GoCardless: 7,380.00 GBP paid out
Hi there

Your payout of 7,380.00 GBP is on its way and the money should arrive by January 7th.
Reference: INTSYSUKLTD-PAY-ABC123

Customer    Description    Amount
Acme Ltd    Intsys INV26362,26363    2,500.00 GBP
Beta plc    Intsys INV26365    1,500.00 GBP
Gamma Co    Intsys Opera 3 Support    3,500.00 GBP

Gross amount    7,500.00 GBP
GoCardless fees    -100.00 GBP
VAT on fees    -20.00 GBP
Net amount    7,380.00 GBP
`;

describe('parseGocardlessEmail (horizontal layout)', () => {
  const batch = parseGocardlessEmail(SAMPLE_HORIZONTAL);

  it('extracts subject and net amount from subject', () => {
    expect(batch.email_subject).toContain('paid out');
    expect(batch.net_amount).toBe(7380);
  });

  it('extracts the bank reference', () => {
    expect(batch.bank_reference).toBe('INTSYSUKLTD-PAY-ABC123');
  });

  it('parses three payments', () => {
    expect(batch.payments.length).toBe(3);
    const acme = batch.payments[0];
    expect(acme.customer_name).toBe('Acme Ltd');
    expect(acme.amount).toBe(2500);
    expect(acme.invoice_refs).toEqual(['INV26362', 'INV26363']);
  });

  it('captures gross/fees/vat correctly (fees stored absolute)', () => {
    expect(batch.gross_amount).toBe(7500);
    expect(batch.gocardless_fees).toBe(100);
    expect(batch.vat_on_fees).toBe(20);
  });

  it('infers currency as GBP', () => {
    expect(batch.currency).toBe('GBP');
  });

  it('payment_date resolves to a Date in January', () => {
    expect(batch.payment_date).toBeInstanceOf(Date);
    if (batch.payment_date) {
      expect(batch.payment_date.getUTCMonth()).toBe(0);
      expect(batch.payment_date.getUTCDate()).toBe(7);
    }
  });

  it('helper totals match', () => {
    expect(batchTotalFees(batch)).toBe(120);
    expect(batchCalculatedGross(batch)).toBe(7500);
  });
});

const SAMPLE_VERTICAL = `Subject: GoCardless: 9.50 GBP paid out
Reference: INTSYSUKLTD-PAY-XYZ
Should arrive by 7 February

Customer
Description
Amount

Acme Ltd
Intsys INV12345
10.00 GBP

Gross amount
10.00 GBP
GoCardless fees
-0.50 GBP
Net amount
9.50 GBP
`;

describe('parseGocardlessEmail (vertical layout)', () => {
  const batch = parseGocardlessEmail(SAMPLE_VERTICAL);

  it('detects the vertical header sequence', () => {
    expect(batch.payments.length).toBe(1);
    expect(batch.payments[0].customer_name).toBe('Acme Ltd');
    expect(batch.payments[0].description).toBe('Intsys INV12345');
    expect(batch.payments[0].amount).toBe(10);
  });

  it('captures vertical-format gross/fees/net (amount on next line)', () => {
    expect(batch.gross_amount).toBe(10);
    expect(batch.gocardless_fees).toBe(0.5);
    expect(batch.net_amount).toBe(9.5);
  });
});

describe('parseGocardlessEmail (no payments)', () => {
  it('returns empty batch with calculated gross 0', () => {
    const b = parseGocardlessEmail('hello world');
    expect(b.payments).toEqual([]);
    expect(b.gross_amount).toBe(0);
    expect(b.net_amount).toBe(0);
    expect(b.bank_reference).toBeNull();
  });
});

describe('parseGocardlessEmail (foreign currency)', () => {
  it('flags EUR transactions even when payout is in GBP', () => {
    const c = `Subject: GoCardless: 530 GBP paid out
Reference: INTSYSEU-EUR-1
Customer    Description    Amount
Acme    INV1    615.00 EUR

Gross amount    615.00 EUR
GoCardless fees    -10.00 EUR
Net amount    530.00 GBP
`;
    const b = parseGocardlessEmail(c);
    expect(b.currency).toBe('EUR');
    expect(b.payments[0].amount).toBe(615);
  });
});
