/**
 * T-2.35: Paraguayan RUC check digit (SET modulo 11) and normalization.
 *
 * The literal CIRCUITO §2/§4 examples carry a wrong check digit and must be
 * rejected (G-2, `03_sifen_y_dnit_mock.md` §2.2); the corrected values pass.
 */
import { TaxpayerError } from '../../../services/taxpayer/TaxpayerError.js';
import { normalizeRuc, rucCheckDigit } from '../../../services/taxpayer/rucCheckDigit.js';

/** The error code thrown by `fn`, or `undefined` when it does not throw. */
function codeOf(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(TaxpayerError);
    return (e as TaxpayerError).code;
  }
  return undefined;
}

describe('rucCheckDigit', () => {
  it.each([
    ['80012344', 1],
    ['4445551', 8],
    ['80099999', 1],
    ['80012346', 8]
  ])('base %s -> check digit %d', (base, dv) => {
    expect(rucCheckDigit(base)).toBe(dv);
  });

  it('handles the 1-digit edge (remainder > 1 and remainder 0)', () => {
    // 1 * 2 = 2 -> 11 - 2 = 9
    expect(rucCheckDigit('1')).toBe(9);
    // 0 -> remainder 0 -> 0
    expect(rucCheckDigit('0')).toBe(0);
  });

  it('maps remainder 1 to check digit 0', () => {
    // 6 * 2 = 12 -> 12 mod 11 = 1 -> 0
    expect(rucCheckDigit('6')).toBe(0);
  });

  it('handles the 8-digit edge (weights 2..9)', () => {
    // 9 * (2 + 3 + ... + 9) = 9 * 44 = 396 -> 396 mod 11 = 0 -> 0
    expect(rucCheckDigit('99999999')).toBe(0);
    // 1 * 9 (leftmost weight) = 9 -> 11 - 9 = 2
    expect(rucCheckDigit('10000000')).toBe(2);
  });

  it.each(['', '123456789', '12a4', '-1', '1.2'])('rejects base %p with RUC_INVALID_FORMAT', (base) => {
    expect(codeOf(() => rucCheckDigit(base))).toBe('RUC_INVALID_FORMAT');
  });
});

describe('normalizeRuc', () => {
  it.each([
    ['80012344-1', '80012344', 1],
    ['4445551-8', '4445551', 8],
    ['80099999-1', '80099999', 1],
    [' 80.012.344-1 ', '80012344', 1],
    ['1-9', '1', 9],
    ['0-0', '0', 0]
  ])('accepts %p', (raw, base, dv) => {
    expect(normalizeRuc(raw)).toEqual({ base, dv, normalized: `${base}-${dv}` });
  });

  it.each(['80012344-2', '4445551-7', '80099999-2', '1-8'])(
    'rejects %p with RUC_INVALID_CHECK_DIGIT',
    (raw) => {
      expect(codeOf(() => normalizeRuc(raw))).toBe('RUC_INVALID_CHECK_DIGIT');
    }
  );

  it.each(['', '80012344', '80012344-', '123456789-1', '80012344-12', 'ABC-1', '80012344/1'])(
    'rejects %p with RUC_INVALID_FORMAT',
    (raw) => {
      expect(codeOf(() => normalizeRuc(raw))).toBe('RUC_INVALID_FORMAT');
    }
  );
});
