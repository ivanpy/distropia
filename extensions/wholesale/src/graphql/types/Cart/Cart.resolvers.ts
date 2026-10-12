/**
 * ADR-06 item 6: hide cart amounts from approved wholesale customers.
 *
 * The B2B bag reuses the native cart (ADR-01), so every `Price` reachable
 * from storefront `Cart` is overridden: cart totals, item prices and line
 * totals, the selected shipping method cost and the available shipping
 * method costs. Approved wholesale viewers get `MASKED_AMOUNT` (value 0,
 * "Subject to quote" text via `Price.resolvers.ts`); everybody else gets the
 * core value (`resolveCoreCart.ts`). `Cart.crossSellProducts` returns
 * `Product`, already masked by `Product.resolvers.ts`.
 */
import {
  isWholesaleViewer,
  type ViewerContext
} from '../../../services/pricing/isWholesaleViewer.js';
import { MASKED_AMOUNT } from '../../../services/pricing/maskedAmount.js';
import {
  CART_ITEM_PRICE_FIELDS,
  CART_PRICE_FIELDS,
  resolveCoreShippingMethodData,
  type ShippingMethodData
} from '../../../services/pricing/resolveCoreCart.js';

type Parent = Record<string, unknown>;
type Resolver = (parent: Parent, args: unknown, context: ViewerContext) => Promise<unknown>;

/** A field resolver returning `MASKED_AMOUNT` to wholesale viewers, else `parent[key]`. */
function maskedProperty(key: string): Resolver {
  return async (parent, _args, context) =>
    (await isWholesaleViewer(context)) ? MASKED_AMOUNT : parent[key];
}

const isMasked = (_parent: unknown, _args: unknown, context: ViewerContext): Promise<boolean> =>
  isWholesaleViewer(context);

export default {
  Cart: {
    ...Object.fromEntries(CART_PRICE_FIELDS.map((field) => [field, maskedProperty(field)])),
    isMasked,
    shippingMethodData: async (
      cart: { shippingMethodData?: Record<string, unknown> | null },
      _args: unknown,
      context: ViewerContext
    ): Promise<ShippingMethodData | null> => {
      const data = resolveCoreShippingMethodData(cart);
      if (!data?.snapshot || !(await isWholesaleViewer(context))) {
        return data;
      }
      return { ...data, snapshot: { ...data.snapshot, cost: MASKED_AMOUNT } };
    }
  },
  CartItem: {
    ...Object.fromEntries(
      Object.entries(CART_ITEM_PRICE_FIELDS).map(([field, key]) => [field, maskedProperty(key)])
    ),
    isMasked
  },
  // Storefront-only type, reachable through `Cart.availableShippingMethods`.
  AvailableShippingMethod: {
    cost: maskedProperty('cost')
  }
};
