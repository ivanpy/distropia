/**
 * Per-item VAT (T-2.46, RF-26, RNF-10).
 *
 * Wholesale prices are net of VAT; the VAT of each item is computed from its
 * own net amount and rounded to the currency decimals on its own. Totals are
 * sums of rounded items, never a rounded sum, so the quote, the core order,
 * the invoice and SIFEN agree to the unit (rejection `4022` otherwise).
 *
 * Pure: no I/O.
 */
import type { VatRate } from '../rule/ruleRow.js';
import { roundToCurrency } from './roundToCurrency.js';

export type { VatRate };

export const VAT_PERCENT: Readonly<Record<VatRate, number>> = Object.freeze({ '10': 10, '5': 5, exempt: 0 });

/** VAT of one item's net amount, rounded to `decimals`. */
export function computeVat(net: number, vatRate: VatRate, decimals: number): number {
  if (!Object.prototype.hasOwnProperty.call(VAT_PERCENT, vatRate)) {
    throw new Error(`computeVat: unknown VAT rate ${JSON.stringify(vatRate)}`);
  }
  return roundToCurrency((net * VAT_PERCENT[vatRate]) / 100, decimals);
}
