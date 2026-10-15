/**
 * T-2.15 (RF-03, RF-10): `cartItemFields` processor that validates item
 * quantities for approved wholesale customers and refuses non-quotable
 * products. Adding 13 units with min 6 / step 6 fails.
 *
 * End to end through the compiled core cart (`Cart.addItem`,
 * `Cart.updateItemQty`): the test registers in the core registry the core
 * item fields the cart needs plus this extension's processor and
 * `updateCartItemQty` after-hook, with the database lookups on the
 * rolled-back fixture transaction. Carts of B2C customers and anonymous
 * carts are unaffected. The processor adds no item key, so the REST masking
 * (W2b) classification of item keys stays complete, and its errors carry
 * quantities only.
 */
import path from 'path';
import { pathToFileURL } from 'url';
import { hookAfter } from '@evershop/evershop/lib/util/hookable';
import { addProcessor } from '@evershop/evershop/lib/util/registry';
import migrate110 from '../../../migration/Version-1.1.0.js';
import migrate111 from '../../../migration/Version-1.1.1.js';
import {
  createWholesaleCartItemFields,
  rejectInvalidWholesaleQuantity,
  WHOLESALE_ITEM_ERROR
} from '../../../services/cart/wholesaleCartItemFields.js';
import { createProductLine } from '../../../services/line/productLines.js';
import { maskCartItem } from '../../../services/pricing/maskCartRestResponse.js';
import { describeDb, openFixtures, type Fixtures } from '../graphql/storefrontSchema.js';
import { insertProduct, insertRule, lineIdOf, type ProductFixture } from '../rule/ruleFixtures.js';

const CORE_CHECKOUT = path.resolve(process.cwd(), 'packages/evershop/dist/modules/checkout/services/cart');

/** Core item fields the cart flow needs here (no prices: they read settings through the module pool). */
const CORE_ITEM_KEYS = ['cart_item_id', 'uuid', 'product_id', 'product_sku', 'qty'];

interface CoreItem {
  getData(key: string): unknown;
  getErrors(): Record<string, string>;
  export(): Record<string, unknown>;
}

interface CoreCart {
  addItem(productId: number, qty: number, context?: Record<string, unknown>): Promise<CoreItem>;
  updateItemQty(uuid: string, qty: number | string, action: 'increase' | 'decrease', context?: Record<string, unknown>): Promise<CoreItem>;
  getItems(): CoreItem[];
}

type CartConstructor = new (data: Record<string, unknown>) => CoreCart;

type Field = { key: string; resolvers: Array<(value: unknown) => unknown>; dependencies?: string[] };

describe('wholesale cart item fields registration (T-2.15)', () => {
  it('adds a resolver to the core qty field only: no new item key reaches the REST/GraphQL item', () => {
    const fields = createWholesaleCartItemFields(() => {
      throw new Error('no database in this test');
    })([{ key: 'qty', resolvers: [] }]) as Field[];
    expect(fields.map((f) => f.key)).toEqual(['qty', 'qty']);
  });
});

