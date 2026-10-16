/**
 * Currency rounding for quote amounts (T-2.46, RNF-10).
 *
 * Amounts are rounded half-up to the decimals of the store currency
 * (PYG = 0). Halves round away from zero, so negative amounts mirror
 * positive ones. Binary floating-point noise from multiplications
 * (`1.005 * 100 = 100.49999999999999`) is absorbed by reading the scaled
 * value at 15 significant digits before rounding. That is exact while the
 * integer digits plus `decimals` stay within 15 — every `numeric(14,2)`
 * amount at 0 or 2 decimals; larger scales lose the guarantee for amounts
 * of 10^(15 − decimals) and above.
 *
 * Pure: no I/O.
 */

const MAX_DECIMALS = 6;

export function roundToCurrency(value: number, decimals: number): number {
  if (!Number.isFinite(value)) {
    throw new Error(`roundToCurrency: amount must be finite, got ${value}`);
  }
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > MAX_DECIMALS) {
    throw new Error(`roundToCurrency: decimals must be an integer from 0 to ${MAX_DECIMALS}, got ${decimals}`);
  }
  const factor = 10 ** decimals;
  const scaled = Number((Math.abs(value) * factor).toPrecision(15));
  const rounded = (Math.sign(value) * Math.floor(scaled + 0.5)) / factor;
  // `-0` would print as "0" but fails Object.is / toEqual against 0.
  return rounded === 0 ? 0 : rounded;
}

/**
 * Minor-unit decimals of an ISO 4217 currency, as `Intl` knows them
 * (PYG → 0, USD → 2). Throws on a code `Intl` refuses.
 */
export function currencyDecimals(currency: string): number {
  try {
    return new Intl.NumberFormat('en', { style: 'currency', currency: currency.toUpperCase() }).resolvedOptions()
      .maximumFractionDigits as number;
  } catch {
    throw new Error(`currencyDecimals: unknown currency code ${JSON.stringify(currency)}`);
  }
}
