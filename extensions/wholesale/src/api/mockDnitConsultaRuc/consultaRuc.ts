/**
 * GET /api/v1/mock-dnit/consulta-ruc?ruc=80012344 (development/demo, T-2.38).
 *
 * The literal DNIT contract of CIRCUITO §2 (`03_sifen_y_dnit_mock.md` §2.4):
 * `{ status: "success", data: { ruc, dv, razon_social, estado,
 * tipo_contribuyente, actividades_economicas } }` for an even base number and
 * `{ status: "error", code: "DNIT_401", message, data: { ruc, dv,
 * razon_social, estado } }` for an odd one, with the check digit computed.
 * Registration uses the in-process provider, never this endpoint.
 *
 * `ruc` is the base number (1 to 8 digits) or a full RUC whose check digit
 * is validated (G-2). Production answers 404 without a body.
 *
 * 3-arg signature: the handler sends the response itself.
 */
import type { EvershopRequest } from '@evershop/evershop/types/request';
import type { EvershopResponse } from '@evershop/evershop/types/response';
import { getRuntimeMode, mocksEnabled } from '../../services/runtime/getRuntimeMode.js';
import { DNIT_401_MESSAGE } from '../../services/taxpayer/checkTaxpayer.js';
import { dnitMockRecord } from '../../services/taxpayer/dnitMockProvider.js';
import { normalizeRuc } from '../../services/taxpayer/rucCheckDigit.js';
import { isTaxpayerError } from '../../services/taxpayer/TaxpayerError.js';

// Core `lib/util/httpStatus` ships without type declarations.
const OK = 200;
const NOT_FOUND = 404;
const UNPROCESSABLE_ENTITY = 422;

/** Base number of the query value; throws `RUC_INVALID_FORMAT` / `RUC_INVALID_CHECK_DIGIT`. */
function baseOf(raw: unknown): string {
  const compact = typeof raw === 'string' ? raw.replace(/[\s.]/g, '') : '';
  return /^\d{1,8}$/.test(compact) ? compact : normalizeRuc(compact).base;
}

export default async (
  request: EvershopRequest,
  response: EvershopResponse,
  next: (err?: unknown) => void
) => {
  if (!mocksEnabled(getRuntimeMode())) {
    response.status(NOT_FOUND).end();
    return;
  }
  try {
    const record = dnitMockRecord(baseOf(request.query.ruc));
    if (record.estado === 'ACTIVO') {
      response.status(OK).json({ status: 'success', data: record });
      return;
    }
    const { ruc, dv, razon_social, estado } = record;
    response.status(UNPROCESSABLE_ENTITY).json({
      status: 'error',
      code: 'DNIT_401',
      message: DNIT_401_MESSAGE,
      data: { ruc, dv, razon_social, estado }
    });
  } catch (e) {
    if (isTaxpayerError(e)) {
      response.status(UNPROCESSABLE_ENTITY).json({ status: 'error', code: e.code, message: e.message });
      return;
    }
    next(e);
  }
};
