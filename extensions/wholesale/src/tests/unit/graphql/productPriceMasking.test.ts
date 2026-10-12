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
import 'dotenv/config';
import { randomUUID } from 'crypto';
import fs from 'fs';
import path from 'path';
import { pathToFileURL } from 'url';
import { makeExecutableSchema } from '@graphql-tools/schema';
import type { IResolvers } from '@graphql-tools/utils';
import { graphql } from 'graphql';
import type { GraphQLSchema } from 'graphql';
import pg from 'pg';
import migrate from '../../../migration/Version-1.0.0.js';

const describeDb = process.env.DB_NAME ? describe : describe.skip;

const CORE_GRAPHQL_SERVICES = path.resolve(
  process.cwd(),
  'packages/evershop/dist/modules/graphql/services'
);

type CoreBuilders = {
  buildTypeDefs: (isAdmin?: boolean) => unknown;
  buildResolvers: (isAdmin?: boolean) => Promise<IResolvers>;
};

/** Recursively list storefront resolver files (same filter as core). */
function listResolverFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) {
    return [];
  }
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      return listResolverFiles(full);
    }
    return entry.name.endsWith('.resolvers.js') &&
      !entry.name.endsWith('.admin.resolvers.js')
      ? [full]
      : [];
  });
}

/**
 * Jest's ESM runtime fails to link a module that several concurrent dynamic
 * imports reach at once (core's buildResolvers imports every resolver file
 * in parallel). Importing them sequentially first fills the module registry,
 * so the parallel pass only hits the cache. Test-harness only.
 */
async function prewarmResolverModules(): Promise<void> {
  const modulesDir = path.resolve(CORE_GRAPHQL_SERVICES, '..', '..');
  const files = [
    ...fs
      .readdirSync(modulesDir)
      .flatMap((m) => listResolverFiles(path.join(modulesDir, m, 'graphql', 'types'))),
    ...listResolverFiles(path.resolve(process.cwd(), 'extensions/wholesale/dist/graphql/types'))
  ];
  for (const file of files) {
    await import(pathToFileURL(file).href);
  }
}

/** Load the untyped compiled core schema builders (not part of the public exports). */
async function loadCoreBuilders(): Promise<CoreBuilders> {
  await prewarmResolverModules();
  const types = (await import(
    path.join(CORE_GRAPHQL_SERVICES, 'buildTypes.js')
  )) as Pick<CoreBuilders, 'buildTypeDefs'>;
  const resolvers = (await import(
    path.join(CORE_GRAPHQL_SERVICES, 'buildResolvers.js')
  )) as Pick<CoreBuilders, 'buildResolvers'>;
  return { ...types, ...resolvers };
}

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
  let pool: pg.Pool;
  let client: pg.PoolClient;
  let schema: GraphQLSchema;
  let productId: number;
  let approvedCustomer: Record<string, unknown>;
  let b2cCustomer: Record<string, unknown>;

  async function insertCustomer(approved: boolean): Promise<Record<string, unknown>> {
    const { rows } = await client.query(
      `INSERT INTO "customer" ("email", "password", "full_name", "is_wholesale_approved")
       VALUES ($1, 'x', 'Wholesale Masking Test', $2) RETURNING *`,
      [`wholesale-test-${randomUUID()}@example.com`, approved]
    );
    const customer = rows[0] as Record<string, unknown>;
    delete customer.password;
    return customer;
  }

  async function queryPrice(context: Record<string, unknown>): Promise<PriceResult> {
    const result = await graphql({
      schema,
      source: PRICE_QUERY,
      variableValues: { id: productId },
      contextValue: { pool: client, ...context }
    });
    if (result.errors?.length) {
      throw result.errors[0];
    }
    return result.data as unknown as PriceResult;
  }

  beforeAll(async () => {
    const { buildTypeDefs, buildResolvers } = await loadCoreBuilders();
    schema = makeExecutableSchema({
      typeDefs: buildTypeDefs(false) as string,
      resolvers: await buildResolvers(false)
    });

    pool = new pg.Pool({
      host: process.env.DB_HOST,
      port: Number(process.env.DB_PORT ?? 5432),
      user: process.env.DB_USER,
      password: process.env.DB_PASSWORD,
      database: process.env.DB_NAME,
      max: 1
    });
    client = await pool.connect();
    await client.query('BEGIN');
    // The core query builder releases a PoolClient after each query unless
    // it is flagged as in-transaction; keep the fixture transaction alive.
    (client as pg.PoolClient & { INTRANSACTION?: boolean }).INTRANSACTION = true;
    await migrate(client);

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
    approvedCustomer = await insertCustomer(true);
    b2cCustomer = await insertCustomer(false);
  });

  afterAll(async () => {
    if (client) {
      await client.query('ROLLBACK');
      client.release();
    }
    if (pool) {
      await pool.end();
    }
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
