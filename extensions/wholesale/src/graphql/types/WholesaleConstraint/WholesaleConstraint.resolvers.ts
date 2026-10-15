/**
 * Storefront GraphQL `Product.wholesaleConstraint` (T-2.17,
 * `03_endpoints_y_contratos.md` §9): the quantity rules (min, step, max) of
 * a quotable product for an approved wholesale viewer (re-read from the
 * database, ADR-06); `null` for everybody else and for non-quotable
 * products. Exposes no tiers and no prices.
 */
import { isWholesaleViewer, type ViewerContext } from '../../../services/pricing/isWholesaleViewer.js';
import { getWholesaleConstraint } from '../../../services/rule/getWholesaleConstraint.js';
import type { QuantityRule } from '../../../services/rule/validateQuantity.js';

export default {
  Product: {
    wholesaleConstraint: async (
      product: Record<string, unknown>,
      _args: unknown,
      context: ViewerContext
    ): Promise<QuantityRule | null> => {
      if (!(await isWholesaleViewer(context))) {
        return null;
      }
      if (!context.pool) {
        // Unreachable: isWholesaleViewer fails closed without a pool.
        throw new Error('wholesaleConstraint: GraphQL context has no database pool');
      }
      // Product roots are camelCased by core; raw rows carry product_id.
      return getWholesaleConstraint(context.pool, Number(product.productId ?? product.product_id));
    }
  }
};
