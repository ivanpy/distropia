import { checkTaxpayer } from '../taxpayer/checkTaxpayer.js';
import { normalizeRegistrationAddress, REGISTRATION_ADDRESS_KEY } from './registrationAddress.js';

/**
 * Mass-assignment guard (A9) and B2B registration data
 * (`01_arquitectura_evershop.md` §4, CU-00 step 3, RF-20).
 *
 * Core registration and profile edition write every body key that matches a
 * `customer` column. These processors remove the approval fields, which are
 * only written by the admin approval endpoint with its own UPDATE.
 */
export const PROTECTED_CUSTOMER_FIELDS = [
  'is_wholesale_approved',
  'wholesale_approved_at',
  'wholesale_approved_by',
  'wholesale_requested_at'
] as const;

/**
 * Registered after any other processor of the same values, so nothing can
 * put a protected field back (registry processors run by ascending priority;
 * 1000 is reserved for a final processor).
 */
export const WHOLESALE_CUSTOMER_GUARD_PRIORITY = 900;

type CustomerData = Record<string, unknown>;

function withoutProtectedFields(data: CustomerData): CustomerData {
  const clean = { ...data };
  for (const key of PROTECTED_CUSTOMER_FIELDS) {
    delete clean[key];
  }
  return clean;
}

/** Removes the separators people type in a phone number (spaces, `-`, `.`, parentheses). */
export const normalizePhone = (raw: string): string => raw.replace(/[\s\-.()]/g, '');

/**
 * `customerDataBeforeCreate` processor. A registration carrying `tax_id` or
 * `business_name` is a B2B registration: the RUC check is repeated (the
 * `ruc-check` answer is UX only) and throws `TaxpayerError`
 * (`RUC_INVALID_FORMAT`, `RUC_INVALID_CHECK_DIGIT`, `DNIT_401`), which makes
 * core roll the registration back. It must also carry its commercial/fiscal
 * `address` (RF-19), validated here so an invalid request fails before the
 * insert (`WholesaleAddressError`); the address row itself is written by the
 * `insertCustomerData` hooks in `registrationAddress.ts`. A B2C registration
 * drops any `address`.
 */
export async function sanitizeWholesaleOnCreate(data: CustomerData): Promise<CustomerData> {
  const clean = withoutProtectedFields(data);
  clean.is_wholesale_approved = false;
  if (clean.business_name || clean.tax_id) {
    const lookup = await checkTaxpayer(clean.tax_id);
    clean.tax_id = lookup.ruc;
    if (lookup.businessName) {
      // Development/demo: the DNIT mock name wins and is locked in the form.
      clean.business_name = lookup.businessName;
    }
    if (typeof clean.phone === 'string') {
      clean.phone = normalizePhone(clean.phone);
    }
    clean[REGISTRATION_ADDRESS_KEY] = normalizeRegistrationAddress(clean[REGISTRATION_ADDRESS_KEY]);
    // ISO string: the query builder JSON-encodes object values in `given()`.
    clean.wholesale_requested_at = new Date().toISOString();
  } else {
    delete clean[REGISTRATION_ADDRESS_KEY];
  }
  return clean;
}

/**
 * `customerDataBeforeUpdate` processor. Core also runs this value for
 * customer address updates, so it only removes keys and never assumes the
 * object is a customer.
 */
export function sanitizeWholesaleOnUpdate(data: CustomerData): CustomerData {
  return withoutProtectedFields(data);
}
