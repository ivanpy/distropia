/**
 * T-2.46 (RNF-10): money is rounded to the currency decimals (PYG = 0),
 * half-up, and VAT is rounded per item, so the VAT total is the sum of the
 * rounded item amounts.
 */
import { computeVat, VAT_PERCENT } from '../../../services/money/computeVat.js';
import { currencyDecimals, roundToCurrency } from '../../../services/money/roundToCurrency.js';

describe('roundToCurrency (T-2.46)', () => {
  it.each([
    [1234.4, 0, 1234],
    [1234.5, 0, 1235],
    [1234.6, 0, 1235],
    [0.5, 0, 1],
    [0, 0, 0],
    [10.125, 2, 10.13],
    [1.005, 2, 1.01],
    [2.675, 2, 2.68]
  ])('rounds %d to %i decimals as %d (half-up)', (value, decimals, expected) => {
    expect(roundToCurrency(value, decimals)).toBe(expected);
  });

  it('rounds negative halves away from zero (symmetric half-up)', () => {
    expect(roundToCurrency(-1234.5, 0)).toBe(-1235);
    expect(roundToCurrency(-1.005, 2)).toBe(-1.01);
  });

  it('never returns negative zero', () => {
    expect(Object.is(roundToCurrency(-0.4, 0), 0)).toBe(true);
  });

  it('absorbs binary floating-point noise of products', () => {
    // 0.1 * 3 = 0.30000000000000004; 1.15 * 100 = 114.99999999999999
    expect(roundToCurrency(0.1 * 3, 2)).toBe(0.3);
    expect(roundToCurrency(1.15 * 100, 0)).toBe(115);
  });

  it.each([NaN, Infinity, -Infinity])('refuses the non-finite amount %d', (value) => {
    expect(() => roundToCurrency(value, 0)).toThrow(/finite/);
  });

  it.each([-1, 1.5, 7])('refuses %d decimals', (decimals) => {
    expect(() => roundToCurrency(1, decimals)).toThrow(/decimals/);
  });

  it('knows PYG has no decimals and defaults other currencies through Intl', () => {
    expect(currencyDecimals('PYG')).toBe(0);
    expect(currencyDecimals('pyg')).toBe(0);
    expect(currencyDecimals('USD')).toBe(2);
    expect(currencyDecimals('JPY')).toBe(0);
  });

  it('refuses an unknown currency code', () => {
    expect(() => currencyDecimals('NOT-A-CODE')).toThrow(/currency/);
  });
});

describe('computeVat (T-2.46)', () => {
  it('maps the VAT rates to their percentages', () => {
    expect(VAT_PERCENT).toEqual({ '10': 10, '5': 5, exempt: 0 });
  });

  it.each([
    ['10', 10_000_000, 1_000_000],
    ['5', 1_000_000, 50_000],
    ['exempt', 1_000_000, 0],
    ['10', 12_345, 1_235],
    ['5', 12_345, 617],
    ['10', 12_344, 1_234]
  ] as const)('computes VAT %s %% of %i as %i in PYG', (rate, net, vat) => {
    expect(computeVat(net, rate, 0)).toBe(vat);
  });

  it('rounds VAT per item: the total is the sum of the rounded items', () => {
    // Three items whose unrounded VAT is 1234.5 each: per-item rounding gives
    // 3 × 1235 = 3705, while rounding the sum (3703.5) would give 3704.
    const nets = [12_345, 12_345, 12_345];
    const vats = nets.map((net) => computeVat(net, '10', 0));
    const vatTotal = vats.reduce((sum, vat) => sum + vat, 0);
    expect(vats).toEqual([1_235, 1_235, 1_235]);
    expect(vatTotal).toBe(3_705);
    expect(vatTotal).not.toBe(roundToCurrency((nets.reduce((s, n) => s + n, 0) * 10) / 100, 0));
  });

  it('keeps the currency decimals when the currency has them', () => {
    expect(computeVat(10.05, '10', 2)).toBe(1.01);
  });

  it('refuses an unknown VAT rate', () => {
    expect(() => computeVat(100, '21' as never, 0)).toThrow(/VAT rate/);
  });
});
