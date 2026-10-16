/**
 * Inputs of the quote calculation shared by `createQuote` and
 * `Cart.wholesaleWarnings`: the cart lines, the per-product quote data and
 * the `wholesale.quote` settings (free-shipping threshold already converted
 * to the store weight unit, T-2.47).
 *
 * Internal: the products carry base prices and tiers.
 */
import { getConfig } from '@evershop/evershop/lib/util/getConfig';
import { getWeightUnit } from '@evershop/evershop/setting/services';
import { WHOLESALE_CONFIG_DEFAULTS } from '../../config/defaults.js';
import { currencyDecimals } from '../money/roundToCurrency.js';
import { loadQuoteProducts, type QuoteProductData } from '../rule/isQuotable.js';
import type { Queryable } from '../rule/ruleRow.js';
import { type QuantityCheck, validateQuantity } from '../rule/validateQuantity.js';
import type { QuoteConfig, QuoteInputItem } from './calculateQuote.js';
import { freeShippingMaxWeightInStoreUnit } from './weightThreshold.js';

/** The `wholesale.quote` keys the calculation reads. */
export interface QuoteSettingsSource {
  currency: string;
  minimumNetTotal: number;
  mixMinShare: number;
  freeShippingMaxWeightKg: number | null;
}

export interface QuoteSettings extends QuoteConfig {
  currency: string;
}

const DEFAULTS = WHOLESALE_CONFIG_DEFAULTS.quote;

/** `wholesale.quote` from node-config, each key falling back to the versioned default. */
export function readQuoteSettingsSource(): QuoteSettingsSource {
  return {
    currency: getConfig<string>('wholesale.quote.currency', DEFAULTS.currency),
    minimumNetTotal: Number(getConfig<number>('wholesale.quote.minimumNetTotal', DEFAULTS.minimumNetTotal)),
    mixMinShare: Number(getConfig<number>('wholesale.quote.mixMinShare', DEFAULTS.mixMinShare)),
    freeShippingMaxWeightKg: getConfig<number | null>(
      'wholesale.quote.freeShippingMaxWeightKg',
      DEFAULTS.freeShippingMaxWeightKg
    )
  };
}

/** Calculation settings; the kg threshold is converted to `weightUnit` (store unit by default). */
export function toQuoteSettings(source: QuoteSettingsSource, weightUnit: string = getWeightUnit()): QuoteSettings {
  const currency = source.currency.toUpperCase();
  return {
    currency,
    decimals: currencyDecimals(currency),
    mixMinShare: source.mixMinShare,
    minimumNetTotal: source.minimumNetTotal,
    freeShippingMaxWeight: freeShippingMaxWeightInStoreUnit(source.freeShippingMaxWeightKg ?? null, weightUnit)
  };
}

export interface CartLine {
  productId: number;
  qty: number;
}

/** Items of a core cart, in insertion order. */
export async function loadCartLines(db: Queryable, cartId: number): Promise<CartLine[]> {
  const { rows } = await db.query<{ product_id: number; qty: number }>(
    `SELECT "product_id", "qty" FROM "cart_item" WHERE "cart_id" = $1 ORDER BY "cart_item_id"`,
    [cartId]
  );
  return rows.map((row) => ({ productId: row.product_id, qty: Number(row.qty) }));
}

export interface QuoteItemRefusal {
  productId: number;
  /** Public uuid; `null` when the product no longer exists. */
  productUuid: string | null;
}

export interface PreparedQuoteItems {
  /** Quotable lines, ready for `calculateQuote`. */
  items: QuoteInputItem[];
  products: Map<number, QuoteProductData>;
  notQuotable: QuoteItemRefusal[];
  invalidQuantities: (QuoteItemRefusal & { check: Exclude<QuantityCheck, { valid: true }> })[];
}

/**
 * Loads the quote data of the cart lines and splits them into calculable
 * items, non-quotable products (RF-03) and quantities off the rule's grid
 * (RF-09, RF-10). Callers decide whether a refusal blocks.
 */
export async function prepareQuoteItems(db: Queryable, lines: readonly CartLine[]): Promise<PreparedQuoteItems> {
  const products = await loadQuoteProducts(
    db,
    lines.map((l) => l.productId)
  );
  const prepared: PreparedQuoteItems = { items: [], products, notQuotable: [], invalidQuantities: [] };
  for (const line of lines) {
    const product = products.get(line.productId);
    if (!product || !product.quotable || !product.rule || !product.line || product.rule.basePrice === null) {
      prepared.notQuotable.push({ productId: line.productId, productUuid: product?.productUuid ?? null });
      continue;
    }
    const { rule } = product;
    const check = validateQuantity(line.qty, { minQty: rule.minQty, stepQty: rule.stepQty, maxQty: rule.maxQty });
    if (!check.valid) {
      prepared.invalidQuantities.push({ productId: line.productId, productUuid: product.productUuid, check });
      continue;
    }
    prepared.items.push({
      productId: product.productId,
      sku: product.sku,
      name: product.name,
      qty: line.qty,
      basePrice: rule.basePrice as number,
      vatRate: rule.vatRate,
      weight: product.weight,
      isCriticalConsumable: rule.isCriticalConsumable,
      line: {
        id: product.line.id,
        name: product.line.name,
        countsTowardMix: product.line.countsTowardMix,
        tiers: product.line.tiers
      }
    });
  }
  return prepared;
}
