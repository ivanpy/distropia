/**
 * T-2.43 (`03_endpoints_y_contratos.md` §9): admin GraphQL
 * `WholesaleProductLine` + `Query.wholesaleProductLines(includeInactive)`.
 *
 * The admin schema returns lines with their tiers ordered by `fromQty`; the
 * storefront schema exposes neither the query nor the types (line tiers
 * would reveal the price structure to a scraper, §9 storefront note).
 *
 * Both schemas are built in-process as core builds them; fixtures live in a
 * rolled-back transaction handed to resolvers as `context.pool`.
 */
import { randomUUID } from 'crypto';
import type { GraphQLSchema } from 'graphql';
import migrate110 from '../../../migration/Version-1.1.0.js';
import {
  createProductLine,
  replaceProductLineTiers,
  updateProductLine
} from '../../../services/line/productLines.js';
import {
  buildAdminSchema,
  buildStorefrontSchema,
  describeDb,
  openFixtures,
  run,
  type Fixtures
} from './storefrontSchema.js';

const LINES_QUERY = `
  query ($includeInactive: Boolean) {
    wholesaleProductLines(includeInactive: $includeInactive) {
      uuid
      name
      isActive
      countsTowardMix
      tiers { fromQty discountPercent label }
    }
  }
`;

type LinesResult = {
  wholesaleProductLines: Array<{
    uuid: string;
    name: string;
    isActive: boolean;
    countsTowardMix: boolean;
    tiers: Array<{ fromQty: number; discountPercent: number; label: string | null }>;
  }>;
};

describeDb('admin GraphQL wholesaleProductLines (T-2.43)', () => {
  let fixtures: Fixtures;
  let adminSchema: GraphQLSchema;
  let storefrontSchema: GraphQLSchema;
  const prefix = `GraphQL line ${randomUUID()}`;
  let active: { uuid: string };
  let inactive: { uuid: string };

  beforeAll(async () => {
    // Build the (slow) schemas before opening the fixture transaction: its
    // migrations lock `customer`, which suites calling core services through
    // the module pool wait on (R3-test-lock-contention).
    adminSchema = await buildAdminSchema();
    storefrontSchema = await buildStorefrontSchema();
    fixtures = await openFixtures();
    await migrate110(fixtures.client);

    const { client } = fixtures;
    active = await createProductLine(client, { name: `${prefix} Herramientas`, countsTowardMix: true });
    await replaceProductLineTiers(client, active.uuid, [
      { fromQty: 1, discountPercent: 0 },
      { fromQty: 10, discountPercent: 5, label: 'Bronce' },
      { fromQty: 100, discountPercent: 12.5, label: 'Oro' }
    ]);
    inactive = await createProductLine(client, { name: `${prefix} Discontinued` });
    await updateProductLine(client, inactive.uuid, { isActive: false });
  }, 60000);

  afterAll(async () => {
    await fixtures?.close();
  });

  const mine = (result: LinesResult) => result.wholesaleProductLines.filter((l) => l.name.startsWith(prefix));

  it('returns active lines with their tiers ordered by fromQty, never the serial id', async () => {
    // Move the first stored row to the end (bypassing the validator): the
    // query must order by fromQty, not by storage or insertion order.
    await fixtures.client.query(
      `UPDATE "wholesale_product_line_tier" t SET "from_qty" = 1000
         FROM "wholesale_product_line" l
        WHERE l."wholesale_product_line_id" = t."wholesale_product_line_id" AND l."uuid" = $1 AND t."from_qty" = 1`,
      [active.uuid]
    );
    const result = await run<LinesResult>(adminSchema, LINES_QUERY, { pool: fixtures.client });
    expect(mine(result)).toEqual([
      {
        uuid: active.uuid,
        name: `${prefix} Herramientas`,
        isActive: true,
        countsTowardMix: true,
        tiers: [
          { fromQty: 10, discountPercent: 5, label: 'Bronce' },
          { fromQty: 100, discountPercent: 12.5, label: 'Oro' },
          { fromQty: 1000, discountPercent: 0, label: null }
        ]
      }
    ]);
    expect(adminSchema.getType('WholesaleProductLine')?.toString()).toBe('WholesaleProductLine');
    const fields = Object.keys((adminSchema.getType('WholesaleProductLine') as unknown as { getFields(): object }).getFields());
    expect(fields.sort()).toEqual(['countsTowardMix', 'isActive', 'name', 'tiers', 'uuid']);
  });

  it('includes inactive lines only when includeInactive is true', async () => {
    const withInactive = await run<LinesResult>(adminSchema, LINES_QUERY, { pool: fixtures.client }, { includeInactive: true });
    expect(mine(withInactive).map((l) => [l.uuid, l.isActive])).toEqual([
      [inactive.uuid, false],
      [active.uuid, true]
    ]);
    const without = await run<LinesResult>(adminSchema, LINES_QUERY, { pool: fixtures.client }, { includeInactive: false });
    expect(mine(without).map((l) => l.uuid)).toEqual([active.uuid]);
  });

  it('fails closed without a database pool in the context', async () => {
    await expect(run<LinesResult>(adminSchema, LINES_QUERY, {})).rejects.toThrow(/pool/);
  });

  it('is not part of the storefront schema', async () => {
    expect(storefrontSchema.getQueryType()?.getFields().wholesaleProductLines).toBeUndefined();
    expect(storefrontSchema.getType('WholesaleProductLine')).toBeUndefined();
    expect(storefrontSchema.getType('WholesaleTier')).toBeUndefined();
    await expect(run(storefrontSchema, LINES_QUERY, { pool: fixtures.client })).rejects.toThrow(
      /Cannot query field "wholesaleProductLines"/
    );
  });
});
