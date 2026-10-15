/**
 * Reads the wholesale rule of a product (T-2.12, CU-01b step 1).
 *
 * Shape of the admin GraphQL `WholesaleProductRule` and of the
 * `POST /api/wholesale/products/:id/rule` response: the product line comes
 * with its ordered tiers, `isQuotable` follows the line state, and only
 * uuids leave the service. Admin/internal only: it carries the base price.
 */
import { UUID_PATTERN } from '../customer/setCustomerApproval.js';
import { loadProductLinesById, type ProductLine } from '../line/productLines.js';
import { isQuotable } from './isQuotable.js';
import { type Queryable, RULE_COLUMNS, type RuleData, type RuleRow, toRuleData } from './ruleRow.js';

export interface WholesaleRule extends RuleData {
  uuid: string;
  isQuotable: boolean;
  /** `null` when no line is assigned. */
  productLine: ProductLine | null;
  /** ISO 8601. */
  updatedAt: string | null;
}

const toIso = (value: Date | string | null): string | null =>
  value === null ? null : (value instanceof Date ? value : new Date(value)).toISOString();

async function toRule(db: Queryable, row: RuleRow): Promise<WholesaleRule> {
  const lineId = row.wholesale_product_line_id;
  const productLine = lineId === null ? null : ((await loadProductLinesById(db, [lineId])).get(lineId) ?? null);
  const data = toRuleData(row);
  return {
    uuid: row.uuid,
    ...data,
    isQuotable: isQuotable(data, productLine),
    productLine,
    updatedAt: toIso(row.updated_at)
  };
}

/** The rule of a core product id; `null` without rule. */
export async function getRuleByProductId(db: Queryable, productId: number): Promise<WholesaleRule | null> {
  if (!Number.isInteger(productId) || productId <= 0) {
    return null;
  }
  const { rows } = await db.query<RuleRow>(
    `SELECT ${RULE_COLUMNS} FROM "wholesale_product_rule" r WHERE r."product_id" = $1`,
    [productId]
  );
  return rows[0] ? toRule(db, rows[0]) : null;
}

/** The rule of a product uuid; `null` for a non-uuid, an unknown product or a product without rule. */
export async function getRule(db: Queryable, productUuid: string): Promise<WholesaleRule | null> {
  if (!UUID_PATTERN.test(productUuid)) {
    return null;
  }
  const { rows } = await db.query<RuleRow>(
    `SELECT ${RULE_COLUMNS}
       FROM "wholesale_product_rule" r
       JOIN "product" p ON p."product_id" = r."product_id"
      WHERE p."uuid" = $1`,
    [productUuid]
  );
  return rows[0] ? toRule(db, rows[0]) : null;
}
