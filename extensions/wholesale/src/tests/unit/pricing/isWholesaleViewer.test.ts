/**
 * Unit tests for isWholesaleViewer (ADR-06, T-2.10a) with an in-memory pool.
 * The DB-backed path is covered by tests/unit/graphql/productPriceMasking.test.ts.
 */
import type { PoolClient } from '@evershop/postgres-query-builder';
import {
  isWholesaleViewer,
  type ViewerContext
} from '../../../services/pricing/isWholesaleViewer.js';

type FakePool = PoolClient & { calls: unknown[][] };

/** A minimal PoolClient stand-in for the query builder (query + release). */
function fakePool(approval: unknown, found = true): FakePool {
  const calls: unknown[][] = [];
  const fake = {
    calls,
    async query(config: { text: string; values?: unknown[] }) {
      calls.push(config.values ?? []);
      return { rows: found ? [{ is_wholesale_approved: approval }] : [] };
    },
    release() {}
  };
  return fake as unknown as FakePool;
}

describe('isWholesaleViewer', () => {
  it('is true only for an approved customer', async () => {
    const pool = fakePool(true);
    await expect(isWholesaleViewer({ customer: { customer_id: 7 }, pool })).resolves.toBe(true);
    expect(pool.calls).toEqual([[7, 1]]); // customer_id, status
  });

  it('is false for a customer that is not approved', async () => {
    const context = { customer: { customer_id: 7 }, pool: fakePool(false) };
    await expect(isWholesaleViewer(context)).resolves.toBe(false);
  });

  it.each([1, 'true', 't', null, undefined])(
    'treats a non-boolean flag (%p) as not approved',
    async (flag) => {
      const context = { customer: { customer_id: 7 }, pool: fakePool(flag) };
      await expect(isWholesaleViewer(context)).resolves.toBe(false);
    }
  );

  it('is false when the customer is missing or disabled in the database', async () => {
    const context = { customer: { customer_id: 7 }, pool: fakePool(true, false) };
    await expect(isWholesaleViewer(context)).resolves.toBe(false);
  });

  it('is false for anonymous visitors without touching the database', async () => {
    const pool = fakePool(true);
    await expect(isWholesaleViewer({ pool })).resolves.toBe(false);
    await expect(isWholesaleViewer({ customer: null, pool })).resolves.toBe(false);
    await expect(isWholesaleViewer({ customer: { customer_id: 'x' }, pool })).resolves.toBe(false);
    await expect(isWholesaleViewer(undefined)).resolves.toBe(false);
    expect(pool.calls).toHaveLength(0);
  });

  it('ignores the approval flag carried by the context customer', async () => {
    const context = {
      customer: { customer_id: 7, is_wholesale_approved: true },
      pool: fakePool(false)
    } as ViewerContext;
    await expect(isWholesaleViewer(context)).resolves.toBe(false);
  });

  it('queries once per context, even for concurrent resolvers', async () => {
    const pool = fakePool(true);
    const context = { customer: { customer_id: 7 }, pool };
    const results = await Promise.all(
      Array.from({ length: 20 }, () => isWholesaleViewer(context))
    );
    expect(results.every((r) => r === true)).toBe(true);
    await isWholesaleViewer(context);
    expect(pool.calls).toHaveLength(1);

    // A new request context is evaluated again.
    await isWholesaleViewer({ customer: { customer_id: 7 }, pool });
    expect(pool.calls).toHaveLength(2);
  });

  it('fails closed when the context has no pool', async () => {
    await expect(isWholesaleViewer({ customer: { customer_id: 7 } })).rejects.toThrow(
      /no database pool/
    );
  });
});
