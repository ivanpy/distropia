/**
 * POST /api/wholesale/product-lines (private, T-2.42, CU-01a).
 *
 * Body `{ name, countsTowardMix?, isActive? }` (`payloadSchema.json`, core
 * `payloadValidate` → 400 naming the field). `201 { data: line }`;
 * `409 PRODUCT_LINE_NAME_TAKEN` for a name already used (case-insensitive).
 * Admin access is enforced by the core `auth` middleware.
 */
import type { EvershopRequest } from '@evershop/evershop/types/request';
import {
  type AcquireConnection,
  createProductLineHandler
} from '../../services/line/productLineHandler.js';
import { createProductLine } from '../../services/line/productLines.js';

const CREATED = 201;

export const createCreateProductLineHandler = (acquire?: AcquireConnection) =>
  createProductLineHandler(
    {
      successStatus: CREATED,
      requiresLineId: false,
      run: (connection, request: EvershopRequest) =>
        createProductLine(connection, {
          name: request.body.name,
          countsTowardMix: request.body.countsTowardMix,
          isActive: request.body.isActive
        })
    },
    acquire
  );

export default createCreateProductLineHandler();
