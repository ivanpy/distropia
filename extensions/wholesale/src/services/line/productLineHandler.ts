/**
 * Shared transaction wrapper of the admin product line endpoints (T-2.42):
 * `createProductLine`, `updateProductLine`, `saveProductLineTiers`.
 *
 * Lives under `services/` because every file in an `api/<route>/` folder is
 * loaded as a middleware of that route.
 *
 * The returned handler has the 3-arg signature: it answers domain errors
 * itself (`{ error: { status, code, message, details? } }`), so the framework
 * must not auto-call `next()` (ERR_HTTP_HEADERS_SENT); on success it sets
 * `$body = { data: line }` and calls `next()` for the core `apiResponse`.
 * Unexpected errors roll back and go to the core error handler.
 *
 * `acquire` is injectable so tests can run the transaction path on a
 * rolled-back fixture transaction; routes use the core pool.
 */
import { pool } from '@evershop/evershop/lib/postgres';
import type { EvershopRequest } from '@evershop/evershop/types/request';
import type { EvershopResponse } from '@evershop/evershop/types/response';
import type { PoolClient } from 'pg';
import { commit, getConnection, rollback, startTransaction } from '@evershop/postgres-query-builder';
import { UUID_PATTERN } from '../customer/setCustomerApproval.js';
import { isProductLineError, type ProductLine, ProductLineError } from './productLines.js';

/** Acquires a dedicated client for the transaction (released by commit/rollback). */
export type AcquireConnection = () => Promise<PoolClient>;

export type ProductLineHandler = (
  request: EvershopRequest,
  response: EvershopResponse,
  next: (err?: unknown) => void
) => Promise<void>;

export interface ProductLineOperation {
  /** HTTP status of a success (201 for a creation, 200 otherwise). */
  successStatus: number;
  /** `true` when `:id` must be a line uuid (checked before any database work). */
  requiresLineId: boolean;
  run(connection: PoolClient, request: EvershopRequest): Promise<ProductLine>;
}

export const lineIdOf = (request: EvershopRequest): string => String(request.params?.id ?? '');

export const createProductLineHandler =
  (operation: ProductLineOperation, acquire: AcquireConnection = () => getConnection(pool)): ProductLineHandler =>
  async (request, response, next) => {
    const fail = (e: ProductLineError) => {
      response.status(e.status).json({
        error: {
          status: e.status,
          code: e.code,
          message: e.message,
          ...(e.details === undefined ? {} : { details: e.details })
        }
      });
    };

    if (operation.requiresLineId && !UUID_PATTERN.test(lineIdOf(request))) {
      fail(new ProductLineError('PRODUCT_LINE_NOT_FOUND', 404, 'Product line not found'));
      return;
    }

    let connection;
    try {
      connection = await acquire();
      await startTransaction(connection);
      const line = await operation.run(connection, request);
      await commit(connection);
      response.status(operation.successStatus);
      response.$body = { data: line };
      next();
    } catch (e) {
      if (connection) {
        await rollback(connection).catch(() => undefined);
      }
      if (isProductLineError(e)) {
        fail(e);
        return;
      }
      next(e);
    }
  };
