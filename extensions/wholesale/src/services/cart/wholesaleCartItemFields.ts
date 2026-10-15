/**
 * Wholesale rules on core cart items (T-2.15, RF-03, RF-10).
 *
 * `createWholesaleCartItemFields` is a `cartItemFields` processor that adds
 * one resolver to the core `qty` field: when the cart belongs to an approved
 * wholesale customer (re-read from the database, `=== true`), a product that
 * is not quotable or a quantity off its rule's grid sets an item error. Core
 * turns item errors into a refusal when an item is created or merged
 * (`Cart.createItem`, `addCartItem`); `rejectInvalidWholesaleQuantity`
 * (after-hook of `updateCartItemQty`) refuses a quantity update the same way.
 * Carts of B2C customers and anonymous carts are untouched.
 *
 * Decided by the cart owner (`cart.customer_id`): item resolvers run without
 * the request, and core links a logged-in customer to the cart.
 *
 * The resolver returns the quantity unchanged (core checks that a resolved
 * field equals the requested value) and adds no item key, so the REST and
 * GraphQL item masking (W2/W2b) is unaffected. Error messages carry
 * quantities only, never amounts.
 */
import { pool } from '@evershop/evershop/lib/postgres';
import { loadQuoteProducts } from '../rule/isQuotable.js';
import type { Queryable } from '../rule/ruleRow.js';
import { type QuantityCheck, validateQuantity } from '../rule/validateQuantity.js';

/** Key of the wholesale item error (distinct from core's `qty` stock error). */
export const WHOLESALE_ITEM_ERROR = 'wholesale_item';

export const NOT_QUOTABLE_MESSAGE = 'This product is not available for wholesale quotes';

/** The subset of the core `Cart` (`modules/checkout/services/cart/Cart.js`) read here. */
interface CartLike {
  getData(key: string): unknown;
  getItem?(uuid: string): ItemLike | undefined;
}

/** The subset of the core cart `Item` a field resolver is called on. */
interface ItemLike {
  getCart(): CartLike;
  getProduct(): Promise<{ product_id?: unknown } | null | undefined>;
  setError(key: string, message?: string): void;
  getErrors(): Record<string, string>;
}

interface CartItemField {
  key: string;
  resolvers: Array<(this: ItemLike, value: unknown) => unknown>;
  dependencies?: string[];
}

/** Message of a refused quantity: quantities only. */
export function invalidQuantityMessage(qty: unknown, check: Exclude<QuantityCheck, { valid: true }>): string {
  const range =
    check.maxQty === null
      ? `order at least ${check.minQty} units`
      : `order from ${check.minQty} to ${check.maxQty} units`;
  const nearest = [check.lower, check.upper].filter((n): n is number => n !== null);
  const hint = nearest.length > 0 ? ` (nearest: ${nearest.join(' or ')})` : '';
  return `Quantity ${String(qty)} is not allowed for wholesale: ${range} in steps of ${check.stepQty}${hint}`;
}

function ownerOf(cart: CartLike): number | null {
  let customerId: unknown;
  try {
    customerId = cart.getData('customer_id');
  } catch {
    // Core registers `customer_id` on every cart; without it there is no owner.
    return null;
  }
  const id = Number(customerId);
  return Number.isInteger(id) && id > 0 ? id : null;
}

/**
 * The processor. `getDb` is injectable so tests read the rolled-back fixture
 * transaction; the default is the core pool.
 */
export function createWholesaleCartItemFields(getDb: () => Queryable = () => pool) {
  // One approval lookup per cart object and owner (core builds every item of a cart in parallel).
  const approvals = new WeakMap<object, Map<number, Promise<boolean>>>();

  function isApprovedOwner(cart: CartLike, customerId: number): Promise<boolean> {
    let byCustomer = approvals.get(cart);
    if (!byCustomer) {
      byCustomer = new Map();
      approvals.set(cart, byCustomer);
    }
    let pending = byCustomer.get(customerId);
    if (!pending) {
      pending = getDb()
        .query(`SELECT "is_wholesale_approved" FROM "customer" WHERE "customer_id" = $1 AND "status" = 1`, [customerId])
        .then(({ rows }) => rows[0]?.is_wholesale_approved === true);
      byCustomer.set(customerId, pending);
    }
    return pending;
  }

  async function wholesaleQuantity(this: ItemLike, qty: unknown): Promise<unknown> {
    const cart = this.getCart();
    const customerId = ownerOf(cart);
    if (customerId === null || !(await isApprovedOwner(cart, customerId))) {
      return qty;
    }
    const productId = Number((await this.getProduct())?.product_id);
    const product = Number.isInteger(productId) ? (await loadQuoteProducts(getDb(), [productId])).get(productId) : undefined;
    if (!product?.quotable || !product.rule) {
      this.setError(WHOLESALE_ITEM_ERROR, NOT_QUOTABLE_MESSAGE);
      return qty;
    }
    const check = validateQuantity(qty as number, product.rule);
    if (!check.valid) {
      this.setError(WHOLESALE_ITEM_ERROR, invalidQuantityMessage(qty, check));
    }
    return qty;
  }

  return function registerWholesaleCartItemFields(fields: CartItemField[]): CartItemField[] {
    return fields.concat([{ key: 'qty', resolvers: [wholesaleQuantity], dependencies: [] }]);
  };
}

/**
 * After-hook of core `updateCartItemQty(cart, uuid, qty, action, context)`:
 * core saves an item with errors on a quantity update, so a wholesale error
 * on the updated item is turned into a refusal (the route answers an error
 * and does not save the cart). A removed item (decrease to 0) is ignored.
 */
export function rejectInvalidWholesaleQuantity(_result: unknown, cart: CartLike, uuid: string): void {
  const item = cart.getItem?.(uuid);
  const message = item?.getErrors()[WHOLESALE_ITEM_ERROR];
  if (message) {
    throw new Error(message);
  }
}
