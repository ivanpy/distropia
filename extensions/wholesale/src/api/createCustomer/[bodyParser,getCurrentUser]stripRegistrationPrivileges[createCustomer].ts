/**
 * W4b (c): mass-assignment guard of the core `POST /api/customers`
 * (`modules/customer/api/createCustomer`), a public route (storefront
 * registration). The core `createCustomer` service writes `group_id` and
 * `status` from the body when present, so a non-admin caller could pick its
 * customer group or register disabled (`status: 0` emits `account_created`
 * instead of `customer_registered`, skipping the pending-approval notice).
 *
 * Runs after `getCurrentUser` (admin session or admin JWT resolved) and
 * before the core handler. An authenticated admin keeps both fields. The
 * approval columns are removed for everyone by the
 * `customerDataBeforeCreate` processor (`sanitizeWholesaleOnCreate`).
 */
import type { EvershopRequest } from '@evershop/evershop/types/request';
import type { EvershopResponse } from '@evershop/evershop/types/response';

/** Body keys only an admin may set on a new customer. */
export const ADMIN_ONLY_REGISTRATION_FIELDS = ['group_id', 'status'] as const;

export default (request: EvershopRequest, response: EvershopResponse, next: (err?: unknown) => void) => {
  const body: unknown = request.body;
  const admin = request.getCurrentUser?.();
  if (!admin?.uuid && body !== null && typeof body === 'object') {
    for (const key of ADMIN_ONLY_REGISTRATION_FIELDS) {
      delete (body as Record<string, unknown>)[key];
    }
  }
  next();
};
