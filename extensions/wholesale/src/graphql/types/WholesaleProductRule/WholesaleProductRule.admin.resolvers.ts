/**
 * Admin GraphQL of the per-product wholesale rule (T-2.16,
 * `03_endpoints_y_contratos.md` §9): `Product.wholesaleRule`.
 *
 * `.admin.resolvers` + `.admin.graphql`: core loads both only into the admin
 * schema, so the base price never reaches the storefront schema. The rule
 * comes in its final shape from `getRuleByProductId` (line with ordered
 * tiers, `isQuotable`), so `WholesaleProductRule` uses default resolvers.
 */
import type { Pool, PoolClient } from 'pg';
import { getRuleByProductId } from '../../../services/rule/getRule.js';

interface AdminContext {
  /** Set by core on every request (`setContextValue(request, 'pool', pool)`). */
  pool?: Pool | PoolClient;
}

export default {
  Product: {
    wholesaleRule: async (product: Record<string, unknown>, _args: unknown, context: AdminContext) => {
      if (!context.pool) {
        // Fail closed rather than fall back to another connection.
        throw new Error('wholesaleRule: GraphQL context has no database pool');
      }
      // Product roots are camelCased by core; raw rows carry product_id.
      return getRuleByProductId(context.pool, Number(product.productId ?? product.product_id));
    }
  }
};