describeDb('wholesale quantity rules on the core cart (T-2.15)', () => {
  let fixtures: Fixtures;
  let Cart: CartConstructor;
  let approvedId: number;
  let b2cId: number;
  let boxesOf6: ProductFixture;
  let notQuotable: ProductFixture;
  let products: Map<number, ProductFixture>;

  beforeAll(async () => {
    fixtures = await openFixtures();
    const { client } = fixtures;
    await migrate110(client);
    await migrate111(client);

    const line = await createProductLine(client, { name: `Cart line ${Date.now()}` });
    const lineId = await lineIdOf(client, line.uuid);
    boxesOf6 = await insertProduct(client);
    await insertRule(client, boxesOf6.productId, { lineId, basePrice: 1000, minQty: 6, stepQty: 6, maxQty: 60 });
    notQuotable = await insertProduct(client);
    await insertRule(client, notQuotable.productId, { lineId, basePrice: null });
    products = new Map([boxesOf6, notQuotable].map((p) => [p.productId, p]));

    approvedId = (await fixtures.insertCustomer(true)).customer_id as number;
    b2cId = (await fixtures.insertCustomer(false)).customer_id as number;

    const { registerCartItemBaseFields } = (await import(
      pathToFileURL(path.join(CORE_CHECKOUT, 'registerCartItemBaseFields.js')).href
    )) as { registerCartItemBaseFields: (fields: Field[]) => Field[] };
    const { sortFields } = (await import(pathToFileURL(path.join(CORE_CHECKOUT, 'sortFields.js')).href)) as {
      sortFields: (fields: Field[]) => Field[];
    };
    const identity = (value: unknown) => value;
    addProcessor('cartFields', (fields: Field[]) =>
      fields.concat([
        { key: 'customer_id', resolvers: [identity] },
        { key: 'items', resolvers: [identity] }
      ])
    );
    addProcessor('cartItemFields', (fields: Field[]) =>
      registerCartItemBaseFields(fields).filter((f) => CORE_ITEM_KEYS.includes(f.key))
    , 0);
    addProcessor('cartItemFields', createWholesaleCartItemFields(() => client));
    addProcessor('cartItemFields', sortFields, 1000);
    addProcessor('cartItemProductLoaderFunction', () => async (id: number) => ({
      product_id: id,
      uuid: products.get(id)?.uuid,
      sku: products.get(id)?.sku,
      status: true,
      manage_stock: false
    }));
    hookAfter('updateCartItemQty', rejectInvalidWholesaleQuantity);

    ({ Cart } = (await import(pathToFileURL(path.join(CORE_CHECKOUT, 'Cart.js')).href)) as { Cart: CartConstructor });
  }, 60000);

  afterAll(async () => {
    await fixtures?.close();
  });

  const cartOf = (customerId: number | null) => new Cart({ customer_id: customerId, items: [] });

  it('refuses adding 13 units with min 6 / step 6 for an approved customer', async () => {
    await expect(cartOf(approvedId).addItem(boxesOf6.productId, 13)).rejects.toThrow(
      'Quantity 13 is not allowed for wholesale: order from 6 to 60 units in steps of 6 (nearest: 12 or 18)'
    );
  });

  it('accepts a quantity on the grid and refuses a duplicate add that leaves it', async () => {
    const cart = cartOf(approvedId);
    await cart.addItem(boxesOf6.productId, 12);
    await cart.addItem(boxesOf6.productId, 6);
    expect(cart.getItems().map((i) => i.getData('qty'))).toEqual([18]);
    // 18 + 7 = 25: the new item (7) is refused before the merge.
    await expect(cart.addItem(boxesOf6.productId, 7)).rejects.toThrow(/Quantity 7 is not allowed/);
    expect(cart.getItems().map((i) => i.getData('qty'))).toEqual([18]);
  });

  it('refuses a quantity update that leaves the grid (RF-10, never rounded)', async () => {
    const cart = cartOf(approvedId);
    const item = await cart.addItem(boxesOf6.productId, 12);
    await expect(cart.updateItemQty(item.getData('uuid') as string, 1, 'increase')).rejects.toThrow(
      /Quantity 13 is not allowed/
    );
    // The route answers the error and never saves this cart object; a fresh load accepts a step down.
    const fresh = cartOf(approvedId);
    const kept = await fresh.addItem(boxesOf6.productId, 12);
    await fresh.updateItemQty(kept.getData('uuid') as string, 6, 'decrease');
    expect(fresh.getItems().map((i) => i.getData('qty'))).toEqual([6]);
  });

  it('refuses a non-quotable product for an approved customer', async () => {
    await expect(cartOf(approvedId).addItem(notQuotable.productId, 6)).rejects.toThrow(
      'This product is not available for wholesale quotes'
    );
  });

  it.each([
    ['a B2C customer', () => b2cId],
    ['an anonymous cart', () => null]
  ])('leaves %s unaffected', async (_case, owner) => {
    const cart = cartOf(owner());
    const item = await cart.addItem(boxesOf6.productId, 13);
    await cart.addItem(notQuotable.productId, 1);
    await cart.updateItemQty(item.getData('uuid') as string, 1, 'increase');
    expect(cart.getItems().map((i) => i.getErrors())).toEqual([{}, {}]);
    expect(cart.getItems().map((i) => i.getData('qty')).sort()).toEqual([1, 14]);
  });

  it('keeps errors amount-free and the REST masking intact on an item that carries one', async () => {
    const cart = cartOf(approvedId);
    const item = await cart.addItem(boxesOf6.productId, 12);
    // A rule change after the item was added (an existing bag reloaded): the item carries the error.
    await fixtures.client.query(`UPDATE "wholesale_product_rule" SET "step_qty" = 5 WHERE "product_id" = $1`, [
      boxesOf6.productId
    ]);
    try {
      await cart.updateItemQty(item.getData('uuid') as string, 6, 'increase').catch(() => undefined);
      const errors = item.getErrors();
      expect(Object.keys(errors)).toEqual([WHOLESALE_ITEM_ERROR]);
      expect(errors[WHOLESALE_ITEM_ERROR]).not.toMatch(/price|amount|discount|tier|\$|Gs/i);
      const masked = maskCartItem({ ...item.export(), final_price: 10, line_total: 120 });
      expect(masked).toMatchObject({ final_price: null, line_total: null, is_masked: true, qty: 18 });
    } finally {
      await fixtures.client.query(`UPDATE "wholesale_product_rule" SET "step_qty" = 6 WHERE "product_id" = $1`, [
        boxesOf6.productId
      ]);
    }
  });

  it('decides from the database: a forged approval flag on the cart is ignored', async () => {
    const cart = new Cart({ customer_id: b2cId, is_wholesale_approved: true, items: [] });
    await expect(cart.addItem(boxesOf6.productId, 13)).resolves.toBeDefined();
  });
});
