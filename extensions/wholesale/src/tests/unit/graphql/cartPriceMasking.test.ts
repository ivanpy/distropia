/**
 * Integration test for ADR-06 item 6 (cart price masking) — T-2.10d.
 *
 * Runs storefront `cart { ... }` queries against the merged core + extension
 * schema (see `storefrontSchema.ts`). Every price-bearing field reachable
 * from `Cart` in the storefront schema is selected: cart totals, item prices
 * and line totals, the selected shipping method cost and the available
 * shipping method costs. (`Cart.crossSellProducts` returns `Product`, whose
 * price is covered by `productPriceMasking.test.ts`.)
 *
 * Core builds a cart through the module-level pool, which cannot see the
 * rolled-back fixture transaction, so `Query.cart` and
 * `Cart.availableShippingMethods` are stubbed to return a cart shaped like
 * core's `camelCase(cart.exportData())`. `Cart.items` is stubbed with core's
 * key mapping minus the route URLs (`buildUrl` needs the route table). None
 * of them is overridden by the extension; every field under test runs the
 * merged resolvers.
 */
import { getNamedType, isInterfaceType, isObjectType } from 'graphql';
import type { GraphQLInterfaceType, GraphQLObjectType, GraphQLSchema } from 'graphql';
import {
  buildStorefrontSchema,
  describeDb,
  openFixtures,
  run,
  type Fixtures
} from './storefrontSchema.js';

/** Every `Price!` field of `Cart` in the storefront schema. */
const CART_PRICE_FIELDS = [
  'shippingFeeExclTax',
  'shippingFeeInclTax',
  'shippingTaxAmount',
  'discountAmount',
  'subTotal',
  'subTotalInclTax',
  'subTotalWithDiscount',
  'subTotalWithDiscountInclTax',
  'taxAmount',
  'taxAmountBeforeDiscount',
  'totalTaxAmount',
  'grandTotal'
] as const;

/** Every `Price!` field of `CartItem` in the storefront schema. */
const ITEM_PRICE_FIELDS = [
  'productPrice',
  'productPriceInclTax',
  'finalPrice',
  'finalPriceInclTax',
  'taxAmount',
  'taxAmountBeforeDiscount',
  'discountAmount',
  'lineTotal',
  'subTotal',
  'lineTotalWithDiscount',
  'lineTotalWithDiscountInclTax',
  'lineTotalInclTax',
  'total'
] as const;

const PRICE = '{ value currency text }';

const CART_QUERY = `
  query {
    cart(id: "fixture") {
      uuid
      isMasked
      ${CART_PRICE_FIELDS.map((f) => `${f} ${PRICE}`).join('\n')}
      shippingMethodData { providerCode methodCode snapshot { code name cost ${PRICE} } }
      availableShippingMethods { code cost ${PRICE} }
      items {
        uuid
        isMasked
        qty
        ${ITEM_PRICE_FIELDS.map((f) => `${f} ${PRICE}`).join('\n')}
      }
    }
  }
`;

/** Distinct raw amounts (core keeps them as numeric strings) per field. */
function cartFixture(): Record<string, unknown> {
  const cart: Record<string, unknown> = {
    cartId: 1,
    uuid: 'fixture-cart',
    currency: 'USD',
    status: true,
    shippingMethodData: {
      provider_code: 'core',
      method_code: 'flat',
      snapshot: { code: 'flat', name: 'Flat rate', cost: '7.2500' },
      fingerprint: 'abc',
      quotedAt: '2026-10-12T00:00:00.000Z'
    },
    items: [
      Object.fromEntries([
        ['cart_item_id', 1],
        ['uuid', 'fixture-item'],
        ['cart_id', 1],
        ['qty', 3],
        ...ITEM_PRICE_FIELDS.filter((f) => f !== 'subTotal' && f !== 'total').map(
          (f, i) => [snake(f), `${10 + i}.5000`]
        )
      ])
    ]
  };
  CART_PRICE_FIELDS.forEach((f, i) => {
    cart[f] = `${100 + i}.2500`;
  });
  return cart;
}

function snake(field: string): string {
  return field.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
}

function camel(key: string): string {
  return key.replace(/_([a-z0-9])/g, (_m, c: string) => c.toUpperCase());
}

type PriceField = { value: number; currency: string; text: string };
type CartResult = {
  cart: Record<string, unknown> & {
    isMasked: boolean;
    shippingMethodData: { providerCode: string; snapshot: { cost: PriceField } };
    availableShippingMethods: { code: string; cost: PriceField }[];
    items: (Record<string, unknown> & { isMasked: boolean; qty: number })[];
  };
};

