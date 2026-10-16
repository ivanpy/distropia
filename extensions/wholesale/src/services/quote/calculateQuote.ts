/**
 * Quote calculation (T-2.45, architecture §8, RF-26 … RF-30, RNF-10).
 *
 * Pure: receives the items already loaded (`loadQuoteProducts`) and returns
 * the snapshot. Used by `createQuote` (persistence) and by
 * `Cart.wholesaleWarnings` (codes only, never amounts).
 *
 * 1. Tier per item from its product line: the last tier whose `fromQty` the
 *    quantity reaches. The net UNIT price is rounded first and then
 *    multiplied by the quantity, so the core cart (unit price × qty)
 *    reproduces the line total when the order is created (ADR-13).
 * 2. Mix rule (RF-27), evaluated once on the provisional nets: when the
 *    share of lines that count toward the mix is below `mixMinShare`, every
 *    critical consumable sitting on its line's maximum tier (last tier, with
 *    a discount) is repriced at base price.
 * 3. Minimum order (RF-28, G-11) on the final net products total (after the
 *    mix rule, before VAT, without freight).
 * 4. VAT per item, rounded per item (RNF-10).
 * 5. Weight and freight label (RF-30, G-6): any product without weight, or
 *    no threshold configured, means special freight.
 * 6. SIFEN breakdown over PRODUCT lines only; `setQuoteFreight` adds the
 *    `FLETE_LOGISTICA` line later and recomputes it.
 *
 * Quantities are validated before (`validateQuantity`); this module only
 * refuses inputs that would make the arithmetic meaningless.
 */
import type { LineTier } from '../line/validateLineTiers.js';
import { computeTaxBreakdown, type TaxBreakdown } from '../money/computeTaxBreakdown.js';
import { computeVat, VAT_PERCENT, type VatRate } from '../money/computeVat.js';
import { roundToCurrency } from '../money/roundToCurrency.js';

export interface QuoteInputLine {
  /** Internal id (`wholesale_product_line_id`). */
  id: number;
  name: string;
  countsTowardMix: boolean;
  /** Ordered by `fromQty` ascending (as `validateLineTiers` stores them). */
  tiers: readonly LineTier[];
}

export interface QuoteInputItem {
  productId: number;
  sku: string;
  name: string;
  qty: number;
  /** Net of VAT, store currency. */
  basePrice: number;
  vatRate: VatRate;
  /** `product.weight` in the store weight unit; `null` when unknown. */
  weight: number | null;
  isCriticalConsumable: boolean;
  line: QuoteInputLine;
}

export interface QuoteConfig {
  /** Currency decimals (PYG = 0). */
  decimals: number;
  /** RF-27, share in [0, 1]. */
  mixMinShare: number;
  /** RF-28, net products total. */
  minimumNetTotal: number;
  /** RF-30, in the STORE weight unit (see `weightThreshold.ts`); `null` = always special freight. */
  freeShippingMaxWeight: number | null;
}

export type FreightLabel = 'free' | 'special';

export interface QuoteLine {
  productId: number;
  sku: string;
  name: string;
  qty: number;
  vatRate: VatRate;
  basePrice: number;
  weight: number | null;
  lineId: number;
  /** Tier the quantity reaches (kept when the mix rule removed its discount). */
  tier: LineTier | null;
  /** Discount actually applied (0 when the mix rule repriced the item). */
  discountPercent: number;
  /** Net unit price after discount, rounded. */
  unitNet: number;
  /** `unitNet × qty`. */
  net: number;
  /** VAT of the item, rounded on its own. */
  vat: number;
  /** `net + vat`. */
  total: number;
  /** True when RF-27 removed this item's maximum-tier discount. */
  mixRuleApplied: boolean;
}

export interface QuoteCalculation {
  lines: QuoteLine[];
  /** Σ net of products (the RF-28 minimum applies to it). */
  netTotal: number;
  vatTotal: number;
  /** `taxBreakdown.dTotOpe` (products only until freight is quoted). */
  grandTotal: number;
  taxBreakdown: TaxBreakdown;
  minimumMet: boolean;
  mixShareMet: boolean;
  mixRuleApplied: boolean;
  /** Store weight unit; `null` when any product has no weight. */
  totalWeight: number | null;
  freightLabel: FreightLabel;
}

/** `product.weight` is `decimal(12,4)`: weight sums are exact at 4 decimals. */
const WEIGHT_DECIMALS = 4;

function assertConfig(cfg: QuoteConfig): void {
  const fail = (what: string): never => {
    throw new Error(`calculateQuote: invalid configuration ${what}`);
  };
  if (!Number.isFinite(cfg.mixMinShare) || cfg.mixMinShare < 0 || cfg.mixMinShare > 1) {
    fail(`mixMinShare ${cfg.mixMinShare}`);
  }
  if (!Number.isFinite(cfg.minimumNetTotal) || cfg.minimumNetTotal < 0) {
    fail(`minimumNetTotal ${cfg.minimumNetTotal}`);
  }
  if (cfg.freeShippingMaxWeight !== null && (!Number.isFinite(cfg.freeShippingMaxWeight) || cfg.freeShippingMaxWeight < 0)) {
    fail(`freeShippingMaxWeight ${cfg.freeShippingMaxWeight}`);
  }
  // `decimals` is validated by roundToCurrency.
  roundToCurrency(0, cfg.decimals);
}

