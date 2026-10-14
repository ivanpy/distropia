/**
 * ADR-06 / T-2.31 (D-P2-3): hide cart amounts from approved wholesale
 * customers in the core storefront REST cart API.
 *
 * The core cart item handlers (add, update qty, remove, create cart) put
 * `item.export()` into `response.$body` and call `next()`; the core
 * `apiResponse` middleware sends it later. The extension adds one passive
 * middleware per route (`api/<routeId>/[<handler>]maskWholesaleCartAmounts.ts`)
 * that runs in between and rewrites the body for wholesale viewers.
 *
 * Masked representation (REST only): every amount key of an exported item
 * becomes `null` and the item gains `is_masked: true`. `null` cannot be read
 * as a real price (0 would look like a free item to a REST client); GraphQL
 * keeps its own `MASKED_AMOUNT` / `isMasked` representation. B2C and
 * anonymous bodies are not touched at all.
 */
import type { EvershopRequest } from '@evershop/evershop/types/request';
import type { EvershopResponse } from '@evershop/evershop/types/response';
import { isWholesaleViewer, type ViewerContext } from './isWholesaleViewer.js';

/** Core cart REST route id → id of the core handler that sets `response.$body`. */
export const CART_REST_ROUTES = {
  addCartItem: 'addItemToCart',
  addMineCartItem: 'addItemToCart',
  updateCartItemQty: 'updateQty',
  updateMineCartItemQty: 'updateQty',
  removeCartItem: 'removeItem',
  removeMineCartItem: 'removeItem',
  createCart: 'createNewCart'
} as const;

/**
 * The amount keys of core `item.export()` (registered by the checkout and
 * promotion `cartItemFields` processors). The drift guard in
 * `tests/unit/api/cartRestMasking.test.ts` fails when core registers a new one.
 */
export const CART_ITEM_AMOUNT_KEYS = [
  'product_price',
  'product_price_incl_tax',
  'final_price',
  'final_price_incl_tax',
  'tax_amount',
  'tax_amount_before_discount',
  'discount_amount',
  'line_total',
  'line_total_incl_tax',
  'line_total_with_discount',
  'line_total_with_discount_incl_tax'
] as const;

/**
 * Defense in depth: a key that looks like an amount is masked even if it is
 * not listed yet (e.g. a field added by another extension).
 */
const AMOUNT_KEY_PATTERN = /price|total|amount|discount|cost|fee/i;

const AMOUNT_KEYS: ReadonlySet<string> = new Set(CART_ITEM_AMOUNT_KEYS);

export function isCartItemAmountKey(key: string): boolean {
  return AMOUNT_KEYS.has(key) || AMOUNT_KEY_PATTERN.test(key);
}

type Item = Record<string, unknown>;

function isRecord(value: unknown): value is Item {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A copy of an exported cart item with every amount set to `null`. */
export function maskCartItem(item: Item): Item {
  const masked: Item = {};
  for (const [key, value] of Object.entries(item)) {
    masked[key] = isCartItemAmountKey(key) ? null : value;
  }
  masked.is_masked = true;
  return masked;
}

/** A copy of a cart REST body (`data.item` / `data.items[]`) with masked items. */
export function maskCartApiBody(body: Record<string, unknown>): Record<string, unknown> {
  const data = body.data;
  if (!isRecord(data)) {
    return body;
  }
  const masked: Item = { ...data };
  if (isRecord(data.item)) {
    masked.item = maskCartItem(data.item);
  }
  if (Array.isArray(data.items)) {
    masked.items = data.items.map((item: unknown) => (isRecord(item) ? maskCartItem(item) : item));
  }
  return { ...body, data: masked };
}

/**
 * The viewer of a REST request: the session customer (only its id is used)
 * and the pool core puts in the request or app context (`api/global/context`).
 */
function viewerContextOf(request: EvershopRequest): ViewerContext {
  const requestContext = request.locals?.context as { pool?: ViewerContext['pool'] } | undefined;
  const appContext = (request.app?.locals as { context?: { pool?: ViewerContext['pool'] } } | undefined)
    ?.context;
  return {
    customer: request.locals?.customer ?? null,
    pool: requestContext?.pool ?? appContext?.pool
  };
}

/**
 * Passive middleware body (2 args, core calls `next()`). A failed approval
 * lookup throws: core turns it into a 500 error response, so the amounts are
 * never sent (fail closed).
 */
export async function maskWholesaleCartResponse(
  request: EvershopRequest,
  response: EvershopResponse
): Promise<void> {
  const body = response.$body;
  if (!isRecord(body)) {
    return;
  }
  if (await isWholesaleViewer(viewerContextOf(request))) {
    response.$body = maskCartApiBody(body);
  }
}
