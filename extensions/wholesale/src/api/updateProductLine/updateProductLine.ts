/**
 * PATCH /api/wholesale/product-lines/:id (private, T-2.42, CU-01a step 4).
 *
 * `:id` is the line uuid. Body `{ name?, countsTowardMix?, isActive? }`, at
 * least one field (`payloadSchema.json`). Renames, activates or deactivates
 * the line; issued quotes keep their snapshot. `200 { data: line }`;
 * `404 PRODUCT_LINE_NOT_FOUND`; `409 PRODUCT_LINE_NAME_TAKEN`.
 */
import type { EvershopRequest } from '@evershop/evershop/types/request';
import {
  type AcquireConnection,
  createProductLineHandler,
  lineIdOf
} from '../../services/line/productLineHandler.js';
import { updateProductLine } from '../../services/line/productLines.js';

const OK = 200;

export const createUpdateProductLineHandler = (acquire?: AcquireConnection) =>
  createProductLineHandler(
    {
      successStatus: OK,
      requiresLineId: true,
      run: (connection, request: EvershopRequest) =>
        updateProductLine(connection, lineIdOf(request), {
          name: request.body.name,
          countsTowardMix: request.body.countsTowardMix,
          isActive: request.body.isActive
        })
    },
    acquire
  );

export default createUpdateProductLineHandler();
