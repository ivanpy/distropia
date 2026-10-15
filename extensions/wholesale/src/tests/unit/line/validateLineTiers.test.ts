/**
 * T-2.40 (RF-11, ADR-10): validation of a product line's tier table.
 *
 * A valid table is ordered by `fromQty` ascending, without duplicates, with
 * `discountPercent` between 0 and 100 (two decimals, `numeric(5,2)`) and
 * non-decreasing, and labels of at most 64 characters. Every problem is
 * reported per row and field (`422 INVALID_TIERS` with per-row errors).
 */
import {
  MAX_TIER_LABEL_LENGTH,
  validateLineTiers,
  type TierError
} from '../../../services/line/validateLineTiers.js';

/** `[index, field, code]` of every error, for compact assertions. */
function errorsOf(input: unknown): Array<[number | null, string | null, string]> {
  const result = validateLineTiers(input);
  if (result.valid) {
    return [];
  }
  return result.errors.map((e: TierError) => [e.index, e.field, e.code]);
}

describe('validateLineTiers (T-2.40, RF-11)', () => {
  it('accepts an ordered table and normalizes labels', () => {
    const result = validateLineTiers([
      { fromQty: 1, discountPercent: 0 },
      { fromQty: 10, discountPercent: 5, label: '  Bronce ' },
      { fromQty: 50, discountPercent: 12.5, label: '' },
      { fromQty: 100, discountPercent: 12.5, label: null },
      { fromQty: 500, discountPercent: 100, label: 'Distribuidor Oro' }
    ]);
    expect(result).toEqual({
      valid: true,
      tiers: [
        { fromQty: 1, discountPercent: 0, label: null },
        { fromQty: 10, discountPercent: 5, label: 'Bronce' },
        { fromQty: 50, discountPercent: 12.5, label: null },
        { fromQty: 100, discountPercent: 12.5, label: null },
        { fromQty: 500, discountPercent: 100, label: 'Distribuidor Oro' }
      ]
    });
  });

  it('accepts an empty table (every quantity at base price, RF-12)', () => {
    expect(validateLineTiers([])).toEqual({ valid: true, tiers: [] });
  });

  it('refuses a value that is not an array', () => {
    expect(errorsOf(undefined)).toEqual([[null, null, 'TIERS_NOT_AN_ARRAY']]);
    expect(errorsOf({ fromQty: 1, discountPercent: 0 })).toEqual([[null, null, 'TIERS_NOT_AN_ARRAY']]);
  });

  it('refuses a row that is not an object', () => {
    expect(errorsOf([null, 'x', [1]])).toEqual([
      [0, null, 'TIER_NOT_AN_OBJECT'],
      [1, null, 'TIER_NOT_AN_OBJECT'],
      [2, null, 'TIER_NOT_AN_OBJECT']
    ]);
  });

  describe('fromQty', () => {
    it.each([
      ['zero', 0],
      ['negative', -5],
      ['fractional', 2.5],
      ['a string', '10'],
      ['missing', undefined],
      ['NaN', Number.NaN],
      ['above INT range', 2147483648]
    ])('refuses %s', (_name, fromQty) => {
      expect(errorsOf([{ fromQty, discountPercent: 1 }])).toEqual([[0, 'fromQty', 'FROM_QTY_INVALID']]);
    });

    it('accepts 1 and the INT maximum', () => {
      expect(validateLineTiers([{ fromQty: 1, discountPercent: 0 }, { fromQty: 2147483647, discountPercent: 1 }]).valid).toBe(true);
    });
  });

  describe('discountPercent (0-100)', () => {
    it.each([
      ['below 0', -0.01],
      ['above 100', 100.01],
      ['more than two decimals', 12.345],
      ['a string', '5'],
      ['missing', undefined],
      ['Infinity', Number.POSITIVE_INFINITY]
    ])('refuses %s', (_name, discountPercent) => {
      expect(errorsOf([{ fromQty: 1, discountPercent }])).toEqual([[0, 'discountPercent', 'DISCOUNT_INVALID']]);
    });

    it.each([0, 0.07, 33.33, 100])('accepts %p', (discountPercent) => {
      expect(validateLineTiers([{ fromQty: 1, discountPercent }]).valid).toBe(true);
    });
  });

  describe('label (<= 64 characters)', () => {
    it('accepts exactly 64 characters, counted as characters not UTF-16 units', () => {
      const ascii = 'a'.repeat(MAX_TIER_LABEL_LENGTH);
      const accented = 'ñ'.repeat(MAX_TIER_LABEL_LENGTH);
      const astral = '\u{1F947}'.repeat(MAX_TIER_LABEL_LENGTH);
      expect(MAX_TIER_LABEL_LENGTH).toBe(64);
      expect(
        validateLineTiers([
          { fromQty: 1, discountPercent: 0, label: ascii },
          { fromQty: 2, discountPercent: 0, label: accented },
          { fromQty: 3, discountPercent: 0, label: astral }
        ]).valid
      ).toBe(true);
    });

    it('refuses 65 characters after trimming', () => {
      expect(errorsOf([{ fromQty: 1, discountPercent: 0, label: ` ${'a'.repeat(65)} ` }])).toEqual([
        [0, 'label', 'LABEL_TOO_LONG']
      ]);
    });

    it('refuses a label that is not a string', () => {
      expect(errorsOf([{ fromQty: 1, discountPercent: 0, label: 7 }])).toEqual([[0, 'label', 'LABEL_INVALID']]);
    });
  });

  describe('order and duplicates', () => {
    it('refuses a duplicated fromQty on the repeated row', () => {
      expect(
        errorsOf([
          { fromQty: 1, discountPercent: 0 },
          { fromQty: 10, discountPercent: 5 },
          { fromQty: 10, discountPercent: 5 }
        ])
      ).toEqual([[2, 'fromQty', 'DUPLICATE_FROM_QTY']]);
    });

    it('refuses a fromQty not greater than every earlier one (not ascending)', () => {
      expect(
        errorsOf([
          { fromQty: 10, discountPercent: 0 },
          { fromQty: 5, discountPercent: 0 },
          { fromQty: 7, discountPercent: 0 }
        ])
      ).toEqual([
        [1, 'fromQty', 'TIERS_OUT_OF_ORDER'],
        [2, 'fromQty', 'TIERS_OUT_OF_ORDER']
      ]);
    });

    it('detects a duplicate that is not adjacent', () => {
      expect(
        errorsOf([
          { fromQty: 1, discountPercent: 0 },
          { fromQty: 10, discountPercent: 1 },
          { fromQty: 1, discountPercent: 2 }
        ])
      ).toEqual([[2, 'fromQty', 'DUPLICATE_FROM_QTY']]);
    });
  });

  describe('non-decreasing discount', () => {
    it('refuses a discount lower than an earlier one; equal is allowed', () => {
      expect(
        errorsOf([
          { fromQty: 1, discountPercent: 5 },
          { fromQty: 10, discountPercent: 5 },
          { fromQty: 20, discountPercent: 4.99 },
          { fromQty: 30, discountPercent: 6 }
        ])
      ).toEqual([[2, 'discountPercent', 'DISCOUNT_DECREASING']]);
    });

    it('compares against the highest earlier discount, not only the previous row', () => {
      expect(
        errorsOf([
          { fromQty: 1, discountPercent: 10 },
          { fromQty: 2, discountPercent: 3 },
          { fromQty: 3, discountPercent: 5 }
        ])
      ).toEqual([
        [1, 'discountPercent', 'DISCOUNT_DECREASING'],
        [2, 'discountPercent', 'DISCOUNT_DECREASING']
      ]);
    });
  });

  it('reports every problem of every row at once, with a message', () => {
    const result = validateLineTiers([
      { fromQty: 0, discountPercent: 150, label: 'x'.repeat(70) },
      { fromQty: 5, discountPercent: 10 }
    ]);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errors.map((e) => [e.index, e.field, e.code])).toEqual([
        [0, 'fromQty', 'FROM_QTY_INVALID'],
        [0, 'discountPercent', 'DISCOUNT_INVALID'],
        [0, 'label', 'LABEL_TOO_LONG']
      ]);
      for (const error of result.errors) {
        expect(error.message).toEqual(expect.any(String));
        expect(error.message.length).toBeGreaterThan(0);
      }
    }
  });

  it('ignores an invalid value when checking order (each field on its own)', () => {
    expect(
      errorsOf([
        { fromQty: 10, discountPercent: 'x' },
        { fromQty: 'y', discountPercent: 1 },
        { fromQty: 20, discountPercent: 1 }
      ])
    ).toEqual([
      [0, 'discountPercent', 'DISCOUNT_INVALID'],
      [1, 'fromQty', 'FROM_QTY_INVALID']
    ]);
  });
});
