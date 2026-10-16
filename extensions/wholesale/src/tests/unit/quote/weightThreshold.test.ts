/**
 * T-2.47 (RF-30, architecture §8): the free-shipping threshold is configured
 * in kg and converted to the store weight unit (`getWeightUnit()`: kg, g,
 * lb, oz) before it is compared with `product.weight` sums, which are stored
 * unit-less in that unit.
 *
 * The core setting module is mocked with a non-kg store unit, so the default
 * of `freeShippingMaxWeightInStoreUnit` provably reads `getWeightUnit()`
 * (R3-default-weight-unit-test-tautological).
 */
import { jest } from '@jest/globals';

const getWeightUnit = jest.fn(() => 'lb');
jest.unstable_mockModule('@evershop/evershop/setting/services', () => ({ getWeightUnit }));

const { freeShippingMaxWeightInStoreUnit, kgToWeightUnit, normalizeWeightUnit } = await import(
  '../../../services/quote/weightThreshold.js'
);

describe('kgToWeightUnit (T-2.47)', () => {
  it.each([
    ['kg', 100, 100],
    ['g', 100, 100_000],
    ['lb', 100, 100 / 0.45359237],
    ['oz', 100, 100 / 0.028349523125]
  ])('converts 100 kg to %s', (unit, kg, expected) => {
    expect(kgToWeightUnit(kg, unit)).toBeCloseTo(expected, 9);
  });

  it('keeps known reference values', () => {
    expect(kgToWeightUnit(1, 'lb')).toBeCloseTo(2.20462262, 8);
    expect(kgToWeightUnit(1, 'oz')).toBeCloseTo(35.27396195, 8);
    expect(kgToWeightUnit(0.5, 'g')).toBe(500);
  });

  it('keeps a null threshold null: every quote takes special freight (G-6)', () => {
    expect(kgToWeightUnit(null, 'kg')).toBeNull();
    expect(kgToWeightUnit(null, 'lb')).toBeNull();
  });

  it('returns null (special freight, fail safe) for a unit it does not know', () => {
    expect(kgToWeightUnit(100, 'stone')).toBeNull();
    expect(kgToWeightUnit(100, '')).toBeNull();
  });

  it.each([-1, NaN, Infinity])('refuses the misconfigured threshold %d', (kg) => {
    expect(() => kgToWeightUnit(kg, 'kg')).toThrow(/freeShippingMaxWeightKg/);
  });

  it('allows a zero threshold (only weightless quotes would ship free)', () => {
    expect(kgToWeightUnit(0, 'lb')).toBe(0);
  });
});

describe('normalizeWeightUnit (T-2.47)', () => {
  it.each([
    ['kg', 'kg'],
    ['KG', 'kg'],
    [' kgs ', 'kg'],
    ['lbs', 'lb'],
    ['Oz', 'oz'],
    ['g', 'g']
  ])('reads %j as %s, like core createShipment', (raw, unit) => {
    expect(normalizeWeightUnit(raw)).toBe(unit);
  });

  it.each(['stone', 'kilogram', '', 'ozs s'])('returns null for %j', (raw) => {
    expect(normalizeWeightUnit(raw)).toBeNull();
  });
});

describe('freeShippingMaxWeightInStoreUnit (T-2.47)', () => {
  it('converts with the core store weight unit by default', () => {
    getWeightUnit.mockClear();
    expect(freeShippingMaxWeightInStoreUnit(100)).toBeCloseTo(100 / 0.45359237, 9);
    expect(getWeightUnit).toHaveBeenCalledTimes(1);

    getWeightUnit.mockReturnValueOnce('g');
    expect(freeShippingMaxWeightInStoreUnit(2)).toBe(2000);
  });

  it('accepts an explicit unit and keeps null', () => {
    expect(freeShippingMaxWeightInStoreUnit(2, 'g')).toBe(2000);
    expect(freeShippingMaxWeightInStoreUnit(null, 'g')).toBeNull();
  });
});
