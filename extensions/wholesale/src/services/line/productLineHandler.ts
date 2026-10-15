/**
 * Shared transaction wrapper of the admin product line endpoints (T-2.42):
 * `createProductLine`, `updateProductLine`, `saveProductLineTiers`.
 *
 * Thin specialization of `createAdminTransactionHandler`: domain errors are
 * `ProductLineError`s, and a malformed line uuid answers 404 before any
 * database work. See that module for the response and transaction contract.
 */
import type { EvershopRequest } from '@evershop/evershop/types/request';
import type { PoolClient } from 'pg';
import {
  type AcquireConnection,
  type AdminHandler,
  createAdminTransactionHandler
} from '../admin/adminTransactionHandler.js';
import { UUID_PATTERN } from '../customer/setCustomerApproval.js';
import { isProductLineError, type ProductLine, ProductLineError } from './productLines.js';

export type { AcquireConnection };

export type ProductLineHandler = AdminHandler;

export interface ProductLineOperation {
  /** HTTP status of a success (201 for a creation, 200 otherwise). */
  successStatus: number;
  /** `true` when `:id` must be a line uuid (checked before any database work). */
  requiresLineId: boolean;
  run(connection: PoolClient, request: EvershopRequest): Promise<ProductLine>;
}

export const lineIdOf = (request: EvershopRequest): string => String(request.params?.id ?? '');

export const createProductLineHandler = (
  operation: ProductLineOperation,
  acquire?: AcquireConnection
): ProductLineHandler =>
  createAdminTransactionHandler<ProductLine>(
    {
      successStatus: operation.successStatus,
      precheck: (request) =>
        operation.requiresLineId && !UUID_PATTERN.test(lineIdOf(request))
          ? new ProductLineError('PRODUCT_LINE_NOT_FOUND', 404, 'Product line not found')
          : null,
      run: operation.run,
      isDomainError: isProductLineError
    },
    acquire
  );
