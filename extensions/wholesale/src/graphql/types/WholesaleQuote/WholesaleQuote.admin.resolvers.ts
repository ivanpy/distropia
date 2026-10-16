/**
 * Admin GraphQL quote detail (T-2.51, `03_endpoints_y_contratos.md` §9):
 * `wholesaleQuote(uuid)`.
 *
 * `.admin.resolvers` + `.admin.graphql`: core loads both only into the admin
 * schema. The detail comes in its final shape from `getQuoteDetail`
 * (canonical status, numbers, items), so the types use default resolvers;
 * `customer` is a core `Customer` root.
 */
import type { Pool, PoolClient } from 'pg';
import { getQuoteDetail } from '../../../services/quote/getQuoteDetail.js';

interface AdminContext {
  /** Set by core on every request (`setContextValue(request, 'pool', pool)`). */
  pool?: Pool | PoolClient;
}

export default {
  Query: {
    wholesaleQuote: async (_root: unknown, { uuid }: { uuid: string }, context: AdminContext) => {
      if (!context.pool) {
        // Fail closed rather than fall back to another connection.
        throw new Error('wholesaleQuote: GraphQL context has no database pool');
      }
      return getQuoteDetail(context.pool, uuid);
    }
  }
};
