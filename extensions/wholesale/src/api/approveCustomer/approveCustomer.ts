/**
 * POST /api/wholesale/customers/:id/approval (private, T-2.6).
 *
 * Body `{ "approved": true | false }` (`payloadSchema.json`, validated by the
 * core `payloadValidate` middleware); `:id` is the customer uuid. Admin
 * access is enforced by the core `auth` middleware (`"access": "private"`).
 *
 * Approval, credit row and audit row run in one transaction
 * (`setCustomerApproval`).
 *
 * 3-arg signature: the handler answers errors itself, so the framework must
 * not auto-call `next()` (ERR_HTTP_HEADERS_SENT); on success it sets
 * `$body` and calls `next()` for the core `apiResponse`.
 *
 * `createApproveCustomerHandler` takes the connection source so tests can
 * run the transaction path on a rolled-back fixture transaction; the route
 * uses the core pool.
 */
import { pool } from '@evershop/evershop/lib/postgres';
import type { EvershopRequest } from '@evershop/evershop/types/request';
import type { EvershopResponse } from '@evershop/evershop/types/response';
import type { PoolClient } from 'pg';
import { commit, getConnection, rollback, startTransaction } from '@evershop/postgres-query-builder';
import {
  ApprovalError,
  isApprovalError,
  setCustomerApproval,
  UUID_PATTERN
} from '../../services/customer/setCustomerApproval.js';

// Core `lib/util/httpStatus` ships without type declarations.
const OK = 200;
const UNAUTHORIZED = 401;

/** Acquires a dedicated client for the approval transaction (released by commit/rollback). */
export type AcquireConnection = () => Promise<PoolClient>;

export const createApproveCustomerHandler =
  (acquire: AcquireConnection = () => getConnection(pool)) =>
  async (request: EvershopRequest, response: EvershopResponse, next: (err?: unknown) => void) => {
    const fail = (e: ApprovalError) => {
      response.status(e.status).json({ error: { status: e.status, code: e.code, message: e.message } });
    };

    const customerUuid = String(request.params.id ?? '');
    if (!UUID_PATTERN.test(customerUuid)) {
      fail(new ApprovalError('CUSTOMER_NOT_FOUND', 404, 'Customer not found'));
      return;
    }
    const admin = request.getCurrentUser();
    if (!admin) {
      // Unreachable behind the core auth middleware; never audit an unknown actor.
      response.status(UNAUTHORIZED).json({ error: { status: UNAUTHORIZED, message: 'Unauthorized' } });
      return;
    }

    let connection;
    try {
      connection = await acquire();
      await startTransaction(connection);
      const result = await setCustomerApproval(connection, {
        customerUuid,
        approved: request.body.approved === true,
        actor: { type: 'admin', adminUserId: admin.admin_user_id, email: admin.email }
      });
      await commit(connection);
      response.status(OK);
      response.$body = { data: result };
      next();
    } catch (e) {
      if (connection) {
        await rollback(connection).catch(() => undefined);
      }
      if (isApprovalError(e)) {
        fail(e);
        return;
      }
      next(e);
    }
  };

export default createApproveCustomerHandler();
