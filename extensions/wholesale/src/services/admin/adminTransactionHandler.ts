/**
 * Shared transaction wrapper of the admin endpoints that write in one
 * transaction and answer their domain errors themselves (product lines,
 * product rules).
 *
 * Lives under `services/` because every file in an `api/<route>/` folder is
 * loaded as a middleware of that route.
 *
 * The returned handler has the 3-arg signature: it answers domain errors
 * itself (`{ error: { status, code, message, details? } }`), so the framework
 * must not auto-call `next()` (ERR_HTTP_HEADERS_SENT); on success it sets
 * `$body = { data }` and calls `next()` for the core `apiResponse`.
 * Unexpected errors roll back and go to the core error handler. `next()`
 * runs only after the transaction is settled (R3-handler-next-inside-try): a
 * downstream throw can neither roll back nor reach `next` twice.
 *
 * `acquire` is injectable so tests can run the transaction path on a
 * rolled-back fixture transaction; routes use the core pool.
 */
import { pool } from '@evershop/evershop/lib/postgres';
import type { EvershopRequest } from '@evershop/evershop/types/request';
import type { EvershopResponse } from '@evershop/evershop/types/response';
import type { PoolClient } from 'pg';
import { commit, getConnection, rollback, startTransaction } from '@evershop/postgres-query-builder';

/** Acquires a dedicated client for the transaction (released by commit/rollback). */
export type AcquireConnection = () => Promise<PoolClient>;

export type AdminHandler = (
  request: EvershopRequest,
  response: EvershopResponse,
  next: (err?: unknown) => void
) => Promise<void>;

/** An error the handler answers itself with its status and code. */
export interface DomainError {
  status: number;
  code: string;
  message: string;
  details?: unknown;
}

export interface AdminTransactionOperation<T> {
  /** HTTP status of a success. */
  successStatus: number;
  /** Checks run before any database work (e.g. a malformed `:id`); a returned error is answered as is. */
  precheck?(request: EvershopRequest): DomainError | null;
  run(connection: PoolClient, request: EvershopRequest): Promise<T>;
  isDomainError(e: unknown): e is DomainError;
}

export const createAdminTransactionHandler =
  <T>(operation: AdminTransactionOperation<T>, acquire: AcquireConnection = () => getConnection(pool)): AdminHandler =>
  async (request, response, next) => {
    const fail = (e: DomainError) => {
      response.status(e.status).json({
        error: {
          status: e.status,
          code: e.code,
          message: e.message,
          ...(e.details === undefined ? {} : { details: e.details })
        }
      });
    };

    const refused = operation.precheck?.(request) ?? null;
    if (refused) {
      fail(refused);
      return;
    }

    let connection;
    let data: T;
    try {
      connection = await acquire();
      await startTransaction(connection);
      data = await operation.run(connection, request);
      await commit(connection);
    } catch (e) {
      if (connection) {
        await rollback(connection).catch(() => undefined);
      }
      if (operation.isDomainError(e)) {
        fail(e);
        return;
      }
      next(e);
      return;
    }
    response.status(operation.successStatus);
    response.$body = { data };
    next();
  };