function assertItem(it: QuoteInputItem): void {
  const fail = (what: string): never => {
    throw new Error(`calculateQuote: product ${it.productId} has an invalid ${what}`);
  };
  if (!Number.isSafeInteger(it.qty) || it.qty < 1) {
    fail(`qty ${it.qty}`);
  }
  if (!Number.isFinite(it.basePrice) || it.basePrice < 0) {
    fail(`basePrice ${it.basePrice}`);
  }
  if (it.weight !== null && (!Number.isFinite(it.weight) || it.weight < 0)) {
    fail(`weight ${it.weight}`);
  }
  if (!Object.prototype.hasOwnProperty.call(VAT_PERCENT, it.vatRate)) {
    fail(`vatRate ${JSON.stringify(it.vatRate)}`);
  }
  const { tiers } = it.line;
  for (let i = 0; i < tiers.length; i += 1) {
    const t = tiers[i];
    if (
      !Number.isFinite(t.fromQty) ||
      !Number.isFinite(t.discountPercent) ||
      t.discountPercent < 0 ||
      t.discountPercent > 100 ||
      (i > 0 && t.fromQty <= tiers[i - 1].fromQty)
    ) {
      fail(`line tiers (line ${it.line.id} must be sorted by fromQty with discounts in 0..100)`);
    }
  }
}

/** Index of the last tier the quantity reaches, or -1. */
const tierIndexFor = (it: QuoteInputItem): number => {
  for (let i = it.line.tiers.length - 1; i >= 0; i -= 1) {
    if (it.line.tiers[i].fromQty <= it.qty) {
      return i;
    }
  }
  return -1;
};

export function calculateQuote(items: readonly QuoteInputItem[], cfg: QuoteConfig): QuoteCalculation {
  assertConfig(cfg);
  items.forEach(assertItem);
  const round = (n: number): number => roundToCurrency(n, cfg.decimals);
  const unitNetFor = (it: QuoteInputItem, discount: number): number => round((it.basePrice * (100 - discount)) / 100);

  // 1. Tier per item; unit net rounded before multiplying.
  const provisional = items.map((it) => {
    const tierIndex = tierIndexFor(it);
    const tier = tierIndex >= 0 ? it.line.tiers[tierIndex] : null;
    const discountPercent = tier?.discountPercent ?? 0;
    const unitNet = unitNetFor(it, discountPercent);
    return { it, tierIndex, tier, discountPercent, unitNet, net: round(unitNet * it.qty) };
  });

  // 2. Mix rule, once, on the provisional nets.
  const provisionalNet = round(provisional.reduce((sum, l) => sum + l.net, 0));
  const mixNet = round(provisional.filter((l) => l.it.line.countsTowardMix).reduce((sum, l) => sum + l.net, 0));
  const mixShareMet = provisionalNet > 0 && mixNet / provisionalNet >= cfg.mixMinShare;

  const lines: QuoteLine[] = provisional.map((l) => {
    const { it } = l;
    const lastIndex = it.line.tiers.length - 1;
    const repriced =
      !mixShareMet &&
      it.isCriticalConsumable &&
      l.tierIndex === lastIndex &&
      lastIndex >= 0 &&
      it.line.tiers[lastIndex].discountPercent > 0;
    const discountPercent = repriced ? 0 : l.discountPercent;
    const unitNet = repriced ? unitNetFor(it, 0) : l.unitNet;
    const net = repriced ? round(unitNet * it.qty) : l.net;
    // 4. VAT per item.
    const vat = computeVat(net, it.vatRate, cfg.decimals);
    return {
      productId: it.productId,
      sku: it.sku,
      name: it.name,
      qty: it.qty,
      vatRate: it.vatRate,
      basePrice: it.basePrice,
      weight: it.weight,
      lineId: it.line.id,
      tier: l.tier === null ? null : { ...l.tier },
      discountPercent,
      unitNet,
      net,
      vat,
      total: round(net + vat),
      mixRuleApplied: repriced
    };
  });

  // 3. Minimum on the final net products total.
  const netTotal = round(lines.reduce((sum, l) => sum + l.net, 0));
  const vatTotal = round(lines.reduce((sum, l) => sum + l.vat, 0));

  // 5. Weight and freight label.
  const missingWeight = items.some((it) => it.weight === null);
  const totalWeight = missingWeight
    ? null
    : roundToCurrency(
        items.reduce((sum, it) => sum + (it.weight as number) * it.qty, 0),
        WEIGHT_DECIMALS
      );
  const freightLabel: FreightLabel =
    totalWeight !== null && cfg.freeShippingMaxWeight !== null && totalWeight <= cfg.freeShippingMaxWeight
      ? 'free'
      : 'special';

  // 6. SIFEN breakdown of the product lines.
  const taxBreakdown = computeTaxBreakdown(
    lines.map((l) => ({ vatRate: l.vatRate, net: l.net, vat: l.vat })),
    cfg.decimals
  );

  return {
    lines,
    netTotal,
    vatTotal,
    grandTotal: taxBreakdown.dTotOpe,
    taxBreakdown,
    minimumMet: netTotal >= cfg.minimumNetTotal,
    mixShareMet,
    mixRuleApplied: lines.some((l) => l.mixRuleApplied),
    totalWeight,
    freightLabel
  };
}
