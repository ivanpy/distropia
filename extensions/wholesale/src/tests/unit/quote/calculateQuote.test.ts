/**
 * T-2.45 (architecture §8, RF-26 … RF-30, RNF-10, G-6, G-11): pure quote
 * calculation — tier per line, mix rule, minimum on the final net products
 * total, unit net rounded before multiplying, per-item VAT, weight, freight
 * label and SIFEN breakdown.
 *
 * Tier tables come from CIRCUITO §3.B; base prices, weights and the
 * consumables line are invented for the tests.
 */
import type { LineTier } from '../../../services/line/validateLineTiers.js';
import { calculateQuote, type QuoteConfig, type QuoteInputItem } from '../../../services/quote/calculateQuote.js';

const HAND_TOOLS_TIERS: LineTier[] = [
  { fromQty: 1, discountPercent: 0, label: 'Precio Base Mayorista' },
  { fromQty: 12, discountPercent: 10, label: 'Precio Mayorista Bronce' },
  { fromQty: 48, discountPercent: 20, label: 'Precio Distribuidor Oro' }
];
const MACHINES_TIERS: LineTier[] = [
  { fromQty: 1, discountPercent: 0, label: 'Precio Base Maquinaria' },
  { fromQty: 2, discountPercent: 5, label: 'Escala Obra / Contratista' },
  { fromQty: 6, discountPercent: 12, label: 'Escala Mayorista Industrial' }
];
const CONSUMABLES_TIERS: LineTier[] = [
  { fromQty: 1, discountPercent: 0, label: null },
  { fromQty: 100, discountPercent: 15, label: 'Caja cerrada' }
];

const HAND_TOOLS = { id: 1, name: 'Herramientas Manuales', countsTowardMix: true, tiers: HAND_TOOLS_TIERS };
const MACHINES = { id: 2, name: 'Máquinas de Construcción', countsTowardMix: true, tiers: MACHINES_TIERS };
const CONSUMABLES = { id: 3, name: 'Consumibles', countsTowardMix: false, tiers: CONSUMABLES_TIERS };

const CONFIG: QuoteConfig = { decimals: 0, mixMinShare: 0.15, minimumNetTotal: 5_000_000, freeShippingMaxWeight: 1_000 };

let nextId = 1;
const item = (overrides: Partial<QuoteInputItem> & Pick<QuoteInputItem, 'line' | 'qty' | 'basePrice'>): QuoteInputItem => {
  const productId = nextId++;
  return {
    productId,
    sku: `SKU-${productId}`,
    name: `Product ${productId}`,
    vatRate: '10',
    weight: 1,
    isCriticalConsumable: false,
    ...overrides
  };
};

const handTool = (qty: number, basePrice = 85_000) =>
  item({ sku: 'HERR-MAN-01', line: HAND_TOOLS, qty, basePrice, weight: 0.8 });
const machine = (qty: number, basePrice = 3_500_000) =>
  item({ sku: 'MAQ-CON-05', line: MACHINES, qty, basePrice, weight: 95 });
const disc = (qty: number, basePrice = 50_000) =>
  item({ sku: 'DISCO-115', line: CONSUMABLES, qty, basePrice, weight: 0.1, isCriticalConsumable: true });

