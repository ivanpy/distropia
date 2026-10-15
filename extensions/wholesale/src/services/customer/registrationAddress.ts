import { insert } from '@evershop/postgres-query-builder';
import type { CustomerRow } from '@evershop/evershop/customer/services';
import { validateAddress } from '@evershop/evershop/customer/services';
import type { PoolClient } from 'pg';

/**
 * Commercial/fiscal address of a B2B registration (RF-19, CU-00 step 3,
 * D-P2-6). The order created from a quote uses it for shipping and invoicing
 * (ADR-07), so a B2B registration through core `POST /api/customers` must
 * carry it as `address` and it is stored as the default `customer_address`
 * row in the same transaction as the customer.
 *
 * Errors are thrown inside the core registration transaction, so the
 * customer is rolled back. Core `createCustomer` maps any thrown error to
 * HTTP 500 with its message (accepted; a 422 mapping is a follow-up).
 */
export type WholesaleAddressErrorCode = 'WHOLESALE_ADDRESS_REQUIRED' | 'WHOLESALE_ADDRESS_INVALID';

export class WholesaleAddressError extends Error {
  readonly code: WholesaleAddressErrorCode;

  constructor(code: WholesaleAddressErrorCode, message: string) {
    super(message);
    this.name = 'WholesaleAddressError';
    this.code = code;
  }
}

export const isWholesaleAddressError = (e: unknown): e is WholesaleAddressError =>
  e instanceof WholesaleAddressError;

/** `customer_address` columns a registration may set (same as the core address APIs). */
export const REGISTRATION_ADDRESS_FIELDS = [
  'full_name',
  'telephone',
  'address_1',
  'address_2',
  'city',
  'province',
  'country',
  'postcode'
] as const;

export type RegistrationAddress = Partial<Record<(typeof REGISTRATION_ADDRESS_FIELDS)[number], string>>;

/** Request key that carries the address; it is never a `customer` column. */
export const REGISTRATION_ADDRESS_KEY = 'address';

/**
 * Keeps only the address columns (so `customer_id`, `uuid` or `is_default`
 * sent by the client are dropped), trims them and applies the core address
 * validation. Throws `WHOLESALE_ADDRESS_REQUIRED` when there is no address
 * and `WHOLESALE_ADDRESS_INVALID` when it is not an object, a field is not a
 * string (a numeric `telephone` is accepted) or core validation fails.
 */
export function normalizeRegistrationAddress(raw: unknown): RegistrationAddress {
  if (raw === undefined || raw === null) {
    throw new WholesaleAddressError(
      'WHOLESALE_ADDRESS_REQUIRED',
      'A commercial/fiscal address is required for a wholesale registration'
    );
  }
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new WholesaleAddressError('WHOLESALE_ADDRESS_INVALID', 'The address must be an object');
  }
  const source = raw as Record<string, unknown>;
  const address: RegistrationAddress = {};
  for (const field of REGISTRATION_ADDRESS_FIELDS) {
    const value = field === 'telephone' && typeof source[field] === 'number' ? String(source[field]) : source[field];
    if (value === undefined || value === null) {
      continue;
    }
    if (typeof value !== 'string') {
      throw new WholesaleAddressError('WHOLESALE_ADDRESS_INVALID', `Address field ${field} must be a string`);
    }
    address[field] = value.trim();
  }
  const { valid, errors } = validateAddress(address);
  if (!valid) {
    throw new WholesaleAddressError('WHOLESALE_ADDRESS_INVALID', errors.join(', '));
  }
  return address;
}

/** Addresses waiting for their customer row, keyed by the data object core inserts. */
const pending = new WeakMap<object, RegistrationAddress>();

/**
 * `hookBefore('insertCustomerData')`: removes `address` from the customer
 * data (core writes every key matching a `customer` column) and, for a B2B
 * registration (`wholesale_requested_at`, only set by
 * `sanitizeWholesaleOnCreate`), keeps the address for the after hook.
 */
export function takeRegistrationAddress(data: Record<string, unknown>): void {
  const raw = data[REGISTRATION_ADDRESS_KEY];
  delete data[REGISTRATION_ADDRESS_KEY];
  if (!data.wholesale_requested_at) {
    return;
  }
  pending.set(data, normalizeRegistrationAddress(raw));
}

/**
 * `hookAfter('insertCustomerData')`: inserts the B2B address as the default
 * address with the registration transaction connection. The customer is new,
 * so there is no other default address to reset. `is_default` is BOOLEAN
 * since core customer migration 1.0.3 (the `is_default = 1` of RF-19).
 */
export async function insertRegistrationAddress(
  customer: CustomerRow,
  data: Record<string, unknown>,
  connection: PoolClient
): Promise<void> {
  const address = pending.get(data);
  if (!address) {
    return;
  }
  pending.delete(data);
  await insert('customer_address')
    .given({ ...address, customer_id: customer.customer_id, is_default: true })
    .execute(connection);
}
