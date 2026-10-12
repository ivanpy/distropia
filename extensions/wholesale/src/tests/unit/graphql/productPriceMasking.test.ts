/**
 * Integration test for ADR-06 (price masking) — T-2.10.
 *
 * Builds the storefront GraphQL schema in-process exactly as core does
 * (`buildTypeDefs(false)` + `buildResolvers(false)` from the compiled core,
 * which also load this extension's compiled `dist/graphql/types/**`), then
 * runs a `product { price { ... } }` query with a request-like context.
 *
 * Proves that the extension resolver wins the resolver merge: an approved
 * wholesale customer gets masked prices, a B2C customer and an anonymous
 * visitor get the real price.
 *
 * All fixtures live inside one transaction that is rolled back at the end;
 * the transaction client is handed to the resolvers as `context.pool`, the
 * same key core sets per request. The suite is skipped when no database is
 * configured.
 */
import { randomUUID } from 'crypto';
import type { GraphQLSchema } from 'graphql';
import {
  buildStorefrontSchema,
  describeDb,
  openFixtures,
  run,
  type Fixtures
} from './storefrontSchema.js';

const PRICE_QUERY = `
  query ($id: ID) {
    product(id: $id) {
      price {
        regular { value currency text }
        special { value currency text }
        isMasked
      }
    }
  }
`;

type PriceField = { value: number; currency: string; text: string };
type PriceResult = {
  product: {
    price: { regular: PriceField; special: PriceField; isMasked: boolean };
  } | null;
};

describeDb('storefront GraphQL price masking (ADR-06)', () => {
  let fixtures: Fixtures;
  let schema: GraphQLSchema;
  let productId: number;
  let approvedCustomer: Record<string, unknown>;
  let b2cCustomer: Record<string, unknown>;

  function queryPrice(context: Record<string, unknown>): Promise<PriceResult> {
    return run<PriceResult>(
      schema,
      PRICE_QUERY,
      { pool: fixtures.client, ...context },
      { id: productId }
    );
  }

  beforeAll(async () => {
    schema = await buildStorefrontSchema();
    fixtures = await openFixtures();
    const { client } = fixtures;

    const product = await client.query(
      `INSERT INTO "product" ("sku", "price", "status")
       VALUES ($1, 12.5, true) RETURNING "product_id"`,
      [`WHOLESALE-TEST-${randomUUID()}`]
    );
    productId = product.rows[0].product_id as number;
    // Query.product inner-joins product_inventory.
    await client.query(
      `INSERT INTO "product_inventory" ("product_inventory_product_id", "qty")
       VALUES ($1, 100)`,
      [productId]
    );
    approvedCustomer = await fixtures.insertCustomer(true);
    b2cCustomer = await fixtures.insertCustomer(false);
  });

  afterAll(async () => {
    await fixtures?.close();
  });

  it('masks prices for an approved wholesale customer', async () => {
    const { product } = await queryPrice({ customer: approvedCustomer });
    expect(product?.price.isMasked).toBe(true);
    expect(product?.price.regular.value).toBe(0);
    expect(product?.price.special.value).toBe(0);
    expect(product?.price.regular.text).toBe('Subject to quote');
    expect(product?.price.special.text).toBe('Subject to quote');
    expect(typeof product?.price.regular.currency).toBe('string');
  });

  it('returns the real price for a B2C customer', async () => {
    const { product } = await queryPrice({ customer: b2cCustomer });
    expect(product?.price.isMasked).toBe(false);
    expect(product?.price.regular.value).toBe(12.5);
    expect(product?.price.special.value).toBe(12.5);
    expect(product?.price.regular.text).not.toBe('Subject to quote');
    expect(product?.price.regular.text).toMatch(/12[.,]50/);
  });

  it('returns the real price for an anonymous visitor', async () => {
    const { product } = await queryPrice({});
    expect(product?.price.isMasked).toBe(false);
    expect(product?.price.regular.value).toBe(12.5);
  });

  it('decides from the database, not from the context customer row', async () => {
    // A stale/forged flag on the context row must not change the outcome.
    const b2c = await queryPrice({
      customer: { ...b2cCustomer, is_wholesale_approved: true }
    });
    expect(b2c.product?.price.isMasked).toBe(false);
    const approved = await queryPrice({
      customer: { ...approvedCustomer, is_wholesale_approved: false }
    });
    expect(approved.product?.price.isMasked).toBe(true);
    expect(approved.product?.price.regular.value).toBe(0);
  });
});