describe('calculateQuote — CIRCUITO §3.B tiers (T-2.45)', () => {
  it.each([
    [1, 0, 'Precio Base Mayorista'],
    [11, 0, 'Precio Base Mayorista'],
    [12, 10, 'Precio Mayorista Bronce'],
    [47, 10, 'Precio Mayorista Bronce'],
    [48, 20, 'Precio Distribuidor Oro'],
    [60, 20, 'Precio Distribuidor Oro']
  ])('hand tools: %i units take %i %% (%s)', (qty, discount, label) => {
    const [line] = calculateQuote([handTool(qty)], CONFIG).lines;
    expect(line.discountPercent).toBe(discount);
    expect(line.tier?.label).toBe(label);
    expect(line.unitNet).toBe((85_000 * (100 - discount)) / 100);
  });

  it.each([
    [1, 0, 'Precio Base Maquinaria'],
    [2, 5, 'Escala Obra / Contratista'],
    [5, 5, 'Escala Obra / Contratista'],
    [6, 12, 'Escala Mayorista Industrial']
  ])('machines: %i units take %i %% (%s)', (qty, discount, label) => {
    const [line] = calculateQuote([machine(qty)], CONFIG).lines;
    expect(line.discountPercent).toBe(discount);
    expect(line.tier?.label).toBe(label);
  });

  it('prices the CIRCUITO example quote end to end', () => {
    // 60 × HERR-MAN-01 at 20 % ("Distribuidor Oro") + 2 × MAQ-CON-05 at 5 %.
    const quote = calculateQuote([handTool(60), machine(2)], CONFIG);
    expect(quote.lines.map((l) => [l.sku, l.qty, l.discountPercent, l.unitNet, l.net, l.vat])).toEqual([
      ['HERR-MAN-01', 60, 20, 68_000, 4_080_000, 408_000],
      ['MAQ-CON-05', 2, 5, 3_325_000, 6_650_000, 665_000]
    ]);
    expect(quote.netTotal).toBe(10_730_000);
    expect(quote.vatTotal).toBe(1_073_000);
    expect(quote.grandTotal).toBe(11_803_000);
    expect(quote.taxBreakdown).toEqual({
      dSubExe: 0,
      dSub5: 0,
      dSub10: 11_803_000,
      dBaseGrav5: 0,
      dBaseGrav10: 10_730_000,
      dIVA5: 0,
      dIVA10: 1_073_000,
      dTotOpe: 11_803_000
    });
    expect(quote.minimumMet).toBe(true);
    expect(quote.mixShareMet).toBe(true);
    expect(quote.mixRuleApplied).toBe(false);
    expect(quote.totalWeight).toBe(238); // 60 × 0,8 + 2 × 95
    expect(quote.freightLabel).toBe('free');
  });

  it('applies no discount below the first tier and with an empty tier table', () => {
    const noTiers = { id: 9, name: 'Sin tramos', countsTowardMix: false, tiers: [] };
    const sparse = { id: 10, name: 'Desde 10', countsTowardMix: false, tiers: [{ fromQty: 10, discountPercent: 5, label: null }] };
    const quote = calculateQuote(
      [item({ line: noTiers, qty: 3, basePrice: 1_000 }), item({ line: sparse, qty: 9, basePrice: 1_000 })],
      CONFIG
    );
    expect(quote.lines.map((l) => [l.tier, l.discountPercent, l.net])).toEqual([
      [null, 0, 3_000],
      [null, 0, 9_000]
    ]);
  });
});

describe('calculateQuote — rounding (T-2.45, RNF-10)', () => {
  it('rounds the net unit price before multiplying by the quantity', () => {
    // 33.333 × 0,9 = 29.999,7 → 30.000 per unit → 14 units = 420.000
    // (rounding after multiplying would give round(419.995,8) = 419.996).
    const [line] = calculateQuote([item({ line: HAND_TOOLS, qty: 14, basePrice: 33_333 })], CONFIG).lines;
    expect(line.unitNet).toBe(30_000);
    expect(line.net).toBe(420_000);
  });

  it('rounds VAT per item and sums rounded items', () => {
    const items = [
      item({ line: CONSUMABLES, qty: 1, basePrice: 12_345 }),
      item({ line: CONSUMABLES, qty: 1, basePrice: 12_345 }),
      item({ line: CONSUMABLES, qty: 1, basePrice: 12_345, vatRate: '5' }),
      item({ line: CONSUMABLES, qty: 1, basePrice: 12_345, vatRate: 'exempt' })
    ];
    const quote = calculateQuote(items, CONFIG);
    expect(quote.lines.map((l) => l.vat)).toEqual([1_235, 1_235, 617, 0]);
    expect(quote.vatTotal).toBe(3_087);
    expect(quote.taxBreakdown).toMatchObject({ dIVA10: 2_470, dIVA5: 617, dSubExe: 12_345 });
    expect(quote.grandTotal).toBe(quote.netTotal + quote.vatTotal);
    expect(quote.grandTotal).toBe(quote.lines.reduce((s, l) => s + l.total, 0));
  });
});

