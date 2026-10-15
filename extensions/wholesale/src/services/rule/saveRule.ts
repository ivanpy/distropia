/**
 * Saves the wholesale rule of a product (T-2.11, CU-01b step 3, data model
 * §7.2) with `insertOnUpdate` on `product_id`, on the caller's transaction.
 *
 * Written columns: `wholesale_product_line_id`, `base_price`, `vat_rate`,
 * `is_critical_consumable`, `is_enabled`, `min_qty`, `step_qty`, `max_qty`.
 * The deprecated `tiers` column is never written (tiers live on the line).
 *
 * Optional keys left out keep their stored value (table default on
 * creation); an explicit `null` clears them. A rule without line or base
 * price is saved but not quotable (CU-01b 2a); an inactive line may be
 * assigned. Everything the database would refuse is answered as a 422 with
 * the offending field instead of a constraint error.
 */
import { insertOnUpdate } from '@evershop/postgres-query-builder';
import type { PoolClient } from 'pg';
import { UUID_PATTERN } from '../customer/setCustomerApproval.js';
import { getRuleByProductId, type WholesaleRule } from './getRule.js';
import { VAT_RATES, type VatRate } from './ruleRow.js';

/** PostgreSQL `INT`. */
const MAX_INT = 2147483647;
/** `base_price numeric(14,2)`: below 10^12. */
const MAX_BASE_PRICE = 999999999999.99;

export type RuleErrorCode = 'PRODUCT_NOT_FOUND' | 'PRODUCT_LINE_NOT_FOUND' | 'INVALID_RULE';

export class RuleError extends Error {
  readonly code: RuleErrorCode;

  readonly status: number;

  readonly details?: { field: string };

  constructor(code: RuleErrorCode, status: number, message: string, details?: { field: string }) {
    super(message);
    this.name = 'RuleError';
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

export const isRuleError = (e: unknown): e is RuleError => e instanceof RuleError;

/** Body of `POST /api/wholesale/products/:id/rule` (schema v2.0). */
export interface SaveRuleInput {
  isEnabled: boolean;
  productLineUuid?: string | null;
  basePrice?: number | null;
  vatRate: VatRate;
  isCriticalConsumable: boolean;
  minQty: number;
  stepQty: number;
  maxQty?: number | null;
}

const invalid = (field: string, message: string) => new RuleError('INVALID_RULE', 422, message, { field });

const isQuantity = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= MAX_INT;

/** Positive, at most 2 decimals, fits `numeric(14,2)`. */
const isBasePrice = (value: unknown): value is number =>
  typeof value === 'number' &&
  Number.isFinite(value) &&
  value > 0 &&
  value <= MAX_BASE_PRICE &&
  Math.abs(Math.round(value * 100) - value * 100) < 1e-6;

function validate(input: SaveRuleInput): void {
  if (typeof input.isEnabled !== 'boolean') {
    throw invalid('isEnabled', 'isEnabled must be a boolean');
  }
  if (typeof input.isCriticalConsumable !== 'boolean') {
    throw invalid('isCriticalConsumable', 'isCriticalConsumable must be a boolean');
  }
  if (!VAT_RATES.includes(input.vatRate)) {
    throw invalid('vatRate', `vatRate must be one of ${VAT_RATES.join(', ')}`);
  }
  if (!isQuantity(input.minQty)) {
    throw invalid('minQty', 'minQty must be a whole number of at least 1');
  }
  if (!isQuantity(input.stepQty)) {
    throw invalid('stepQty', 'stepQty must be a whole number of at least 1');
  }
  if (input.maxQty !== undefined && input.maxQty !== null && !isQuantity(input.maxQty)) {
    throw invalid('maxQty', 'maxQty must be a whole number of at least 1, or null');
  }
  if (input.basePrice !== undefined && input.basePrice !== null && !isBasePrice(input.basePrice)) {
    throw invalid('basePrice', 'basePrice must be a positive amount with at most 2 decimals, or null');
  }
}

function assertTransaction(connection: PoolClient): void {
  if ((connection as PoolClient & { INTRANSACTION?: boolean }).INTRANSACTION !== true) {
    throw new Error('saveRule must run on the connection of an open transaction');
  }
}

async function lockProduct(connection: PoolClient, productUuid: string): Promise<number> {
  const notFound = new RuleError('PRODUCT_NOT_FOUND', 404, 'Product not found');
  if (!UUID_PATTERN.test(productUuid)) {
    throw notFound;
  }
  // Serializes concurrent saves of the same product (the stored max/min check below).
  const { rows } = await connection.query(`SELECT "product_id" FROM "product" WHERE "uuid" = $1 FOR UPDATE`, [
    productUuid
  ]);
  if (!rows[0]) {
    throw notFound;
  }
  return rows[0].product_id as number;
}

async function lineIdOf(connection: PoolClient, lineUuid: string): Promise<number> {
  const notFound = new RuleError('PRODUCT_LINE_NOT_FOUND', 422, 'Product line not found', {
    field: 'productLineUuid'
  });
  if (!UUID_PATTERN.test(lineUuid)) {
    throw notFound;
  }
  const { rows } = await connection.query(
    `SELECT "wholesale_product_line_id" FROM "wholesale_product_line" WHERE "uuid" = $1`,
    [lineUuid]
  );
  if (!rows[0]) {
    throw notFound;
  }
  return rows[0].wholesale_product_line_id as number;
}

export async function saveRule(
  connection: PoolClient,
  productUuid: string,
  input: SaveRuleInput
): Promise<WholesaleRule> {
  assertTransaction(connection);
  validate(input);
  const productId = await lockProduct(connection, productUuid);

  // The cap is checked against the stored value when it is left out.
  const { rows: stored } = await connection.query(
    `SELECT "max_qty" FROM "wholesale_product_rule" WHERE "product_id" = $1`,
    [productId]
  );
  const maxQty = input.maxQty === undefined ? ((stored[0]?.max_qty as number | null | undefined) ?? null) : input.maxQty;
  if (maxQty !== null && maxQty < input.minQty) {
    throw invalid('maxQty', 'maxQty must be at least minQty');
  }

  const data: Record<string, unknown> = {
    product_id: productId,
    is_enabled: input.isEnabled,
    vat_rate: input.vatRate,
    is_critical_consumable: input.isCriticalConsumable,
    min_qty: input.minQty,
    step_qty: input.stepQty
  };
  if (input.productLineUuid !== undefined) {
    data.wholesale_product_line_id =
      input.productLineUuid === null ? null : await lineIdOf(connection, input.productLineUuid);
  }
  if (input.basePrice !== undefined) {
    data.base_price = input.basePrice;
  }
  if (input.maxQty !== undefined) {
    data.max_qty = input.maxQty;
  }

  await insertOnUpdate('wholesale_product_rule', ['product_id']).given(data).execute(connection, false);
  const rule = await getRuleByProductId(connection, productId);
  if (!rule) {
    throw new Error('saveRule: the saved rule could not be read back');
  }
  return rule;
}
