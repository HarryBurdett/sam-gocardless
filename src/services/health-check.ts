/**
 * GoCardless data-integrity health check.
 *
 * Faithful port of `apps/gocardless/logic/health_check.py`.
 *
 * Verifies the GoCardless app's data still references valid Opera
 * codes:
 *   - Customer codes in mandates / payment requests → exist in Opera sname
 *   - Bank code in saved settings → exists in Opera nbank
 *   - Fees nominal account → exists in Opera nacnt
 *
 * Storage difference (not a behavioural amendment): the Python
 * version reads gocardless_payments.db SQLite; we read the per-app
 * MSSQL tables provisioned by the migration.
 */
import type { Knex } from 'knex';
import type { GoCardlessSettings } from './settings.js';

const APP_NAME = 'gocardless';
const MAX_ORPHANS_RETURNED = 50;

export interface HealthCheckItem {
  name: string;
  description: string;
  passed: boolean;
  total_checked?: number;
  orphan_count?: number;
  orphans?: Array<Record<string, unknown>>;
  severity: 'info' | 'warning' | 'error';
}

export interface HealthCheckResult {
  app: string;
  healthy: boolean;
  summary: string;
  checks: HealthCheckItem[];
  metadata: Record<string, unknown>;
}

function deriveOverallHealthy(checks: HealthCheckItem[]): boolean {
  return checks.every((c) => c.passed || c.severity !== 'error');
}

function summarise(app: string, checks: HealthCheckItem[]): string {
  const errors = checks.filter((c) => !c.passed && c.severity === 'error').length;
  const warnings = checks.filter((c) => !c.passed && c.severity === 'warning').length;
  if (errors === 0 && warnings === 0) {
    return `${app}: all checks passed`;
  }
  return `${app}: ${errors} error(s), ${warnings} warning(s)`;
}

async function fetchValidCodes(
  operaDb: Knex,
  table: string,
  col: string,
): Promise<Set<string>> {
  try {
    const rows = (await operaDb.raw(
      `SELECT RTRIM(${col}) AS code FROM ${table} WITH (NOLOCK)`,
    )) as unknown as Array<{ code: string | null }>;
    const set = new Set<string>();
    for (const row of Array.isArray(rows) ? rows : []) {
      const code = (row.code ?? '').trim();
      if (code) set.add(code);
    }
    return set;
  } catch {
    return new Set();
  }
}

function checkSettingsBankCode(
  settings: GoCardlessSettings,
  validBankCodes: Set<string>,
): HealthCheckItem {
  // Note: Python reads `bank_code` (legacy field name); newer code uses
  // `default_bank_code`. Check both for compatibility.
  const bc = (
    (settings as any).bank_code ?? settings.default_bank_code ?? ''
  ).trim();
  if (!bc) {
    return {
      name: 'Settings bank code',
      description: 'No bank account configured in GoCardless settings',
      passed: true,
      severity: 'info',
    };
  }
  if (validBankCodes.has(bc)) {
    return {
      name: 'Settings bank code',
      description: `Bank code '${bc}' exists in Opera nbank`,
      passed: true,
      total_checked: 1,
      severity: 'warning',
    };
  }
  return {
    name: 'Settings bank code',
    description: `Bank code '${bc}' from GoCardless settings does NOT exist in Opera nbank`,
    passed: false,
    total_checked: 1,
    orphan_count: 1,
    orphans: [{ bank_code: bc, reason: 'not in Opera nbank' }],
    severity: 'error',
  };
}

function checkSettingsFeesAccount(
  settings: GoCardlessSettings,
  validNominalCodes: Set<string>,
): HealthCheckItem {
  const acct = (settings.fees_nominal_account ?? '').trim();
  if (!acct) {
    return {
      name: 'Settings fees account',
      description: "No fees nominal account configured (fees won't auto-post)",
      passed: true,
      severity: 'info',
    };
  }
  if (validNominalCodes.has(acct)) {
    return {
      name: 'Settings fees account',
      description: `Fees account '${acct}' exists in Opera nacnt`,
      passed: true,
      total_checked: 1,
      severity: 'warning',
    };
  }
  return {
    name: 'Settings fees account',
    description: `Fees account '${acct}' does NOT exist in Opera nacnt`,
    passed: false,
    total_checked: 1,
    orphan_count: 1,
    orphans: [{ account_code: acct, reason: 'not in Opera nacnt' }],
    severity: 'error',
  };
}