describe('calculateQuote — mix rule (T-2.45, RF-27)', () => {
  it('reprices only critical consumables at the maximum tier when the mix share is below 15 %', () => {
    const atMax = disc(100); // 100 × 42.500 = 4.250.000 at 15 %
    const belowMax = disc(50); // 50 × 50.000 = 2.500.000, first tier
    const nonCriticalAtMax = item({ line: CONSUMABLES, qty: 100, basePrice: 10_000 }); // 100 × 8.500
    const tool = handTool(12); // 12 × 76.500 = 918.000, counts toward the mix
    // provisional net 8.518.000; mix 918.000 → 10,8 % < 15 %
    const quote = calculateQuote([atMax, belowMax, nonCriticalAtMax, tool], CONFIG);

    expect(quote.mixShareMet).toBe(false);
    expect(quote.mixRuleApplied).toBe(true);
    expect(quote.lines.map((l) => [l.discountPercent, l.unitNet, l.net, l.mixRuleApplied])).toEqual([
      [0, 50_000, 5_000_000, true],
      [0, 50_000, 2_500_000, false],
      [15, 8_500, 850_000, false],
      [10, 76_500, 918_000, false]
    ]);
    // The repriced line keeps the tier its quantity reached, for the detail note.
    expect(quote.lines[0].tier?.label).toBe('Caja cerrada');
    expect(quote.netTotal).toBe(5_000_000 + 2_500_000 + 850_000 + 918_000);
    expect(quote.lines[0].vat).toBe(500_000);
  });

  it('keeps the maximum-tier discount when the mix share reaches 15 % exactly', () => {
    // consumable 100 × 42.500 = 4.250.000; tools 750.000 → 750.000 / 5.000.000 = 15 %
    const quote = calculateQuote([disc(100), item({ line: HAND_TOOLS, qty: 1, basePrice: 750_000 })], CONFIG);
    expect(quote.mixShareMet).toBe(true);
    expect(quote.mixRuleApplied).toBe(false);
    expect(quote.lines[0]).toMatchObject({ discountPercent: 15, net: 4_250_000, mixRuleApplied: false });
  });

  it('reprices when the share is just below 15 %', () => {
    const quote = calculateQuote([disc(100), item({ line: HAND_TOOLS, qty: 1, basePrice: 749_999 })], CONFIG);
    expect(quote.mixShareMet).toBe(false);
    expect(quote.lines[0]).toMatchObject({ discountPercent: 0, net: 5_000_000, mixRuleApplied: true });
  });

  it('does not apply the rule to a maximum tier without discount', () => {
    const flat = { id: 11, name: 'Plana', countsTowardMix: false, tiers: [{ fromQty: 1, discountPercent: 0, label: null }] };
    const quote = calculateQuote([item({ line: flat, qty: 5, basePrice: 1_000_000, isCriticalConsumable: true })], CONFIG);
    expect(quote.mixShareMet).toBe(false);
    expect(quote.mixRuleApplied).toBe(false);
  });

  it('reads the share threshold from the configuration', () => {
    const quote = calculateQuote([disc(100), item({ line: HAND_TOOLS, qty: 1, basePrice: 750_000 })], {
      ...CONFIG,
      mixMinShare: 0.2
    });
    expect(quote.mixRuleApplied).toBe(true);
  });
});

describe('calculateQuote — minimum order (T-2.45, RF-28, G-11)', () => {
  it('meets the minimum with a net products total exactly equal to it', () => {
    const quote = calculateQuote([item({ line: CONSUMABLES, qty: 1, basePrice: 5_000_000 })], CONFIG);
    expect(quote.netTotal).toBe(5_000_000);
    expect(quote.minimumMet).toBe(true);
  });

  it('misses the minimum one unit below it, whatever the VAT adds', () => {
    const quote = calculateQuote([item({ line: CONSUMABLES, qty: 1, basePrice: 4_999_999 })], CONFIG);
    expect(quote.grandTotal).toBeGreaterThan(5_000_000);
    expect(quote.minimumMet).toBe(false);
  });

  it('checks the minimum after the mix rule (final net total)', () => {
    // Before the rule: 100 × 42.500 + 700.000 = 4.950.000 (< 5.000.000);
    // the rule reprices the discs to 5.000.000 → 5.700.000 (≥ minimum).
    const quote = calculateQuote([disc(100), item({ line: HAND_TOOLS, qty: 1, basePrice: 700_000 })], CONFIG);
    expect(quote.mixRuleApplied).toBe(true);
    expect(quote.netTotal).toBe(5_700_000);
    expect(quote.minimumMet).toBe(true);
  });
});

