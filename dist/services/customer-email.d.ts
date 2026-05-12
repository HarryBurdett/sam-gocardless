/**
 * GoCardless customer-email lookup.
 *
 * Faithful port of get_customer_email_for_mandate
 * (apps/gocardless/api/routes.py:7189-7217). Reads sname for the
 * given account and returns the email + name + contact, used by
 * the mandate setup form to pre-fill customer details.
 *
 * Returns success=true with empty fields when the customer cannot
 * be found (the Python source preserves this graceful-empty
 * behaviour so the form still loads).
 */
import type { Knex } from 'knex';
export interface CustomerEmailResponse {
    success: boolean;
    email: string;
    name: string;
    contact?: string;
    error?: string;
}
export declare function getCustomerEmail(operaDb: Knex, account: string): Promise<CustomerEmailResponse>;
//# sourceMappingURL=customer-email.d.ts.map