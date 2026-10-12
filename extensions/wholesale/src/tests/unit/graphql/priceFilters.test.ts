/**
 * Integration test for ADR-06 item 5 (no price filters/sort for wholesale
 * viewers) — T-2.10e.
 *
 * Runs the storefront product collection entry points against the merged
 * core + extension schema (see `storefrontSchema.ts`) with the
 * `productCollectionFilters` processors registered as at boot: core's
 * (catalog `bootstrap.js`) and the extension's (`bootstrap.ts`).
 *
 * Price filters arrive both as GraphQL `filters` and through the page URL.
 * For an approved wholesale customer they are ignored (absent from
 * `currentFilters`, no effect on `total`) and `priceRange` is null; B2C and
 * anonymous viewers keep the core behaviour.
 *
 * Product collections are read through core's module-level pool (real
 * catalog data, read-only); customers live in the rolled-back fixture
 * transaction. `Query.category` and `Query.collection` are stubbed to hand a
 * parent to the wrapped `Category` / `Collection` fields.
 */
import path from 'path';
import type { GraphQLSchema } from 'graphql';
import {
  buildStorefrontSchema,
  describeDb,
  openFixtures,
  run,
  type Fixtures
} from './storefrontSchema.js';

const CORE_DIST = path.resolve(process.cwd(), 'packages/evershop/dist');
const EXTENSION_DIST = path.resolve(process.cwd(), 'extensions/wholesale/dist');

const PRICE_KEYS = ['min_price', 'max_price', 'ob'];

const PRICE_FILTERS = [
  { key: 'min_price', operation: 'eq', value: '999999999' },
  { key: 'max_price', operation: 'eq', value: '1000000000' },
  { key: 'ob', operation: 'eq', value: 'price' }
];

const URL_QUERY = '?min_price=999999999&max_price=1000000000&ob=price';

type Filter = { key: string; value: string };
type Collection = { total: number; currentFilters: Filter[] };

const COLLECTION = '{ total currentFilters { key value } }';

const QUERY = `
  query ($filters: [FilterInput]) {
    products(filters: $filters) ${COLLECTION}
    all: products(filters: []) ${COLLECTION}
    productSearch { products ${COLLECTION} }
    productListing { priceRange { min max } products ${COLLECTION} }
    category(id: 1) { priceRange { min max } products(filters: $filters) ${COLLECTION} }
    collection(code: "wholesale-test") { products(filters: $filters) ${COLLECTION} }
  }
`;

type Result = {
  products: Collection;
  all: Collection;
  productSearch: { products: Collection };
  productListing: { priceRange: { min: number; max: number } | null; products: Collection };
  category: { priceRange: { min: number; max: number } | null; products: Collection };
  collection: { products: Collection };
};

const keysOf = (collection: Collection): string[] =>
  collection.currentFilters.map((f) => f.key).filter((k) => PRICE_KEYS.includes(k));

describeDb('storefront product collections without price filters (ADR-06 item 5)', () => {
  let fixtures: Fixtures;
  let schema: GraphQLSchema;
  let approvedCustomer: Record<string, unknown>;
  let b2cCustomer: Record<string, unknown>;
  let corePool: { end(): Promise<void> };

  /** Each route-gated field reads its own route; run them one by one. */
  async function query(context: Record<string, unknown>): Promise<Result> {
    const base = { pool: fixtures.client, ...context };
    const variables = { filters: PRICE_FILTERS };
    const [plain, search, listing] = await Promise.all([
      run<Result>(schema, QUERY, base, variables),
      run<Result>(
        schema,
        QUERY,
        {
          ...base,
          currentRoute: { id: 'catalogSearch' },
          currentUrl: `http://localhost/search${URL_QUERY}&keyword=wholesale`
        },
        variables
      ),
      run<Result>(
        schema,
        QUERY,
        {
          ...base,
          currentRoute: { id: 'productListing' },
          currentUrl: `http://localhost/products${URL_QUERY}`
        },
        variables
      )
    ]);
    return { ...plain, productSearch: search.productSearch, productListing: listing.productListing };
  }

  beforeAll(async () => {
    // Register the processors exactly as the core catalog bootstrap does,
    // then run the extension bootstrap.
    const { addProcessor } = (await import(path.join(CORE_DIST, 'lib/util/registry.js'))) as {
      addProcessor: (name: string, fn: unknown, priority: number) => void;
    };
    const registerDefaults = (
      (await import(
        path.join(CORE_DIST, 'modules/catalog/services/registerDefaultProductCollectionFilters.js')
      )) as { default: unknown }
    ).default;
    const { defaultPaginationFilters } = (await import(
      path.join(CORE_DIST, 'lib/util/defaultPaginationFilters.js')
    )) as { defaultPaginationFilters: unknown[] };
    addProcessor('productCollectionFilters', registerDefaults, 1);
    addProcessor(
      'productCollectionFilters',
      (filters: unknown[]) => [...filters, ...defaultPaginationFilters],
      2
    );
    const bootstrap = (
      (await import(path.join(EXTENSION_DIST, 'bootstrap.js'))) as { default: () => void }
    ).default;
    bootstrap();

    corePool = (
      (await import(path.join(CORE_DIST, 'lib/postgres/connection.js'))) as {
        pool: { end(): Promise<void> };
      }
    ).pool;

    schema = await buildStorefrontSchema((resolvers) => {
      resolvers.Query.category = () => ({ categoryId: 1, uuid: 'wholesale-test' });
      resolvers.Query.collection = () => ({ collectionId: 0, code: 'wholesale-test' });
    });
    fixtures = await openFixtures();
    approvedCustomer = await fixtures.insertCustomer(true);
    b2cCustomer = await fixtures.insertCustomer(false);
  });

  afterAll(async () => {
    await fixtures?.close();
    await corePool?.end();
  });

  it('ignores price filters and price sorting for an approved wholesale customer', async () => {
    const result = await query({ customer: approvedCustomer });
    expect(keysOf(result.products)).toEqual([]);
    expect(keysOf(result.productSearch.products)).toEqual([]);
    expect(keysOf(result.productListing.products)).toEqual([]);
    expect(keysOf(result.category.products)).toEqual([]);
    expect(keysOf(result.collection.products)).toEqual([]);
    // The price range did not narrow the catalog.
    expect(result.products.total).toBe(result.all.total);
  });

  it('does not offer the price range to an approved wholesale customer', async () => {
    const result = await query({ customer: approvedCustomer });
    expect(result.productListing.priceRange).toBeNull();
    expect(result.category.priceRange).toBeNull();
  });

  it.each([
    ['a B2C customer', () => ({ customer: b2cCustomer })],
    ['an anonymous visitor', () => ({})]
  ])('keeps the core price filters for %s', async (_label, context) => {
    const result = await query(context());
    expect(keysOf(result.products).sort()).toEqual([...PRICE_KEYS].sort());
    expect(keysOf(result.productSearch.products).sort()).toEqual([...PRICE_KEYS].sort());
    expect(keysOf(result.productListing.products).sort()).toEqual([...PRICE_KEYS].sort());
    expect(keysOf(result.category.products).sort()).toEqual([...PRICE_KEYS].sort());
    expect(keysOf(result.collection.products).sort()).toEqual([...PRICE_KEYS].sort());
    expect(result.productListing.priceRange).not.toBeNull();
    expect(result.category.priceRange).not.toBeNull();
  });
});
