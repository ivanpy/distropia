/**
 * T-2.48: storefront `Cart.wholesaleWarnings` (codes only).
 *
 * Runs `cart { wholesaleWarnings { code } }` on the merged core + extension
 * storefront schema. Rows live in a scratch database (`quote/scratchDatabase.ts`)
 * handed to the resolvers as `context.pool`. Core builds carts through its
 * module-level pool, so `Query.cart` is stubbed to return the core shape
 * (`cartId`, `uuid`); `Cart.wholesaleWarnings` itself is not stubbed.
 */
import { getNamedType, isObjectType } from 'graphql';
import type { GraphQLSchema } from 'graphql';
import type { Pool } from 'pg';
import { readQuoteSettingsSource } from '../../../services/quote/quoteInput.js';
import {
  type CustomerFixture,
  insertCart,
  insertCustomer,
  insertLine,
  insertProduct,
  type ProductFixture
} from '../quote/quoteFixtures.js';
import { openScratchDatabase, type ScratchDatabase } from '../quote/scratchDatabase.js';
import { buildStorefrontSchema, describeDb, run } from './storefrontSchema.js';

const QUERY = `query Warnings($id: String!) { cart(id: $id) { uuid wholesaleWarnings { code } } }`;

describeDb('Cart.wholesaleWarnings (T-2.48)', () => {
  let scratch: ScratchDatabase;
  let pool: Pool;
  let schema: GraphQLSchema;
  const carts = new Map<string, { cartId: number; uuid: string }>();
  /** 100.000 base, tiers 1 → 0 %, 12 → 10 %; counts toward the mix. */
  let product: ProductFixture;
  /** Critical consumable on a line that does not count toward the mix. */
  let consumable: ProductFixture;
  let approved: CustomerFixture;
  let retail: CustomerFixture;
  /** Quantity of `product` that reaches the configured minimum on its own. */
  let enough: number;

  async function warnings(customerId: number | null, items: { product: ProductFixture; qty: number }[]) {
    const cart = await insertCart(pool, customerId, items);
    carts.set(cart.uuid, cart);
    const data = await run<{ cart: { uuid: string; wholesaleWarnings: { code: string }[] } }>(
      schema,
      QUERY,
      { pool, customer: customerId === null ? null : { customer_id: customerId } },
      { id: cart.uuid }
    );
    expect(data.cart.uuid).toBe(cart.uuid);
    return data.cart.wholesaleWarnings.map((w) => w.code);
  }

  beforeAll(async () => {
    scratch = await openScratchDatabase(4);
    pool = scratch.pool;
    schema = await buildStorefrontSchema((resolvers) => {
      resolvers.Query.cart = (_root: unknown, { id }: { id: string }) => {
        const cart = carts.get(id);
        return cart ? { cartId: cart.cartId, uuid: cart.uuid } : null;
      };
    });
    const line = await insertLine(pool, [
      { fromQty: 1, discountPercent: 0 },
      { fromQty: 12, discountPercent: 10, label: 'Bronce' }
    ]);
    const consumables = await insertLine(
      pool,
      [
        { fromQty: 1, discountPercent: 0 },
        { fromQty: 12, discountPercent: 10, label: 'Oro' }
      ],
      { countsTowardMix: false }
    );
    product = await insertProduct(pool, { lineId: line.lineId });
    consumable = await insertProduct(pool, { lineId: consumables.lineId, isCriticalConsumable: true });
    approved = await insertCustomer(pool);
    retail = await insertCustomer(pool, { approved: false });
    enough = Math.max(12, Math.ceil(readQuoteSettingsSource().minimumNetTotal / 90_000));
  }, 60000);

  afterAll(async () => {
    await scratch?.close();
  }, 60000);

  it('is a non-null list of code-only warnings', () => {
    const field = schema.getType('Cart');
    expect(isObjectType(field)).toBe(true);
    const warningsField = (field as import('graphql').GraphQLObjectType).getFields().wholesaleWarnings;
    expect(String(warningsField.type)).toBe('[WholesaleCartWarning!]!');
    const warning = getNamedType(warningsField.type);
    expect(isObjectType(warning) && Object.keys(warning.getFields())).toEqual(['code']);
  });

  it('warns an approved wholesale customer below the minimum with MINIMUM_ORDER_NOT_MET', async () => {
    expect(await warnings(approved.customerId, [{ product, qty: 1 }])).toEqual(['MINIMUM_ORDER_NOT_MET']);
  });

  it('has no warning once the minimum is met', async () => {
    expect(await warnings(approved.customerId, [{ product, qty: enough }])).toEqual([]);
  });

  it('warns MIX_RULE_NOT_MET when the mix rule reprices a critical consumable', async () => {
    expect(await warnings(approved.customerId, [{ product: consumable, qty: enough }])).toEqual(['MIX_RULE_NOT_MET']);
  });

  it('returns an empty list for an empty cart', async () => {
    expect(await warnings(approved.customerId, [])).toEqual([]);
  });

  it('returns an empty list to B2C and anonymous viewers, whatever the cart', async () => {
    expect(await warnings(retail.customerId, [{ product, qty: 1 }])).toEqual([]);
    expect(await warnings(null, [{ product, qty: 1 }])).toEqual([]);
  });
});
