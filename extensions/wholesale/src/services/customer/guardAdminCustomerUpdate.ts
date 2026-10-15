import type { Pool, PoolClient } from 'pg';
import { checkTaxpayer } from '../taxpayer/checkTaxpayer.js';
import { normalizeRuc } from '../taxpayer/rucCheckDigit.js';
import { isTaxpayerError } from '../taxpayer/TaxpayerError.js';
import { UUID_PATTERN } from './setCustomerApproval.js';
import { normalizePhone, PROTECTED_CUSTOMER_FIELDS } from './sanitizeWholesaleFields.js';

/**
 * D-P2-7 (W4b): guard for core customer writes that bypass the core
 * `updateCustomer` service, its `customerDataBeforeUpdate` processors and
 * its `updateCustomerData` hooks — today the admin
 * `PATCH /api/customers/:id` handler, which writes the request body with
 * `update('customer').given(request.body)` and no transaction.
 *
 * Wholesale approval changes only through the audited
 * `POST /api/wholesale/customers/:id/approval`, so this guard:
 *
 * - removes every approval column from the body (`PROTECTED_CUSTOMER_FIELDS`);
 * - refuses a phone or tax_id change of an approved wholesale customer
 *   (`WHOLESALE_REVOKE_REQUIRED`): the bypassing write cannot revoke and
 *   audit atomically with the change, so the admin revokes first through the
 *   approval endpoint and edits afterwards;
 * - for any other customer, normalizes the phone and validates/normalizes a
 *   changed tax_id with `checkTaxpayer` (same rules as the profile hook
 *   `revokeOnContactChange`), refusing an invalid one with its taxpayer code.
 *
 * Only reads; nothing is written here.
 */

type CustomerData = Record<string, unknown>;

export type CustomerWriteRefusalCode =
  | 'WHOLESALE_REVOKE_REQUIRED'
  | 'RUC_INVALID_FORMAT'
  | 'RUC_INVALID_CHECK_DIGIT'
  | 'DNIT_401';

export class CustomerWriteRefusal extends Error {
  readonly code: CustomerWriteRefusalCode;

  readonly status = 422;

  constructor(code: CustomerWriteRefusalCode, message: string) {
    super(message);
    this.name = 'CustomerWriteRefusal';
    this.code = code;
  }
}

export const isCustomerWriteRefusal = (e: unknown): e is CustomerWriteRefusal => e instanceof CustomerWriteRefusal;

export const REVOKE_REQUIRED_MESSAGE =
  'Changing the phone or tax_id of an approved wholesale customer requires revoking the approval first ' +
  '(POST /api/wholesale/customers/:id/approval).';

type Queryable = Pick<Pool | PoolClient, 'query'>;

interface ContactRow {
  phone: string | null;
  tax_id: string | null;
  is_wholesale_approved: boolean;
}

const has = (data: CustomerData, key: string): boolean => Object.prototype.hasOwnProperty.call(data, key);

/** Comparable form of a value: blank strings and missing values are `null` (as `revokeOnContactChange`). */
const comparable = (value: unknown): string | null => {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return text === '' ? null : text;
};

/** The stored form of a typed RUC, or `null` when it is not a valid RUC. */
const storedRucOf = (value: unknown): string | null => {
  try {
    return normalizeRuc(typeof value === 'string' ? value : '').normalized;
  } catch {
    return null;
  }
};

/** Removes every approval column from a customer write body, in place. */
export function stripProtectedFields(data: CustomerData): void {
  for (const key of PROTECTED_CUSTOMER_FIELDS) {
    delete data[key];
  }
}

/**
 * Applies the guard to `data` in place (strips, normalizes) or throws
 * `CustomerWriteRefusal`. `db` is only queried when `data` carries `phone`
 * or `tax_id`. An unknown customer is left to the core handler.
 */
export async function guardAdminCustomerUpdate(
  customerUuid: string,
  data: CustomerData,
  db: Queryable | undefined
): Promise<void> {
  stripProtectedFields(data);
  const touchesPhone = has(data, 'phone');
  const touchesTaxId = has(data, 'tax_id');
  if (!touchesPhone && !touchesTaxId) {
    return;
  }
  if (!UUID_PATTERN.test(customerUuid)) {
    // Core rejects the id itself; nothing to compare against.
    return;
  }
  if (!db) {
    throw new Error('guardAdminCustomerUpdate: no database pool to read the customer');
  }

  const { rows } = await db.query<ContactRow>(
    'SELECT "phone", "tax_id", "is_wholesale_approved" FROM "customer" WHERE "uuid" = $1',
    [customerUuid]
  );
  const current = rows[0];
  if (!current) {
    return;
  }

  if (touchesPhone && typeof data.phone === 'string') {
    data.phone = normalizePhone(data.phone);
  }
  const phoneChanged = touchesPhone && comparable(data.phone) !== comparable(current.phone);
  const taxIdTyped = touchesTaxId && comparable(data.tax_id) !== comparable(current.tax_id);

  if (current.is_wholesale_approved === true) {
    if (taxIdTyped) {
      // Same RUC typed differently is not a change; anything else (another
      // RUC, an invalid or emptied one) is.
      const stored = storedRucOf(data.tax_id);
      if (stored === null || stored !== current.tax_id) {
        throw new CustomerWriteRefusal('WHOLESALE_REVOKE_REQUIRED', REVOKE_REQUIRED_MESSAGE);
      }
      data.tax_id = stored;
    }
    if (phoneChanged) {
      throw new CustomerWriteRefusal('WHOLESALE_REVOKE_REQUIRED', REVOKE_REQUIRED_MESSAGE);
    }
    return;
  }

  if (taxIdTyped) {
    try {
      // Throws RUC_INVALID_FORMAT (also for an emptied RUC), RUC_INVALID_CHECK_DIGIT or DNIT_401.
      const lookup = await checkTaxpayer(data.tax_id);
      data.tax_id = lookup.ruc;
      if (lookup.businessName) {
        // Development/demo: the DNIT mock name follows the RUC, as at registration.
        data.business_name = lookup.businessName;
      }
    } catch (e) {
      if (isTaxpayerError(e)) {
        throw new CustomerWriteRefusal(e.code, e.message);
      }
      throw e;
    }
  }
}
