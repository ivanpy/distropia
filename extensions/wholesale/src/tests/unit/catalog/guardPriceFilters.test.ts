/**
 * Unit tests for the price filter guard (ADR-06 item 5, T-2.10e), run on the
 * real compiled core filter definitions with a query stand-in that records
 * what the filters add.
 */
import path from 'path';
import type { PoolClient } from '@evershop/postgres-query-builder';
import {
  guardPriceFilters,
  isPriceSort,
  type CollectionFilter
} from '../../../services/catalog/guardPriceFilters.js';
import {
  arePriceFiltersHidden,
  runWithPriceFilterScope
} from '../../../services/catalog/priceFilterScope.js';

const CORE_FILTERS = path.resolve(
  process.cwd(),
  'packages/evershop/dist/modules/catalog/services/registerDefaultProductCollectionFilters.js'
);

type RegisterFilters = (this: unknown) => Promise<CollectionFilter[]>;

/** Records the predicates and orderings a filter adds. */
function recordingQuery() {
  const calls: unknown[][] = [];
  return {
    calls,
    andWhere: (...args: unknown[]) => calls.push(['andWhere', ...args]),
    orderBy: (...args: unknown[]) => calls.push(['orderBy', ...args])
  };
}

/** A context whose customer approval is read from an in-memory pool. */
function viewer(approved: boolean) {
  const pool = {
    async query() {
      return { rows: [{ is_wholesale_approved: approved }] };
    },
    release() {}
  };
  return { customer: { customer_id: 1 }, pool: pool as unknown as PoolClient };
}

const REQUEST = [
  ['min_price', 'eq', '10'],
  ['max_price', 'eq', '90'],
  ['ob', 'eq', 'price'],
  ['name', 'like', 'shirt']
] as const;

/** Apply filters the way core `ProductCollection.init` does. */
async function apply(filters: CollectionFilter[]) {
  const query = recordingQuery();
  const currentFilters: { key: string }[] = [];
  for (const [key, operation, value] of REQUEST) {
    const filter = filters.find((f) => f.key === key);
    await filter?.callback.apply({ isAdmin: false }, [query, operation, value, currentFilters]);
  }
  return { calls: query.calls, keys: currentFilters.map((f) => f.key) };
}

describe('guardPriceFilters', () => {
  let coreFilters: CollectionFilter[];

  beforeAll(async () => {
    const register = ((await import(CORE_FILTERS)) as { default: RegisterFilters }).default;
    coreFilters = await register.call({ isAdmin: false, filterableAttributes: [] });
  });

  it('behaves exactly like core outside a wholesale scope', async () => {
    const core = await apply(coreFilters);
    expect(core.keys).toEqual(['min_price', 'max_price', 'ob', 'name']);
    await expect(apply(guardPriceFilters(coreFilters))).resolves.toEqual(core);
    await expect(
      runWithPriceFilterScope(viewer(false), () => apply(guardPriceFilters(coreFilters)))
    ).resolves.toEqual(core);
  });

  it('ignores price range filters and price sorting for a wholesale viewer', async () => {
    const guarded = guardPriceFilters(coreFilters);
    const result = await runWithPriceFilterScope(viewer(true), () => apply(guarded));
    expect(result.keys).toEqual(['name']);
    expect(result.calls).toEqual([
      // `ob` with an unknown code: core default order, not the price.
      ['orderBy', 'product.product_id', 'DESC'],
      ['andWhere', 'product_description.name', 'ILIKE', '%shirt%']
    ]);
  });

  it('keeps non-price sorting for a wholesale viewer', async () => {
    const ob = guardPriceFilters(coreFilters).find((f) => f.key === 'ob') as CollectionFilter;
    const query = recordingQuery();
    const currentFilters: { key: string; value: unknown }[] = [];
    await runWithPriceFilterScope(viewer(true), () =>
      ob.callback.apply({ isAdmin: false }, [query, 'eq', 'name', currentFilters])
    );
    expect(query.calls).toEqual([['orderBy', 'product_description.name']]);
    expect(currentFilters).toEqual([{ key: 'ob', operation: 'eq', value: 'name' }]);
  });

  it('leaves the scope only for the wrapped call', async () => {
    await runWithPriceFilterScope(viewer(true), async () => {
      expect(arePriceFiltersHidden()).toBe(true);
    });
    expect(arePriceFiltersHidden()).toBe(false);
  });

  it.each([
    ['price', true],
    ['PRICE', true],
    ['price_desc', true],
    ['final_price', true],
    ['name', false],
    ['qty', false],
    [undefined, false],
    [42, false]
  ])('isPriceSort(%p) is %p', (value, expected) => {
    expect(isPriceSort(value)).toBe(expected);
  });
});
