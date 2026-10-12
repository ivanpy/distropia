/**
 * Decides whether the current GraphQL viewer is an approved wholesale
 * customer (ADR-06): `customer.is_wholesale_approved === true`, read from the
 * database. The approval flag carried by the context/session customer row is
 * never trusted, only its id.
 *
 * The answer is memoized per GraphQL context (one context object per request
 * in core), so a product listing runs a single query instead of one per
 * product. Concurrent field resolvers share the same pending promise.
 */
import { select } from '@evershop/postgres-query-builder';
import type { Pool, PoolClient } from '@evershop/postgres-query-builder';

/** The subset of the core GraphQL context this service reads. */
export interface ViewerContext {
  /** Set by core from the session (`request.locals.customer`); may be absent. */
  customer?: { customer_id?: unknown } | null;
  /**
   * Set by core on every request (`setContextValue(request, 'pool', pool)`).
   * A PoolClient must be flagged `INTRANSACTION`, otherwise the query builder
   * releases it after the lookup.
   */
  pool?: Pool | PoolClient;
}

const cache = new WeakMap<object, Promise<boolean>>();

async function lookupApproval(context: ViewerContext): Promise<boolean> {
  const customerId = Number(context.customer?.customer_id);
  if (!Number.isInteger(customerId) || customerId <= 0) {
    return false;
  }
  if (!context.pool) {
    // Without a connection the approval cannot be verified; fail closed by
    // erroring the price field instead of exposing it.
    throw new Error('isWholesaleViewer: GraphQL context has no database pool');
  }
  const row = await select('is_wholesale_approved')
    .from('customer')
    .where('customer_id', '=', customerId)
    .and('status', '=', 1)
    .load(context.pool);
  // Strict boolean check: a non-boolean value never grants wholesale status.
  return row?.is_wholesale_approved === true;
}

export function isWholesaleViewer(
  context: ViewerContext | null | undefined
): Promise<boolean> {
  if (!context || typeof context !== 'object') {
    return Promise.resolve(false);
  }
  let pending = cache.get(context);
  if (!pending) {
    pending = lookupApproval(context);
    cache.set(context, pending);
  }
  return pending;
}
