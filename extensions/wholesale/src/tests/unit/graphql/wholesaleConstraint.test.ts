/**
 * T-2.17 (`03_endpoints_y_contratos.md` §9 storefront, RF-09): storefront
 * GraphQL `Product.wholesaleConstraint { minQty stepQty maxQty }`.
 *
 * Only approved wholesale viewers (re-read from the database) get it, and
 * only for quotable products; it is null for B2C and anonymous sessions. It
 * exposes no tiers and no prices: a schema walk from the field guards that
 * no amount or tier field is reachable, and that no other wholesale type
 * leaks into the storefront schema.
 */
import { randomUUID } from 'crypto';
import {
  type GraphQLField,
  type GraphQLNamedType,
  type GraphQLSchema,
  getNamedType,
  isObjectType,
  isScalarType
} from 'graphql';
import migrate110 from '../../../migration/Version-1.1.0.js';
import { createProductLine } from '../../../services/line/productLines.js';
import { insertProduct, insertRule, lineIdOf, type ProductFixture } from '../rule/ruleFixtures.js';
import { buildStorefrontSchema, describeDb, openFixtures, run, type Fixtures } from './storefrontSchema.js';

const CONSTRAINT_QUERY = `
  query ($id: ID) {
    product(id: $id) {
      wholesaleConstraint { minQty stepQty maxQty }
    }
  }
`;

type ConstraintResult = {
  product: { wholesaleConstraint: { minQty: number; stepQty: number; maxQty: number | null } | null } | null;
};

/** Field names that would reveal prices or the tier structure. */
const FORBIDDEN_FIELD = /price|amount|total|discount|tier|cost|tax|vat|fee|percent|label/i;

/** Every named type reachable from `start`, with every field path visited. */
function walk(start: GraphQLNamedType): { types: Set<string>; fields: string[] } {
  const types = new Set<string>();
  const fields: string[] = [];
  const visit = (type: GraphQLNamedType) => {
    if (types.has(type.name)) return;
    types.add(type.name);
    if (isObjectType(type)) {
      for (const field of Object.values(type.getFields()) as GraphQLField<unknown, unknown>[]) {
        fields.push(`${type.name}.${field.name}`);
        visit(getNamedType(field.type));
      }
    }
  };
  visit(start);
  return { types, fields };
}

describeDb('storefront GraphQL Product.wholesaleConstraint (T-2.17)', () => {
  let fixtures: Fixtures;
  let schema: GraphQLSchema;
  let quotable: ProductFixture;
  let noPrice: ProductFixture;
  let noRule: ProductFixture;
  let approved: Record<string, unknown>;
  let b2c: Record<string, unknown>;

  beforeAll(async () => {
    schema = await buildStorefrontSchema();
    fixtures = await openFixtures();
    const { client } = fixtures;
    await migrate110(client);
    const line = await createProductLine(client, { name: `Constraint line ${randomUUID()}` });
    const lineId = await lineIdOf(client, line.uuid);
    quotable = await insertProduct(client);
    await insertRule(client, quotable.productId, { lineId, basePrice: 15000, minQty: 6, stepQty: 6, maxQty: 60 });
    noPrice = await insertProduct(client);
    await insertRule(client, noPrice.productId, { lineId, basePrice: null, minQty: 6, stepQty: 6 });
    noRule = await insertProduct(client);
    approved = await fixtures.insertCustomer(true);
    b2c = await fixtures.insertCustomer(false);
  }, 60000);

  afterAll(async () => {
    await fixtures?.close();
  });

  const constraintOf = async (product: ProductFixture, customer?: Record<string, unknown>) =>
    (
      await run<ConstraintResult>(
        schema,
        CONSTRAINT_QUERY,
        { pool: fixtures.client, ...(customer ? { customer } : {}) },
        { id: product.productId }
      )
    ).product?.wholesaleConstraint;

  it('gives an approved wholesale viewer the quantity rules of a quotable product', async () => {
    expect(await constraintOf(quotable, approved)).toEqual({ minQty: 6, stepQty: 6, maxQty: 60 });
  });

  it('is null for an approved viewer when the product is not quotable or has no rule', async () => {
    expect(await constraintOf(noPrice, approved)).toBeNull();
    expect(await constraintOf(noRule, approved)).toBeNull();
  });

  it('is null for B2C and anonymous sessions', async () => {
    expect(await constraintOf(quotable, b2c)).toBeNull();
    expect(await constraintOf(quotable)).toBeNull();
  });

  it('decides from the database, not from the context customer row', async () => {
    expect(await constraintOf(quotable, { ...b2c, is_wholesale_approved: true })).toBeNull();
    expect(await constraintOf(quotable, { ...approved, is_wholesale_approved: false })).toEqual({
      minQty: 6,
      stepQty: 6,
      maxQty: 60
    });
  });

  it('reaches no amount or tier field (schema walk)', () => {
    const product = schema.getType('Product');
    if (!isObjectType(product)) throw new Error('Product is not an object type');
    const start = getNamedType(product.getFields().wholesaleConstraint.type);
    const { types, fields } = walk(start);
    expect([...types]).toEqual(['WholesaleProductConstraint', 'Int']);
    expect(fields.sort()).toEqual([
      'WholesaleProductConstraint.maxQty',
      'WholesaleProductConstraint.minQty',
      'WholesaleProductConstraint.stepQty'
    ]);
    expect(fields.filter((f) => FORBIDDEN_FIELD.test(f.split('.')[1]))).toEqual([]);
    expect([...types].filter((t) => t !== 'WholesaleProductConstraint').every((t) => isScalarType(schema.getType(t)))).toBe(
      true
    );
  });

  it('leaks no other wholesale type into the storefront schema', () => {
    const wholesaleTypes = Object.keys(schema.getTypeMap()).filter((name) => /^Wholesale/.test(name));
    expect(wholesaleTypes).toEqual(['WholesaleProductConstraint']);
    const product = schema.getType('Product');
    if (!isObjectType(product)) throw new Error('Product is not an object type');
    expect(Object.keys(product.getFields()).filter((name) => /wholesale/i.test(name))).toEqual(['wholesaleConstraint']);
  });
});
