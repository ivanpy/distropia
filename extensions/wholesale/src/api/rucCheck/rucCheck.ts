/**
 * GET /api/wholesale/ruc-check?ruc=80012344-1 (public, T-2.37).
 *
 * Registration form helper (CU-00 step 2): validates format and check digit
 * and asks the taxpayer provider of the runtime mode
 * (`03_endpoints_y_contratos.md` §3). UX only: the registration processor
 * repeats the same check.
 *
 * 3-arg signature: the handler sends the response itself, so the framework
 * must not auto-call `next()` (ERR_HTTP_HEADERS_SENT).
 */
import type { EvershopRequest } from '@evershop/evershop/types/request';
import type { EvershopResponse } from '@evershop/evershop/types/response';
import { checkTaxpayer } from '../../services/taxpayer/checkTaxpayer.js';
import { isTaxpayerError } from '../../services/taxpayer/TaxpayerError.js';

// Core `lib/util/httpStatus` ships without type declarations.
const OK = 200;
const UNPROCESSABLE_ENTITY = 422;

export default async (
  request: EvershopRequest,
  response: EvershopResponse,
  next: (err?: unknown) => void
) => {
  try {
    const lookup = await checkTaxpayer(request.query.ruc);
    response.status(OK).json({ data: lookup });
  } catch (e) {
    if (isTaxpayerError(e)) {
      response.status(UNPROCESSABLE_ENTITY).json({
        error: { status: UNPROCESSABLE_ENTITY, code: e.code, message: e.message }
      });
      return;
    }
    next(e);
  }
};
