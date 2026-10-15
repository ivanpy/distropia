/**
 * T-2.16 (`03_endpoints_y_contratos.md` §9, CU-01b step 1): admin GraphQL
 * `WholesaleProductRule` (with `productLine` and `isQuotable`, without
 * `tiers`) reachable as `product { wholesaleRule }`.
 *
 * The storefront schema exposes neither the type nor the field: the rule
 * carries the base price.
 */
import { randomUUID } from 'crypto';
import type { GraphQLObjectType, GraphQLSchema } from 'graphql';
import migrate110 from '../../../migration/Version-1.1.0.js';
import { createProductLine, replaceProductLineTiers } from '../../../services/line/productLines.js';
import { saveRule } from '../../../services/rule/saveRule.js';
import { insertProduct, type ProductFixture } from '../rule/ruleFixtures.js';
import { buildAdminSchema, buildStorefrontSchema, describeDb, openFixtures, run, type Fixtures } from './storefrontSchema.js';

const RULE_QUERY = `
  query ($id: ID) {
    product(id: $id) {
      wholesaleRule {
        uuid
        isEnabled
        isQuotable
        productLine { uuid name isActive countsTowardMix tiers { fromQty discountPercent label } }
        basePrice
        vatRate
        isCriticalConsumable
        minQty
        stepQty
        maxQty
        updatedAt
      }
    }
  }
`;

type RuleResult = { product: { wholesaleRule: Record<string, unknown> | null } | null };

describeDb('admin GraphQL product.wholesaleRule (T-2.16)', () => {
  let fixtures: Fixtures;
  let adminSchema: GraphQLSchema;
  let storefrontSchema: GraphQLSchema;
  let withRule: ProductFixture;
  let withoutRule: ProductFixture;
  let lineUuid: string;

  beforeAll(async () => {
    // Schemas first: the fixture transaction locks `customer` (R3-test-lock-contention).
    adminSchema = await buildAdminSchema();
    storefrontSchema = await buildStorefrontSchema();
    fixtures = await openFixtures();
    const { client } = fixtures;
    await migrate110(client);
    const line = await createProductLine(client, { name: `GraphQL rule line ${randomUUID()}`, countsTowardMix: true });
    await replaceProductLineTiers(client, line.uuid, [
      { fromQty: 1, discountPercent: 0 },
      { fromQty: 48, discountPercent: 20, label: 'Distribuidor Oro' }
    ]);
    lineUuid = line.uuid;
    withRule = await insertProduct(client);
    await saveRule(client, withRule.uuid, {
      isEnabled: true,
      productLineUuid: line.uuid,
      basePrice: 15000,
      vatRate: 'exempt',
      isCriticalConsumable: true,
      minQty: 6,
      stepQty: 6,
      maxQty: null
    });
    withoutRule = await insertProduct(client);
  }, 60000);

  afterAll(async () => {
    await fixtures?.close();
  });

  const query = (schema: GraphQLSchema, product: ProductFixture) =>
    run<RuleResult>(schema, RULE_QUERY, { pool: fixtures.client }, { id: product.productId });

  it('returns the rule with its line, tiers and isQuotable', async () => {
    const { product } = await query(adminSchema, withRule);
    expect(product?.wholesaleRule).toEqual({
      uuid: expect.any(String),
      isEnabled: true,
      isQuotable: true,
      productLine: {
        uuid: lineUuid,
        name: expect.any(String),
        isActive: true,
        countsTowardMix: true,
        tiers: [
          { fromQty: 1, discountPercent: 0, label: null },
          { fromQty: 48, discountPercent: 20, label: 'Distribuidor Oro' }
        ]
      },
      basePrice: 15000,
      vatRate: 'exempt',
      isCriticalConsumable: true,
      minQty: 6,
      stepQty: 6,
      maxQty: null,
      updatedAt: expect.any(String)
    });
  });

  it('is null for a product without rule', async () => {
    expect((await query(adminSchema, withoutRule)).product?.wholesaleRule).toBeNull();
  });

  it('matches the contract: no tiers on the rule (they live on the line)', () => {
    const type = adminSchema.getType('WholesaleProductRule') as GraphQLObjectType;
    expect(Object.keys(type.getFields()).sort()).toEqual(
      [
        'basePrice',
        'isCriticalConsumable',
        'isEnabled',
        'isQuotable',
        'maxQty',
        'minQty',
        'productLine',
        'stepQty',
        'updatedAt',
        'uuid',
        'vatRate'
      ].sort()
    );
  });

  it('fails closed without a database pool in the context', async () => {
    const type = adminSchema.getType('Product') as GraphQLObjectType;
    const resolve = type.getFields().wholesaleRule.resolve as (root: unknown, args: unknown, context: unknown) => Promise<unknown>;
    await expect(resolve({ productId: withRule.productId }, {}, {})).rejects.toThrow(/pool/);
  });

  it('is not part of the storefront schema', async () => {
    expect(storefrontSchema.getType('WholesaleProductRule')).toBeUndefined();
    expect((storefrontSchema.getType('Product') as GraphQLObjectType).getFields().wholesaleRule).toBeUndefined();
    await expect(query(storefrontSchema, withRule)).rejects.toThrow(/Cannot query field "wholesaleRule"/);
  });
});
