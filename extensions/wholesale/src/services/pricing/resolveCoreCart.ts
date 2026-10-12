/**
 * Replicas of the core cart resolvers that the wholesale extension overrides
 * to mask cart amounts (ADR-06 item 6). Overriding a field drops the core
 * implementation, so non-wholesale viewers are served by these copies.
 *
 * Source: `packages/evershop/src/modules/checkout/graphql/types/Cart/Cart.resolvers.ts`.
 * Coupled to the installed `@evershop/evershop` version; the parity test
 * (`tests/unit/pricing/resolveCoreCart.test.ts`) compares them with the
 * compiled core resolvers.
 */

/** The `Price!` fields of storefront `Cart` that core resolves by property. */
export const CART_PRICE_FIELDS = [
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

/**
 * The `Price!` fields of storefront `CartItem`, mapped to the item property
 * core reads. `subTotal` and `total` are deprecated core aliases.
 */
export const CART_ITEM_PRICE_FIELDS = {
  productPrice: 'productPrice',
  productPriceInclTax: 'productPriceInclTax',
  finalPrice: 'finalPrice',
  finalPriceInclTax: 'finalPriceInclTax',
  taxAmount: 'taxAmount',
  taxAmountBeforeDiscount: 'taxAmountBeforeDiscount',
  discountAmount: 'discountAmount',
  lineTotal: 'lineTotal',
  subTotal: 'lineTotal', // Core: `subTotal: ({ lineTotal }) => lineTotal`
  lineTotalWithDiscount: 'lineTotalWithDiscount',
  lineTotalWithDiscountInclTax: 'lineTotalWithDiscountInclTax',
  lineTotalInclTax: 'lineTotalInclTax',
  total: 'lineTotalInclTax' // Core: `total: ({ lineTotalInclTax }) => lineTotalInclTax`
} as const;

export interface ShippingMethodData {
  providerCode: unknown;
  methodCode: unknown;
  snapshot: { cost?: unknown; [key: string]: unknown } | null | undefined;
  fingerprint: unknown;
  quotedAt: unknown;
}

/** Replica of core `Cart.shippingMethodData` (JSONB snake_case → GraphQL). */
export function resolveCoreShippingMethodData(cart: {
  shippingMethodData?: Record<string, unknown> | null;
}): ShippingMethodData | null {
  const data = cart.shippingMethodData;
  if (!data) return null;
  return {
    providerCode: data.provider_code,
    methodCode: data.method_code,
    snapshot: data.snapshot as ShippingMethodData['snapshot'],
    fingerprint: data.fingerprint,
    quotedAt: data.quotedAt
  };
}
