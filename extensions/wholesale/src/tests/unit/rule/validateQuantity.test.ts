/**
 * T-2.14 (RF-09, RF-10, CU-02 6a): item quantity against the product rule.
 * Valid quantities are `minQty`, `minQty + stepQty`, … up to `maxQty`
 * (no cap when `null`); an invalid quantity is refused, never rounded.
 */
import { validateQuantity } from '../../../services/rule/validateQuantity.js';

const BOXES_OF_6 = { minQty: 6, stepQty: 6, maxQty: null };

describe('validateQuantity (T-2.14)', () => {
  it.each([6, 12, 18, 600])('accepts %i with min 6 / step 6 / no cap', (qty) => {
    expect(validateQuantity(qty, BOXES_OF_6)).toEqual({ valid: true });
  });

  it('refuses 13 with step 6 and reports the nearest valid quantities', () => {
    expect(validateQuantity(13, BOXES_OF_6)).toEqual({
      valid: false,
      code: 'INVALID_QUANTITY',
      reason: 'NOT_A_STEP',
      minQty: 6,
      stepQty: 6,
      maxQty: null,
      lower: 12,
      upper: 18
    });
  });

  it.each([1, 5])('refuses %i below the minimum', (qty) => {
    expect(validateQuantity(qty, BOXES_OF_6)).toMatchObject({ valid: false, reason: 'BELOW_MINIMUM', lower: null, upper: 6 });
  });

  it('counts steps from the minimum, not from zero', () => {
    const rule = { minQty: 5, stepQty: 10, maxQty: null };
    expect(validateQuantity(5, rule).valid).toBe(true);
    expect(validateQuantity(15, rule).valid).toBe(true);
    expect(validateQuantity(10, rule)).toMatchObject({ valid: false, reason: 'NOT_A_STEP', lower: 5, upper: 15 });
  });

  it('accepts the cap and refuses one step past it', () => {
    const rule = { minQty: 6, stepQty: 6, maxQty: 24 };
    expect(validateQuantity(24, rule).valid).toBe(true);
    expect(validateQuantity(30, rule)).toMatchObject({ valid: false, reason: 'ABOVE_MAXIMUM', lower: 24, upper: null });
  });

  it('caps the nearest quantities at the largest valid quantity when the cap is off-grid', () => {
    const rule = { minQty: 6, stepQty: 6, maxQty: 20 };
    expect(validateQuantity(18, rule).valid).toBe(true);
    expect(validateQuantity(20, rule)).toMatchObject({ valid: false, reason: 'NOT_A_STEP', lower: 18, upper: null });
    expect(validateQuantity(21, rule)).toMatchObject({ valid: false, reason: 'ABOVE_MAXIMUM', lower: 18, upper: null });
  });

  it('accepts every quantity from 1 with min 1 / step 1 / no cap', () => {
    const rule = { minQty: 1, stepQty: 1, maxQty: null };
    for (const qty of [1, 2, 13, 2147483647]) {
      expect(validateQuantity(qty, rule).valid).toBe(true);
    }
  });

  it('accepts a single valid quantity when min equals max', () => {
    const rule = { minQty: 10, stepQty: 3, maxQty: 10 };
    expect(validateQuantity(10, rule).valid).toBe(true);
    expect(validateQuantity(13, rule)).toMatchObject({ valid: false, reason: 'ABOVE_MAXIMUM', lower: 10 });
  });

  it.each([0, -6, 6.5, Number.NaN, Number.POSITIVE_INFINITY, '6' as unknown as number, null as unknown as number])(
    'refuses the non-quantity %p without rounding',
    (qty) => {
      expect(validateQuantity(qty, BOXES_OF_6)).toMatchObject({ valid: false, reason: 'NOT_A_WHOLE_NUMBER' });
    }
  );

  it('throws on a rule the database would never hold', () => {
    expect(() => validateQuantity(6, { minQty: 0, stepQty: 6, maxQty: null })).toThrow(/rule/);
    expect(() => validateQuantity(6, { minQty: 6, stepQty: 0, maxQty: null })).toThrow(/rule/);
    expect(() => validateQuantity(6, { minQty: 6, stepQty: 6, maxQty: 5 })).toThrow(/rule/);
  });
});
