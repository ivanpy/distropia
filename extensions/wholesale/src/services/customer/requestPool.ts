import type { EvershopRequest } from '@evershop/evershop/types/request';
import type { Pool, PoolClient } from 'pg';

type DbContext = { pool?: Pool | PoolClient };

/**
 * The database pool core puts in the request or app context on every API
 * request (`modules/base/api/global/context.js`). `undefined` when absent:
 * callers fail closed.
 */
export function requestPool(request: EvershopRequest): Pool | PoolClient | undefined {
  const requestContext = request.locals?.context as DbContext | undefined;
  const appContext = (request.app?.locals as { context?: DbContext } | undefined)?.context;
  return requestContext?.pool ?? appContext?.pool;
}
