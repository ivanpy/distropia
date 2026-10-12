/**
 * Parity test for the core price resolver replicas (ADR-06, T-2.10b).
 *
 * Imports the compiled core resolvers and checks that, for non-wholesale
 * viewers, the extension produces exactly what core would. When this fails
 * after a core upgrade, update `services/pricing/resolveCorePrice.ts`.
 */
import path from 'path';
import priceResolvers from '../../../graphql/types/Price/Price.resolvers.js';
import productResolvers from '../../../graphql/types/Product/Product.resolvers.js';
import { MASKED_AMOUNT, MASKED_PRICE_TEXT } from '../../../services/pricing/maskedAmount.js';
import {
  resolveCorePrice,
  resolveCorePriceText
} from '../../../services/pricing/resolveCorePrice.js';

const CORE_DIST = path.resolve(process.cwd(), 'packages/evershop/dist/modules');

type CoreProductPriceResolvers = {
  default: { Product: { price: (product: unknown) => unknown } };
};
type CorePriceResolvers = {
  default: {
    Price: {
      value: (raw: unknown) => number;
      text: (raw: unknown, args: { currency?: string }) => string;
    };
  };
};

const PRODUCT_PRICES: unknown[] = ['12.5000', '0', '1999.99', 7, 0.1, null, 'abc'];

describe('resolveCorePrice parity with core', () => {
  let coreProductPrice: CoreProductPriceResolvers['default'];
  let corePrice: CorePriceResolvers['default'];

  beforeAll(async () => {
    coreProductPrice = (
      (await import(
        path.join(CORE_DIST, 'catalog/graphql/types/Product/Price/ProductPrice.resolvers.js')
      )) as CoreProductPriceResolvers
    ).default;
    corePrice = (
      (await import(
        path.join(CORE_DIST, 'checkout/graphql/types/Price/Price.resolvers.js')
      )) as CorePriceResolvers
    ).default;
  });

  it.each(PRODUCT_PRICES)('Product.price matches core for price %p', (price) => {
    const product = { productId: 1, price };
    expect(resolveCorePrice(product)).toEqual(coreProductPrice.Product.price(product));
  });

  it.each(PRODUCT_PRICES)('Product.price adds only isMasked=false for B2C (%p)', async (price) => {
    const product = { productId: 1, price };
    const context = {}; // anonymous: no DB access needed
    const resolved = await productResolvers.Product.price(product, {}, context);
    expect(resolved).toEqual({
      ...(coreProductPrice.Product.price(product) as object),
      isMasked: false
    });
  });

  it.each([
    [12.5, undefined],
    [0, undefined],
    [1999.99, 'EUR'],
    [1234567.891, 'PYG'],
    ['42', 'USD']
  ])('Price.text matches core for %p (%p)', (raw, currency) => {
    const args = currency ? { currency } : {};
    const expected = corePrice.Price.text(raw, args);
    expect(resolveCorePriceText(raw, currency)).toBe(expected);
    expect(priceResolvers.Price.text(raw, args)).toBe(expected);
  });

  it('renders the placeholder only for masked amounts', () => {
    expect(priceResolvers.Price.text(MASKED_AMOUNT, {})).toBe(MASKED_PRICE_TEXT);
    // Core value/currency resolvers stay in charge and see a 0 amount.
    expect(corePrice.Price.value(MASKED_AMOUNT)).toBe(0);
    expect(priceResolvers.Price.text(0, {})).toBe(corePrice.Price.text(0, {}));
  });
});
