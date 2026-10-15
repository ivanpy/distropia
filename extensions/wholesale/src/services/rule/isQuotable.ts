/**
 * Quotability and quote data of products (T-2.44, RF-03, data model §7.2).
 *
 * A product is quotable for B2B only with an enabled wholesale rule, a base
 * price and an active product line. `loadQuoteProducts` loads, in a fixed
 * number of queries, what the quote calculation needs per product: the rule
 * (base price, VAT rate, critical consumable, quantity rules), the line with
 * its ordered tiers and the core `product.weight` (RF-25, `null` allowed).
 *
 * Internal service: the result carries base prices, tiers and internal ids
 * and must never reach the storefront.
 */
import { loadProductLinesById } from '../line/productLines.js';
import type { LineTier } from '../line/validateLineTiers.js';
import { type Queryable, RULE_COLUMNS, type RuleData, type RuleRow, toRuleData } from './ruleRow.js';

export interface QuotableRuleInput {
  isEnabled: boolean;
  basePrice: number | null;
}

/** Pure quotability check: enabled rule, positive finite base price, active line. */
export function isQuotable(
  rule: QuotableRuleInput | null | undefined,
  line: { isActive: boolean } | null | undefined
): boolean {
  return (
    rule?.isEnabled === true &&
    typeof rule.basePrice === 'number' &&
    Number.isFinite(rule.basePrice) &&
    rule.basePrice > 0 &&
    line?.isActive === true
  );
}

export interface QuoteProductLine {
  /** Internal id (`wholesale_product_line_id`), for grouping only. */
  id: number;
  uuid: string;
  name: string;
  isActive: boolean;
  countsTowardMix: boolean;
  /** Ordered by `fromQty` ascending. */
  tiers: LineTier[];
}

export interface QuoteProductData {
  productId: number;
  productUuid: string;
  sku: string;
  /** `product_description.name`; the SKU when the product has no description. */
  name: string;
  /** `product.weight` in the store weight unit; `null` when unknown. */
  weight: number | null;
  quotable: boolean;
  /** `null` when the product has no wholesale rule. */
  rule: RuleData | null;
  /** `null` when the rule has no line (or there is no rule). */
  line: QuoteProductLine | null;
}

interface ProductRow {
  product_id: number;
  uuid: string;
  sku: string;
  name: string | null;
  weight: string | null;
}

/**
 * Quote data of the given core product ids, keyed by product id. Unknown ids
 * are left out; a product without rule is present and not quotable.
 */
export async function loadQuoteProducts(db: Queryable, productIds: number[]): Promise<Map<number, QuoteProductData>> {
  const ids = [...new Set(productIds.filter((id) => Number.isInteger(id) && id > 0))];
  const result = new Map<number, QuoteProductData>();
  if (ids.length === 0) {
    return result;
  }

  const { rows: products } = await db.query<ProductRow>(
    `SELECT p."product_id", p."uuid", p."sku", d."name", p."weight"
       FROM "product" p
       LEFT JOIN "product_description" d ON d."product_description_product_id" = p."product_id"
      WHERE p."product_id" = ANY($1::int[])`,
    [ids]
  );
  const { rows: rules } = await db.query<RuleRow>(
    `SELECT ${RULE_COLUMNS} FROM "wholesale_product_rule" r WHERE r."product_id" = ANY($1::int[])`,
    [ids]
  );
  const ruleByProduct = new Map(rules.map((row) => [row.product_id, row]));
  const lines = await loadProductLinesById(
    db,
    rules.flatMap((row) => (row.wholesale_product_line_id === null ? [] : [row.wholesale_product_line_id]))
  );

  for (const product of products) {
    const ruleRow = ruleByProduct.get(product.product_id);
    const rule = ruleRow ? toRuleData(ruleRow) : null;
    const lineId = ruleRow?.wholesale_product_line_id ?? null;
    const line = lineId === null ? undefined : lines.get(lineId);
    const quoteLine: QuoteProductLine | null =
      lineId !== null && line ? { id: lineId, ...line } : null;
    result.set(product.product_id, {
      productId: product.product_id,
      productUuid: product.uuid,
      sku: product.sku,
      name: product.name ?? product.sku,
      weight: product.weight === null ? null : Number(product.weight),
      quotable: isQuotable(rule, quoteLine),
      rule,
      line: quoteLine
    });
  }
  return result;
}