describe('calculateQuote — weight and freight label (T-2.45, RF-30, G-6)', () => {
  it('ships free when every product has weight and the total is within the threshold', () => {
    const quote = calculateQuote([machine(10)], CONFIG); // 950 ≤ 1.000
    expect(quote.totalWeight).toBe(950);
    expect(quote.freightLabel).toBe('free');
  });

  it('ships free at exactly the threshold and special above it', () => {
    const exact = calculateQuote([item({ line: CONSUMABLES, qty: 4, basePrice: 1, weight: 250 })], CONFIG);
    expect(exact.totalWeight).toBe(1_000);
    expect(exact.freightLabel).toBe('free');
    const above = calculateQuote([item({ line: CONSUMABLES, qty: 4, basePrice: 1, weight: 250.0001 })], CONFIG);
    expect(above.freightLabel).toBe('special');
  });

  it('takes special freight when any product has no weight (null weight)', () => {
    const quote = calculateQuote([machine(1), item({ line: CONSUMABLES, qty: 1, basePrice: 1, weight: null })], CONFIG);
    expect(quote.totalWeight).toBeNull();
    expect(quote.freightLabel).toBe('special');
  });

  it('takes special freight for every quote when no threshold is configured (null threshold)', () => {
    const quote = calculateQuote([machine(1)], { ...CONFIG, freeShippingMaxWeight: null });
    expect(quote.totalWeight).toBe(95);
    expect(quote.freightLabel).toBe('special');
  });

  it('sums weights without floating-point drift (product.weight has 4 decimals)', () => {
    const quote = calculateQuote([item({ line: CONSUMABLES, qty: 3, basePrice: 1, weight: 0.1 })], {
      ...CONFIG,
      freeShippingMaxWeight: 0.3
    });
    expect(quote.totalWeight).toBe(0.3);
    expect(quote.freightLabel).toBe('free');
  });
});

describe('calculateQuote — input guards (T-2.45)', () => {
  it.each([0, -1, 1.5, NaN])('refuses the quantity %d', (qty) => {
    expect(() => calculateQuote([item({ line: CONSUMABLES, qty, basePrice: 1 })], CONFIG)).toThrow(/qty/);
  });

  it.each([-1, NaN, Infinity])('refuses the base price %d', (basePrice) => {
    expect(() => calculateQuote([item({ line: CONSUMABLES, qty: 1, basePrice })], CONFIG)).toThrow(/basePrice/);
  });

  it('refuses a negative weight', () => {
    expect(() => calculateQuote([item({ line: CONSUMABLES, qty: 1, basePrice: 1, weight: -1 })], CONFIG)).toThrow(
      /weight/
    );
  });

  it('refuses tiers that are not sorted by quantity', () => {
    const unsorted = { id: 12, name: 'X', countsTowardMix: false, tiers: [MACHINES_TIERS[1], MACHINES_TIERS[0]] };
    expect(() => calculateQuote([item({ line: unsorted, qty: 1, basePrice: 1 })], CONFIG)).toThrow(/tiers/);
  });

  it.each([
    { mixMinShare: 1.5 },
    { mixMinShare: -0.1 },
    { minimumNetTotal: -1 },
    { freeShippingMaxWeight: -1 }
  ])('refuses the configuration %j', (bad) => {
    expect(() => calculateQuote([machine(1)], { ...CONFIG, ...bad })).toThrow(/calculateQuote/);
  });

  it('returns an empty quote that misses the minimum for no items', () => {
    const quote = calculateQuote([], CONFIG);
    expect(quote).toMatchObject({ lines: [], netTotal: 0, vatTotal: 0, grandTotal: 0, minimumMet: false, mixRuleApplied: false });
  });

  it('does not mutate its input', () => {
    const items = [disc(100), handTool(1)];
    const snapshot = JSON.parse(JSON.stringify(items));
    calculateQuote(items, CONFIG);
    expect(items).toEqual(snapshot);
  });
});
