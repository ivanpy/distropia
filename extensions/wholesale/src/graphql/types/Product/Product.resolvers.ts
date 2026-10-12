/**
 * ADR-06: hide product prices from approved wholesale customers.
 *
 * Replaces core `Product.price` (extension resolvers are merged after core,
 * so the last definition wins). Approved wholesale viewers get masked amounts
 * (value 0, placeholder text, see `Price.resolvers.ts`); everybody else gets
 * the core result, reproduced by `resolveCorePrice`.
 */
import {
  isWholesaleViewer,
  type ViewerContext
} from '../../../services/pricing/isWholesaleViewer.js';
import { MASKED_AMOUNT, type MaskedAmount } from '../../../services/pricing/maskedAmount.js';
import { resolveCorePrice } from '../../../services/pricing/resolveCorePrice.js';

export interface ResolvedProductPrice {
  regular: number | MaskedAmount;
  special: number | MaskedAmount;
  isMasked: boolean;
}

export default {
  Product: {
    price: async (
      product: { price?: unknown },
      _args: unknown,
      context: ViewerContext
    ): Promise<ResolvedProductPrice> => {
      if (await isWholesaleViewer(context)) {
        return { regular: MASKED_AMOUNT, special: MASKED_AMOUNT, isMasked: true };
      }
      return { ...resolveCorePrice(product), isMasked: false };
    }
  },
  ProductPrice: {
    isMasked: (price: { isMasked?: unknown }): boolean => price.isMasked === true
  }
};