async function checkPaymentCustomerCodes(
  appDb: Knex,
  validCustomerCodes: Set<string>,
): Promise<HealthCheckItem> {
  const referenced = new Set<string>();
  let sourcesInspected = 0;

  for (const table of ['gocardless_mandates', 'gocardless_payment_requests']) {
    try {
      const rows = (await appDb.raw(
        `SELECT DISTINCT opera_account FROM ${table} WHERE opera_account IS NOT NULL AND opera_account != ''`,
      )) as unknown as Array<{ opera_account: string | null }>;
      sourcesInspected += 1;
      for (const row of Array.isArray(rows) ? rows : []) {
        const code = (row.opera_account ?? '').trim();
        if (code) referenced.add(code);
      }
    } catch {
      // Table doesn't exist yet — skip silently
    }
  }

  if (sourcesInspected === 0) {
    return {
      name: 'Payment history customers',
      description:
        'Skipped — no GoCardless tables present yet (no mandates or payment requests recorded)',
      passed: true,
      severity: 'info',
    };
  }

  if (referenced.size === 0) {
    return {
      name: 'Payment history customers',
      description: 'No customer references in GoCardless data — nothing to check',
      passed: true,
      severity: 'info',
    };
  }

  const orphans: Array<Record<string, unknown>> = [];
  let orphanTotal = 0;
  for (const code of [...referenced].sort()) {
    if (!validCustomerCodes.has(code)) {
      orphanTotal += 1;
      if (orphans.length < MAX_ORPHANS_RETURNED) {
        orphans.push({
          opera_account: code,
          reason: `customer '${code}' from GoCardless data not in Opera sname`,
        });
      }
    }
  }

  return {
    name: 'Payment history customers',
    description:
      'Opera customer codes referenced in GoCardless mandates / payment requests must exist in Opera sname',
    passed: orphanTotal === 0,
    total_checked: referenced.size,
    orphan_count: orphanTotal,
    orphans,
    severity: 'warning',
  };
}

/**
 * Run the GoCardless health check end to end.
 */
export async function runHealthCheck(opts: {
  operaDb: Knex;
  appDb: Knex | null;
  settings: GoCardlessSettings | null;
}): Promise<HealthCheckResult> {
  const checks: HealthCheckItem[] = [];

  const validBankCodes = await fetchValidCodes(opts.operaDb, 'nbank', 'nk_acnt');
  const validCustomerCodes = await fetchValidCodes(opts.operaDb, 'sname', 'sn_account');
  const validNominalCodes = await fetchValidCodes(opts.operaDb, 'nacnt', 'na_acnt');

  // Settings checks
  if (opts.settings) {
    checks.push(checkSettingsBankCode(opts.settings, validBankCodes));
    checks.push(checkSettingsFeesAccount(opts.settings, validNominalCodes));
  } else {
    checks.push({
      name: 'GoCardless settings',
      description: 'Skipped — no GoCardless settings configured for this company',
      passed: true,
      severity: 'info',
    });
  }

  // Payment history check
  if (opts.appDb) {
    checks.push(await checkPaymentCustomerCodes(opts.appDb, validCustomerCodes));
  } else {
    checks.push({
      name: 'Payment history',
      description: 'Skipped — gocardless app database not yet provisioned',
      passed: true,
      severity: 'info',
    });
  }

  // Sanity check on Opera connection
  if (validBankCodes.size === 0) {
    checks.push({
      name: 'Opera connection',
      description: 'Opera returned no bank codes — connection or schema broken',
      passed: false,
      severity: 'error',
    });
  }

  return {
    app: APP_NAME,
    healthy: deriveOverallHealthy(checks),
    summary: summarise(APP_NAME, checks),
    checks,
    metadata: {
      checked_at: new Date().toISOString(),
      opera_bank_count: validBankCodes.size,
      opera_customer_count: validCustomerCodes.size,
    },
  };
}
