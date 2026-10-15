/**
 * D-P2-7 (W4b): guard of the core admin `PATCH /api/customers/:id`
 * (`modules/customer/api/updateCustomer/updateCustomer.js`), which writes the
 * request body straight into `customer` without the core `updateCustomer`
 * service, its processors or hooks.
 *
 * Runs after `escapeHtml` (so after `auth` and `payloadValidate`: the caller
 * is an admin and the body is final) and before the core handler. Strips the
 * approval columns, refuses a phone/tax_id change of an approved wholesale
 * customer and validates a changed tax_id (`guardAdminCustomerUpdate`).
 *
 * 3-arg signature: it answers refusals itself, so the framework must not
 * auto-call `next()` (ERR_HTTP_HEADERS_SENT).
 */
import type { EvershopRequest } from '@evershop/evershop/types/request';
import type { EvershopResponse } from '@evershop/evershop/types/response';
import {
  guardAdminCustomerUpdate,
  isCustomerWriteRefusal
} from '../../services/customer/guardAdminCustomerUpdate.js';
import { requestPool } from '../../services/customer/requestPool.js';

export default async (request: EvershopRequest, response: EvershopResponse, next: (err?: unknown) => void) => {
  const body: unknown = request.body;
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    next();
    return;
  }
  try {
    await guardAdminCustomerUpdate(String(request.params?.id ?? ''), body as Record<string, unknown>, requestPool(request));
  } catch (e) {
    if (isCustomerWriteRefusal(e)) {
      response.status(e.status).json({ error: { status: e.status, code: e.code, message: e.message } });
      return;
    }
    next(e);
    return;
  }
  next();
};
