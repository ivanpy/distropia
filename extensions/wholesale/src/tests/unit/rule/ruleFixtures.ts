/**
 * Fixture helpers of the per-product wholesale rule tests (W5b). Every row
 * lives in the caller's rolled-back fixture transaction.
 */
import { randomUUID } from 'crypto';
import type { PoolClient } from 'pg';

export interface ProductFixture {
  productId: number;
  uuid: string;
  sku: string;
}

/** A product (with inventory and description, as core `Query.product` inner-joins them). */
export async function insertProduct(
  client: PoolClient,
  options: { weight?: number | null; name?: string; price?: number } = {}
): Promise<ProductFixture> {
  const sku = `WHOLESALE-RULE-${randomUUID()}`;
  const { rows } = await client.query(
    `INSERT INTO "product" ("sku", "price", "status", "weight")
     VALUES ($1, $2, true, $3) RETURNING "product_id", "uuid"`,
    [sku, options.price ?? 99.5, options.weight === undefined ? 1.25 : options.weight]
  );
  const productId = rows[0].product_id as number;
  await client.query(
    `INSERT INTO "product_inventory" ("product_inventory_product_id", "qty") VALUES ($1, 1000)`,
    [productId]
  );
  await client.query(
    `INSERT INTO "product_description" ("product_description_product_id", "name", "url_key")
     VALUES ($1, $2, $3)`,
    [productId, options.name ?? `Rule product ${sku}`, sku.toLowerCase()]
  );
  return { productId, uuid: rows[0].uuid as string, sku };
}

export interface RuleFixture {
  lineId?: number | null;
  isEnabled?: boolean;
  basePrice?: number | null;
  vatRate?: '10' | '5' | 'exempt';
  isCriticalConsumable?: boolean;
  minQty?: number;
  stepQty?: number;
  maxQty?: number | null;
}

/** Writes a rule row directly (bypassing `saveRule`). */
export async function insertRule(client: PoolClient, productId: number, rule: RuleFixture = {}): Promise<void> {
  await client.query(
    `INSERT INTO "wholesale_product_rule"
       ("product_id", "wholesale_product_line_id", "is_enabled", "base_price", "vat_rate",
        "is_critical_consumable", "min_qty", "step_qty", "max_qty")
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      productId,
      rule.lineId ?? null,
      rule.isEnabled ?? true,
      rule.basePrice === undefined ? 1000 : rule.basePrice,
      rule.vatRate ?? '10',
      rule.isCriticalConsumable ?? false,
      rule.minQty ?? 1,
      rule.stepQty ?? 1,
      rule.maxQty ?? null
    ]
  );
}

/** The internal id of a line uuid. */
export async function lineIdOf(client: PoolClient, uuid: string): Promise<number> {
  const { rows } = await client.query(
    `SELECT "wholesale_product_line_id" FROM "wholesale_product_line" WHERE "uuid" = $1`,
    [uuid]
  );
  return rows[0].wholesale_product_line_id as number;
}
