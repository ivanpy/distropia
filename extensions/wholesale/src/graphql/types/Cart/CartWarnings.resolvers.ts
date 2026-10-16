/**
 * `Cart.wholesaleWarnings` (T-2.48): codes for approved wholesale viewers
 * (approval re-read from the database), an empty list for everybody else.
 * The cart comes from core (`camelCase(cart.exportData())`, `cartId`).
 */
import { cartWholesaleWarnings } from '../../../services/cart/wholesaleWarnings.js';
import { isWholesaleViewer, type ViewerContext } from '../../../services/pricing/isWholesaleViewer.js';
import { readQuoteSettingsSource, toQuoteSettings } from '../../../services/quote/quoteInput.js';

export default {
  Cart: {
    wholesaleWarnings: async (
      cart: { cartId?: unknown; cart_id?: unknown },
      _args: unknown,
      context: ViewerContext
    ): Promise<{ code: string }[]> => {
      if (!(await isWholesaleViewer(context))) {
        return [];
      }
      const cartId = Number(cart.cartId ?? cart.cart_id);
      if (!Number.isInteger(cartId) || cartId <= 0 || !context.pool) {
        return [];
      }
      const codes = await cartWholesaleWarnings(context.pool, cartId, toQuoteSettings(readQuoteSettingsSource()));
      return codes.map((code) => ({ code }));
    }
  }
};
