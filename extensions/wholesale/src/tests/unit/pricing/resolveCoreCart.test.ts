/**
 * Parity test for the core cart resolver replicas (ADR-06 item 6, T-2.10d).
 *
 * Imports the compiled core `Cart.resolvers.js` and checks that, for
 * non-wholesale viewers, the extension resolves cart amounts exactly as core
 * does. When this fails after a core upgrade, update
 * `services/pricing/resolveCoreCart.ts`.
 */
import path from 'path';
import cartResolvers from '../../../graphql/types/Cart/Cart.resolvers.js';
import { MASKED_AMOUNT } from '../../../services/pricing/maskedAmount.js';
import {
  CART_ITEM_PRICE_FIELDS,
  CART_PRICE_FIELDS,
  resolveCoreShippingMethodData
} from '../../../services/pricing/resolveCoreCart.js';

const CORE_CART_RESOLVERS = path.resolve(
  process.cwd(),
  'packages/evershop/dist/modules/checkout/graphql/types/Cart/Cart.resolvers.js'
);

type Fn = (parent: unknown, args?: unknown, context?: unknown) => unknown;
type CoreCartResolvers = { Cart: Record<string, Fn>; CartItem: Record<string, Fn> };

const ANONYMOUS = {}; // no customer: no DB access needed

const SHIPPING_DATA = [
  null,
  undefined,
  {
    provider_code: 'core',
    method_code: 'flat',
    snapshot: { code: 'flat', name: 'Flat', cost: '7.25' },
    fingerprint: 'f',
    quotedAt: '2026-10-12T00:00:00.000Z'
  },
  { provider_code: 'x', method_code: 'y', snapshot: null }
];

describe('cart resolver replicas match core', () => {
  let core: CoreCartResolvers;
  const ext = cartResolvers as unknown as CoreCartResolvers;

  beforeAll(async () => {
    core = ((await import(CORE_CART_RESOLVERS)) as { default: CoreCartResolvers }).default;
  });

  it('core resolves every replicated Cart price field by property', () => {
    for (const field of CART_PRICE_FIELDS) {
      expect(core.Cart[field]).toBeUndefined();
    }
  });

  it('core resolves CartItem prices by property except the subTotal/total aliases', () => {
    const item: Record<string, string> = {};
    Object.values(CART_ITEM_PRICE_FIELDS).forEach((key, i) => {
      item[key] = `${i}.5`;
    });
    for (const [field, key] of Object.entries(CART_ITEM_PRICE_FIELDS)) {
      const coreValue = core.CartItem[field] ? core.CartItem[field](item) : item[field];
      expect({ field, value: coreValue }).toEqual({ field, value: item[key] });
    }
  });

  it.each(SHIPPING_DATA)('Cart.shippingMethodData matches core for %p', async (data) => {
    const cart = { shippingMethodData: data };
    expect(resolveCoreShippingMethodData(cart)).toEqual(core.Cart.shippingMethodData(cart));
    expect(await ext.Cart.shippingMethodData(cart, {}, ANONYMOUS)).toEqual(
      core.Cart.shippingMethodData(cart)
    );
  });

  it('serves the core values to a non-wholesale viewer', async () => {
    const cart: Record<string, unknown> = {};
    CART_PRICE_FIELDS.forEach((field, i) => {
      cart[field] = `${i}.25`;
    });
    for (const field of CART_PRICE_FIELDS) {
      expect(await ext.Cart[field](cart, {}, ANONYMOUS)).toBe(cart[field]);
    }
    expect(await ext.Cart.isMasked(cart, {}, ANONYMOUS)).toBe(false);
  });

  it('never returns the masked sentinel to a non-wholesale viewer', async () => {
    const item = { lineTotal: '3', lineTotalInclTax: '4' };
    expect(await ext.CartItem.total(item, {}, ANONYMOUS)).toBe('4');
    expect(await ext.CartItem.subTotal(item, {}, ANONYMOUS)).toBe('3');
    expect(await ext.CartItem.total(item, {}, ANONYMOUS)).not.toBe(MASKED_AMOUNT);
  });
});
