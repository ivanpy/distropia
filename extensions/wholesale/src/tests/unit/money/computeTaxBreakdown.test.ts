/**
 * T-2.49 (ADR-13, architecture §8): SIFEN tax breakdown of already-rounded
 * lines. `dSub*` are line totals including VAT per rate, `dBaseGrav*` the
 * taxable net bases, and `dTotOpe` their sum.
 */
import { computeTaxBreakdown, type TaxedLine } from '../../../services/money/computeTaxBreakdown.js';
import { computeVat } from '../../../services/money/computeVat.js';

const line = (vatRate: TaxedLine['vatRate'], net: number): TaxedLine => ({ vatRate, net, vat: computeVat(net, vatRate, 0) });

describe('computeTaxBreakdown (T-2.49)', () => {
  it('reproduces the specification example: products 10.000.000 + freight 500.000 at 10 %', () => {
    const products = line('10', 10_000_000);
    const freight = line('10', 500_000); // FLETE_LOGISTICA service line
    expect(computeTaxBreakdown([products, freight])).toEqual({
      dSubExe: 0,
      dSub5: 0,
      dSub10: 11_550_000,
      dBaseGrav5: 0,
      dBaseGrav10: 10_500_000,
      dIVA5: 0,
      dIVA10: 1_050_000,
      dTotOpe: 11_550_000
    });
  });

  it('splits a 10 % / 5 % / exempt mix by rate', () => {
    const lines = [line('10', 2_000_000), line('10', 333_333), line('5', 1_000_000), line('5', 12_345), line('exempt', 750_000)];
    // VAT per item: 200.000, 33.333, 50.000, 617 (617.25), 0
    expect(computeTaxBreakdown(lines)).toEqual({
      dSubExe: 750_000,
      dSub5: 1_000_000 + 50_000 + 12_345 + 617,
      dSub10: 2_000_000 + 200_000 + 333_333 + 33_333,
      dBaseGrav5: 1_012_345,
      dBaseGrav10: 2_333_333,
      dIVA5: 50_617,
      dIVA10: 233_333,
      dTotOpe: 750_000 + 1_062_962 + 2_566_666
    });
  });

  it('keeps dTotOpe = dSubExe + dSub5 + dSub10 and bases + VAT = subtotals', () => {
    const lines = [line('10', 1_234_567), line('5', 7_654_321), line('exempt', 99_999), line('10', 1)];
    const b = computeTaxBreakdown(lines);
    expect(b.dTotOpe).toBe(b.dSubExe + b.dSub5 + b.dSub10);
    expect(b.dSub10).toBe(b.dBaseGrav10 + b.dIVA10);
    expect(b.dSub5).toBe(b.dBaseGrav5 + b.dIVA5);
    expect(b.dTotOpe).toBe(lines.reduce((sum, l) => sum + l.net + l.vat, 0));
  });

  it('returns zeros for no lines', () => {
    expect(computeTaxBreakdown([])).toEqual({
      dSubExe: 0,
      dSub5: 0,
      dSub10: 0,
      dBaseGrav5: 0,
      dBaseGrav10: 0,
      dIVA5: 0,
      dIVA10: 0,
      dTotOpe: 0
    });
  });

  it('refuses an exempt line that carries VAT', () => {
    expect(() => computeTaxBreakdown([{ vatRate: 'exempt', net: 100, vat: 10 }])).toThrow(/exempt/);
  });

  it('refuses an unknown VAT rate', () => {
    expect(() => computeTaxBreakdown([{ vatRate: '21' as never, net: 100, vat: 21 }])).toThrow(/VAT rate/);
  });

  it('keeps cents when the currency has them (sums stay exact)', () => {
    const lines: TaxedLine[] = [
      { vatRate: '10', net: 0.1, vat: 0.01 },
      { vatRate: '10', net: 0.2, vat: 0.02 }
    ];
    const b = computeTaxBreakdown(lines, 2);
    expect(b.dBaseGrav10).toBe(0.3);
    expect(b.dSub10).toBe(0.33);
    expect(b.dTotOpe).toBe(0.33);
  });
});