/** Every Price object in the result, labelled by its path. */
function collectPrices(cart: CartResult['cart']): [string, PriceField][] {
  const item = cart.items[0];
  return [
    ...CART_PRICE_FIELDS.map((f): [string, PriceField] => [`Cart.${f}`, cart[f] as PriceField]),
    ...ITEM_PRICE_FIELDS.map((f): [string, PriceField] => [`CartItem.${f}`, item[f] as PriceField]),
    ['ShippingMethodSnapshot.cost', cart.shippingMethodData.snapshot.cost],
    ...cart.availableShippingMethods.map((m): [string, PriceField] => [
      `AvailableShippingMethod.cost(${m.code})`,
      m.cost
    ])
  ];
}

describeDb('storefront GraphQL cart price masking (ADR-06 item 6)', () => {
  let fixtures: Fixtures;
  let schema: GraphQLSchema;
  let approvedCustomer: Record<string, unknown>;
  let b2cCustomer: Record<string, unknown>;

  function queryCart(context: Record<string, unknown>): Promise<CartResult> {
    return run<CartResult>(schema, CART_QUERY, { pool: fixtures.client, ...context });
  }

  beforeAll(async () => {
    schema = await buildStorefrontSchema((resolvers) => {
      resolvers.Query.cart = () => cartFixture();
      resolvers.Cart.items = (cart: { items: Record<string, unknown>[] }) =>
        cart.items.map((item) =>
          Object.fromEntries(Object.entries(item).map(([k, v]) => [camel(k), v]))
        );
      resolvers.Cart.availableShippingMethods = () => [
        { id: 'flat', providerCode: 'core', code: 'flat', name: 'Flat rate', cost: 7.25 },
        { id: 'free', providerCode: 'core', code: 'free', name: 'Free', cost: 0 }
      ];
    });
    fixtures = await openFixtures();
    approvedCustomer = await fixtures.insertCustomer(true);
    b2cCustomer = await fixtures.insertCustomer(false);
  });

  afterAll(async () => {
    await fixtures?.close();
  });

  it('selects every Price field reachable from Cart (fails when core adds one)', () => {
    const found: string[] = [];
    const seen = new Set<string>();
    const walk = (type: GraphQLObjectType | GraphQLInterfaceType): void => {
      if (seen.has(type.name)) return;
      seen.add(type.name);
      for (const [name, field] of Object.entries(type.getFields())) {
        const named = getNamedType(field.type);
        if (named.name === 'Price') {
          found.push(`${type.name}.${name}`);
        } else if (
          // Product prices are covered by productPriceMasking.test.ts.
          named.name !== 'Product' &&
          (isObjectType(named) || isInterfaceType(named))
        ) {
          walk(named);
        }
      }
    };
    walk(schema.getType('Cart') as GraphQLObjectType);
    expect(found.sort()).toEqual(
      [
        ...CART_PRICE_FIELDS.map((f) => `Cart.${f}`),
        ...ITEM_PRICE_FIELDS.map((f) => `CartItem.${f}`),
        'ShippingMethodSnapshot.cost',
        'AvailableShippingMethod.cost'
      ].sort()
    );
  });

  it('masks every cart price for an approved wholesale customer', async () => {
    const { cart } = await queryCart({ customer: approvedCustomer });
    expect(cart.isMasked).toBe(true);
    expect(cart.items[0].isMasked).toBe(true);
    for (const [label, price] of collectPrices(cart)) {
      expect({ label, value: price.value, text: price.text }).toEqual({
        label,
        value: 0,
        text: 'Subject to quote'
      });
      expect(typeof price.currency).toBe('string');
    }
    // Non-price data is untouched.
    expect(cart.items[0].qty).toBe(3);
    expect(cart.shippingMethodData.providerCode).toBe('core');
  });

  it.each([
    ['a B2C customer', () => ({ customer: b2cCustomer })],
    ['an anonymous visitor', () => ({})]
  ])('keeps the core cart amounts for %s', async (_label, context) => {
    const { cart } = await queryCart(context());
    const fixture = cartFixture();
    const item = (fixture.items as Record<string, string>[])[0];
    expect(cart.isMasked).toBe(false);
    expect(cart.items[0].isMasked).toBe(false);
    for (const f of CART_PRICE_FIELDS) {
      expect((cart[f] as PriceField).value).toBe(parseFloat(fixture[f] as string));
    }
    // Core CartItem.subTotal/total are aliases of lineTotal/lineTotalInclTax.
    const itemRaw = (f: string): string =>
      item[snake(f === 'subTotal' ? 'lineTotal' : f === 'total' ? 'lineTotalInclTax' : f)];
    for (const f of ITEM_PRICE_FIELDS) {
      expect((cart.items[0][f] as PriceField).value).toBe(parseFloat(itemRaw(f)));
    }
    expect(cart.shippingMethodData.snapshot.cost.value).toBe(7.25);
    expect(cart.availableShippingMethods.map((m) => m.cost.value)).toEqual([7.25, 0]);
    for (const [, price] of collectPrices(cart)) {
      expect(price.text).not.toBe('Subject to quote');
    }
  });
});
