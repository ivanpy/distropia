/**
 * Storefront quantity constraint of a product (T-2.17, RF-09).
 *
 * One query: the rule joined with its line. Only the quantity rules leave
 * this function, and only for a quotable product (enabled rule, base price,
 * active line); the base price is read to decide quotability and dropped.
 */
import { isQuotable } from './isQuotable.js';
import type { Queryable } from './ruleRow.js';
import type { QuantityRule } from './validateQuantity.js';

interface ConstraintRow {
  is_enabled: boolean;
  base_price: string | null;
  min_qty: number;
  step_qty: number;
  max_qty: number | null;
  line_is_active: boolean | null;
}

/** The quantity rules of a quotable product; `null` otherwise. */
export async function getWholesaleConstraint(db: Queryable, productId: number): Promise<QuantityRule | null> {
  if (!Number.isInteger(productId) || productId <= 0) {
    return null;
  }
  const { rows } = await db.query<ConstraintRow>(
    `SELECT r."is_enabled", r."base_price", r."min_qty", r."step_qty", r."max_qty", l."is_active" AS "line_is_active"
       FROM "wholesale_product_rule" r
       LEFT JOIN "wholesale_product_line" l ON l."wholesale_product_line_id" = r."wholesale_product_line_id"
      WHERE r."product_id" = $1`,
    [productId]
  );
  const row = rows[0];
  if (!row) {
    return null;
  }
  const quotable = isQuotable(
    { isEnabled: row.is_enabled === true, basePrice: row.base_price === null ? null : Number(row.base_price) },
    row.line_is_active === null ? null : { isActive: row.line_is_active === true }
  );
  return quotable ? { minQty: row.min_qty, stepQty: row.step_qty, maxQty: row.max_qty } : null;
}
