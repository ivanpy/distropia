/**
 * Row shape of `wholesale_product_rule` (migrations 1.0.0 + 1.1.0) and its
 * mapping to the camelCase rule data the services return.
 *
 * The deprecated `tiers` JSONB column (1.0.0) is never read nor written:
 * tiers live on the product line since 1.1.0 (ADR-10).
 */
import type { Pool, PoolClient } from 'pg';

export type VatRate = '10' | '5' | 'exempt';

/** `WHOLESALE_RULE_VAT_RATE_CHECK` (migration 1.1.0). */
export const VAT_RATES: readonly VatRate[] = ['10', '5', 'exempt'];

export type Queryable = Pick<Pool | PoolClient, 'query'>;

export interface RuleRow {
  wholesale_product_rule_id: number;
  uuid: string;
  product_id: number;
  wholesale_product_line_id: number | null;
  is_enabled: boolean;
  /** `numeric(14,2)`: pg returns it as text. */
  base_price: string | null;
  vat_rate: string;
  is_critical_consumable: boolean;
  min_qty: number;
  step_qty: number;
  max_qty: number | null;
  updated_at: Date | string | null;
}

/** Every column the services read (never `tiers`). */
export const RULE_COLUMNS = [
  'wholesale_product_rule_id',
  'uuid',
  'product_id',
  'wholesale_product_line_id',
  'is_enabled',
  'base_price',
  'vat_rate',
  'is_critical_consumable',
  'min_qty',
  'step_qty',
  'max_qty',
  'updated_at'
]
  .map((column) => `r."${column}"`)
  .join(', ');

/** Per-product wholesale data (admin/internal only: carries the base price). */
export interface RuleData {
  isEnabled: boolean;
  /** Net of VAT, store currency; `null` = not quotable. */
  basePrice: number | null;
  vatRate: VatRate;
  isCriticalConsumable: boolean;
  minQty: number;
  stepQty: number;
  /** `null` = no cap. */
  maxQty: number | null;
}

export const toRuleData = (row: RuleRow): RuleData => ({
  isEnabled: row.is_enabled === true,
  basePrice: row.base_price === null ? null : Number(row.base_price),
  vatRate: row.vat_rate as VatRate,
  isCriticalConsumable: row.is_critical_consumable === true,
  minQty: row.min_qty,
  stepQty: row.step_qty,
  maxQty: row.max_qty
});
