/**
 * SIFEN tax breakdown (T-2.49, ADR-13, architecture §8).
 *
 * Input lines are already rounded (net and VAT per line, RNF-10): product
 * lines from `calculateQuote` and, once the seller quotes it, the
 * `FLETE_LOGISTICA` service line. The breakdown only adds them up:
 *
 * - `dSubExe`, `dSub5`, `dSub10`: line totals including VAT, per rate;
 * - `dBaseGrav5`, `dBaseGrav10`: taxable net bases;
 * - `dIVA5`, `dIVA10`: VAT per rate;
 * - `dTotOpe = dSubExe + dSub5 + dSub10`: the total of the WhatsApp quote,
 *   the core order, the invoice and the payment.
 *
 * Pure: no I/O.
 */
import { VAT_PERCENT, type VatRate } from './computeVat.js';
import { roundToCurrency } from './roundToCurrency.js';

export interface TaxedLine {
  vatRate: VatRate;
  /** Net amount of the line (unit net × quantity), rounded. */
  net: number;
  /** VAT of the line, rounded on its own. */
  vat: number;
}

export interface TaxBreakdown {
  dSubExe: number;
  dSub5: number;
  dSub10: number;
  dBaseGrav5: number;
  dBaseGrav10: number;
  dIVA5: number;
  dIVA10: number;
  dTotOpe: number;
}

/**
 * Breakdown of the given lines. `decimals` (currency decimals, PYG = 0) only
 * clears binary floating-point noise from the sums of rounded amounts; it
 * never changes their value.
 */
export function computeTaxBreakdown(lines: readonly TaxedLine[], decimals = 0): TaxBreakdown {
  for (const l of lines) {
    if (!Object.prototype.hasOwnProperty.call(VAT_PERCENT, l.vatRate)) {
      throw new Error(`computeTaxBreakdown: unknown VAT rate ${JSON.stringify(l.vatRate)}`);
    }
    if (l.vatRate === 'exempt' && l.vat !== 0) {
      throw new Error(`computeTaxBreakdown: an exempt line carries VAT ${l.vat}`);
    }
  }
  const sum = (rate: VatRate, pick: (l: TaxedLine) => number): number =>
    roundToCurrency(
      lines.filter((l) => l.vatRate === rate).reduce((total, l) => total + pick(l), 0),
      decimals
    );

  const dSubExe = sum('exempt', (l) => l.net);
  const dSub5 = sum('5', (l) => l.net + l.vat);
  const dSub10 = sum('10', (l) => l.net + l.vat);
  return {
    dSubExe,
    dSub5,
    dSub10,
    dBaseGrav5: sum('5', (l) => l.net),
    dBaseGrav10: sum('10', (l) => l.net),
    dIVA5: sum('5', (l) => l.vat),
    dIVA10: sum('10', (l) => l.vat),
    dTotOpe: roundToCurrency(dSubExe + dSub5 + dSub10, decimals)
  };
}
