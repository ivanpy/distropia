/**
 * Admin GraphQL of product lines (T-2.43, `03_endpoints_y_contratos.md` §9).
 *
 * `.admin.resolvers` + `.admin.graphql`: core loads both only into the admin
 * schema. Lines come with their tiers already ordered (`listProductLines`),
 * so `WholesaleProductLine` uses the default field resolvers.
 */
import type { Pool, PoolClient } from 'pg';
import { listProductLines } from '../../../services/line/productLines.js';

interface AdminContext {
  /** Set by core on every request (`setContextValue(request, 'pool', pool)`). */
  pool?: Pool | PoolClient;
}

export default {
  Query: {
    wholesaleProductLines: async (
      _root: unknown,
      { includeInactive }: { includeInactive?: boolean | null },
      context: AdminContext
    ) => {
      if (!context.pool) {
        // Fail closed rather than fall back to another connection.
        throw new Error('wholesaleProductLines: GraphQL context has no database pool');
      }
      return listProductLines(context.pool, { includeInactive: includeInactive === true });
    }
  }
};
