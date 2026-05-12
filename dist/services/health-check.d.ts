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
/**
 * Run the GoCardless health check end to end.
 */
export declare function runHealthCheck(opts: {
    operaDb: Knex;
    appDb: Knex | null;
    settings: GoCardlessSettings | null;
}): Promise<HealthCheckResult>;
//# sourceMappingURL=health-check.d.ts.map