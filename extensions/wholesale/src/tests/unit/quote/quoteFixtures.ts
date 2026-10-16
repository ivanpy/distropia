/**
 * Committed fixtures of the quote tests, written into a scratch database
 * (`scratchDatabase.ts`), which is dropped afterwards.
 */
import { randomUUID } from 'crypto';
import type { Pool } from 'pg';
import { withApprovalWrite } from '../../../services/customer/approvalWriteFlag.js';
import type { QuoteSettingsSource } from '../../../services/quote/quoteInput.js';

/** PYG, minimum 5.000.000, mix 15 %, free shipping up to 500 kg. */
export const SETTINGS: QuoteSettingsSource = {
  currency: 'PYG',
  minimumNetTotal: 5_000_000,
  mixMinShare: 0.15,
  freeShippingMaxWeightKg: 500
};

export interface CustomerFixture {
  customerId: number;
  uuid: string;
}

let nextPhone = 981000000;

export async function insertCustomer(
  pool: Pool,
  options: { approved?: boolean; phone?: string | null; status?: number } = {}
): Promise<CustomerFixture> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    nextPhone += 1;
    const { rows } = await withApprovalWrite(client, () =>
      client.query(
        `INSERT INTO "customer" ("email", "password", "full_name", "phone", "tax_id", "status",
                                 "is_wholesale_approved", "wholesale_approved_at")
         VALUES ($1, 'x', 'Quote Buyer', $2, '80012344-1', $3, $4, CASE WHEN $4 THEN CURRENT_TIMESTAMP END)
         RETURNING "customer_id", "uuid"`,
        [
          `quote-${randomUUID()}@example.com`,
          options.phone === undefined ? `+595${nextPhone}` : options.phone,
          options.status ?? 1,
          options.approved ?? true
        ]
      )
    );
    await client.query('COMMIT');
    return { customerId: rows[0].customer_id, uuid: rows[0].uuid };
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

export interface LineFixture {
  lineId: number;
  name: string;
}

export async function insertLine(
  pool: Pool,
  tiers: { fromQty: number; discountPercent: number; label?: string }[],
  options: { countsTowardMix?: boolean; isActive?: boolean } = {}
): Promise<LineFixture> {
  const name = `Line ${randomUUID()}`;
  const { rows } = await pool.query(
    `INSERT INTO "wholesale_product_line" ("name", "counts_toward_mix", "is_active")
     VALUES ($1, $2, $3) RETURNING "wholesale_product_line_id"`,
    [name, options.countsTowardMix ?? true, options.isActive ?? true]
  );
  const lineId = rows[0].wholesale_product_line_id as number;
  for (const tier of tiers) {
    await pool.query(
      `INSERT INTO "wholesale_product_line_tier" ("wholesale_product_line_id", "from_qty", "discount_percent", "label")
       VALUES ($1, $2, $3, $4)`,
      [lineId, tier.fromQty, tier.discountPercent, tier.label ?? null]
    );
  }
  return { lineId, name };
}

export interface ProductFixture {
  productId: number;
  uuid: string;
  sku: string;
  name: string;
}

export async function insertProduct(
  pool: Pool,
  options: {
    lineId?: number | null;
    weight?: number | null;
    basePrice?: number | null;
    vatRate?: '10' | '5' | 'exempt';
    isCriticalConsumable?: boolean;
    minQty?: number;
    stepQty?: number;
    rule?: boolean;
  } = {}
): Promise<ProductFixture> {
  const sku = `QUOTE-${randomUUID()}`;
  const name = `Quote product ${sku.slice(-6)}`;
  const { rows } = await pool.query(
    `INSERT INTO "product" ("sku", "price", "weight") VALUES ($1, 1, $2) RETURNING "product_id", "uuid"`,
    [sku, options.weight === undefined ? 2 : options.weight]
  );
  const productId = rows[0].product_id as number;
  await pool.query(
    `INSERT INTO "product_description" ("product_description_product_id", "name", "url_key") VALUES ($1, $2, $3)`,
    [productId, name, sku.toLowerCase()]
  );
  if (options.rule !== false) {
    await pool.query(
      `INSERT INTO "wholesale_product_rule"
         ("product_id", "wholesale_product_line_id", "base_price", "vat_rate", "is_critical_consumable",
          "min_qty", "step_qty")
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        productId,
        options.lineId ?? null,
        options.basePrice === undefined ? 100_000 : options.basePrice,
        options.vatRate ?? '10',
        options.isCriticalConsumable ?? false,
        options.minQty ?? 1,
        options.stepQty ?? 1
      ]
    );
  }
  return { productId, uuid: rows[0].uuid as string, sku, name };
}

export async function insertCart(
  pool: Pool,
  customerId: number | null,
  items: { product: ProductFixture; qty: number }[],
  options: { active?: boolean } = {}
): Promise<{ cartId: number; uuid: string }> {
  const { rows } = await pool.query(
    `INSERT INTO "cart" ("customer_id", "status") VALUES ($1, $2) RETURNING "cart_id", "uuid"`,
    [customerId, options.active ?? true]
  );
  const cartId = rows[0].cart_id as number;
  for (const { product, qty } of items) {
    await pool.query(
      `INSERT INTO "cart_item" ("cart_id", "product_id", "product_sku", "qty") VALUES ($1, $2, $3, $4)`,
      [cartId, product.productId, product.sku, qty]
    );
  }
  return { cartId, uuid: rows[0].uuid as string };
}
