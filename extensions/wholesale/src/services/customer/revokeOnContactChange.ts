import type { PoolClient } from 'pg';
import { writeAudit } from '../audit/writeAudit.js';
import { checkTaxpayer } from '../taxpayer/checkTaxpayer.js';
import { normalizePhone } from './sanitizeWholesaleFields.js';

/**
 * RF-22 / threat A7: changing `phone` or `tax_id` of an approved wholesale
 * customer revokes the approval until an admin reviews it, so a compromised
 * account cannot redirect quotes to another WhatsApp number.
 *
 * Registered in `bootstrap.ts` as a before-hook of core `updateCustomerData`
 * (`modules/customer/services/customer/updateCustomer.ts`), which runs inside
 * the core update transaction with `(uuid, data, connection)` after the
 * `customerDataBeforeUpdate` processors (so the approval fields set here are
 * not stripped) and before core writes `data` with `update().given(data)`.
 * Address updates never reach this hook: they do not touch `customer`.
 *
 * Also normalizes `phone` like the registration does and validates a changed
 * `tax_id` with `checkTaxpayer` (format, check digit, provider of the runtime
 * mode), which throws `TaxpayerError` and makes core roll the update back.
 */

type CustomerData = Record<string, unknown>;

interface ContactRow {
  uuid: string;
  phone: string | null;
  tax_id: string | null;
  is_wholesale_approved: boolean;
  wholesale_approved_at: Date | null;
  wholesale_approved_by: number | null;
}

const has = (data: CustomerData, key: string): boolean => Object.prototype.hasOwnProperty.call(data, key);

/** Comparable form of a submitted value: blank strings and missing values are `null`. */
const comparable = (value: unknown): string | null => {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return text === '' ? null : text;
};

export async function revokeApprovalOnContactChange(
  uuid: string,
  data: CustomerData,
  connection: PoolClient
): Promise<void> {
  const touchesPhone = has(data, 'phone');
  const touchesTaxId = has(data, 'tax_id');
  if (!touchesPhone && !touchesTaxId) {
    return;
  }

  const { rows } = await connection.query<ContactRow>(
    `SELECT "uuid", "phone", "tax_id", "is_wholesale_approved", "wholesale_approved_at", "wholesale_approved_by"
       FROM "customer" WHERE "uuid" = $1 FOR UPDATE`,
    [uuid]
  );
  const current = rows[0];
  if (!current) {
    // Core answers "Requested customer not found" right after this hook.
    return;
  }

  const changed: string[] = [];
  if (touchesPhone) {
    if (typeof data.phone === 'string') {
      data.phone = normalizePhone(data.phone);
    }
    if (comparable(data.phone) !== comparable(current.phone)) {
      changed.push('phone');
    }
  }
  if (touchesTaxId && comparable(data.tax_id) !== comparable(current.tax_id)) {
    // Throws RUC_INVALID_FORMAT (also for an emptied RUC), RUC_INVALID_CHECK_DIGIT or DNIT_401.
    const lookup = await checkTaxpayer(data.tax_id);
    data.tax_id = lookup.ruc;
    if (lookup.businessName) {
      // Development/demo: the DNIT mock name follows the RUC, as at registration.
      data.business_name = lookup.businessName;
    }
    if (lookup.ruc !== current.tax_id) {
      changed.push('tax_id');
    }
  }

  if (changed.length === 0 || current.is_wholesale_approved !== true) {
    return;
  }

  data.is_wholesale_approved = false;
  data.wholesale_approved_at = null;
  data.wholesale_approved_by = null;

  const contact = (phone: unknown, taxId: unknown) => ({ phone: comparable(phone), tax_id: comparable(taxId) });
  await writeAudit(connection, {
    actor: { type: 'system' },
    action: 'customer.revoke',
    entityType: 'customer',
    entityUuid: current.uuid,
    before: {
      is_wholesale_approved: true,
      wholesale_approved_at: current.wholesale_approved_at ? current.wholesale_approved_at.toISOString() : null,
      wholesale_approved_by: current.wholesale_approved_by,
      ...contact(current.phone, current.tax_id)
    },
    after: {
      is_wholesale_approved: false,
      wholesale_approved_at: null,
      wholesale_approved_by: null,
      ...contact(touchesPhone ? data.phone : current.phone, touchesTaxId ? data.tax_id : current.tax_id)
    },
    reason: `Automatic revocation (RF-22): ${changed.join(', ')} changed`
  });
}
