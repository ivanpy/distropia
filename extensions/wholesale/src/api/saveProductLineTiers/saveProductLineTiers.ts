/**
 * PUT /api/wholesale/product-lines/:id/tiers (private, T-2.42, CU-01a step 3).
 *
 * `:id` is the line uuid. Body `{ tiers: [{ fromQty, discountPercent, label? }] }`
 * replaces the whole table in one transaction. The schema checks only types
 * (400); ranges, order, duplicates and label length are `422 INVALID_TIERS`
 * with per-row errors (`validateLineTiers`), the previous table intact.
 */
import type { EvershopRequest } from '@evershop/evershop/types/request';
import {
  type AcquireConnection,
  createProductLineHandler,
  lineIdOf
} from '../../services/line/productLineHandler.js';
import { replaceProductLineTiers } from '../../services/line/productLines.js';

const OK = 200;

export const createSaveProductLineTiersHandler = (acquire?: AcquireConnection) =>
  createProductLineHandler(
    {
      successStatus: OK,
      requiresLineId: true,
      run: (connection, request: EvershopRequest) =>
        replaceProductLineTiers(connection, lineIdOf(request), request.body.tiers)
    },
    acquire
  );

export default createSaveProductLineTiersHandler();
