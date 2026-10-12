/**
 * Replicas of the core price resolvers that the wholesale extension overrides
 * (ADR-06). Overriding a field in the resolver merge drops the core
 * implementation, so non-wholesale viewers are served by these copies.
 *
 * Coupled to the installed `@evershop/evershop` version. The parity test
 * (`tests/unit/pricing/resolveCorePrice.test.ts`) compares them with the
 * compiled core resolvers; update both when it fails after a core upgrade.
 */
import { getActiveLocale } from '@evershop/evershop/lib/locale/localeContext';
import { getStoreCurrency } from '@evershop/evershop/setting/services';

export interface CoreProductPrice {
  regular: number;
  special: number;
}

/**
 * Replica of `Product.price` from
 * `packages/evershop/src/modules/catalog/graphql/types/Product/Price/ProductPrice.resolvers.js`.
 */
export function resolveCorePrice(product: { price?: unknown }): CoreProductPrice {
  const price = parseFloat(product.price as string);
  return {
    regular: price,
    special: price // Core: "TODO: implement special price"
  };
}

/**
 * Replica of `Price.text` from
 * `packages/evershop/src/modules/checkout/graphql/types/Price/Price.resolvers.js`.
 */
export function resolveCorePriceText(rawPrice: unknown, currency?: string | null): string {
  const price = parseFloat(rawPrice as string);
  const curr = currency || getStoreCurrency();
  const language = getActiveLocale();
  return new Intl.NumberFormat(language, {
    style: 'currency',
    currency: curr
  }).format(price);
}
