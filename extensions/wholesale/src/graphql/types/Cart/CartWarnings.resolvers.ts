/**
 * `Cart.wholesaleWarnings` (T-2.48): codes for approved wholesale viewers
 * (approval re-read from the database), an empty list for everybody else.
 * The cart comes from core (`camelCase(cart.exportData())`, `cartId`).
 *
 * The field is non-null: an error here would null the whole cart, so a
 * failing viewer re-read or calculation (database, configuration, invalid
 * product data) is logged and answered with no warning; `createQuote` still
 * refuses the quote.
 */
import { error as logError } from '@evershop/evershop/lib/log';
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
      try {
        if (!(await isWholesaleViewer(context))) {
          return [];
        }
        const cartId = Number(cart.cartId ?? cart.cart_id);
        if (!Number.isInteger(cartId) || cartId <= 0 || !context.pool) {
          return [];
        }
        const codes = await cartWholesaleWarnings(context.pool, cartId, toQuoteSettings(readQuoteSettingsSource()));
        return codes.map((code) => ({ code }));
      } catch (e) {
        logError(e);
        return [];
      }
    }
  }
};
