import { TaxpayerError } from './TaxpayerError.js';

/**
 * Paraguayan RUC: base number of 1 to 8 digits, a hyphen and the check digit
 * (`03_sifen_y_dnit_mock.md` §2.2). The check digit is validated in every
 * runtime mode, the DNIT mock included (G-2).
 */
const BASE_PATTERN = /^\d{1,8}$/;
const RUC_PATTERN = /^(\d{1,8})-(\d)$/;

const invalidFormat = () =>
  new TaxpayerError('RUC_INVALID_FORMAT', 'The RUC must have 1 to 8 digits, a hyphen and the check digit.');

/** Check digit of a Paraguayan RUC base number (SET modulo 11, base max 11). */
export function rucCheckDigit(base: string): number {
  if (!BASE_PATTERN.test(base)) {
    throw invalidFormat();
  }
  let weight = 2;
  let total = 0;
  for (let i = base.length - 1; i >= 0; i -= 1) {
    if (weight > 11) {
      weight = 2;
    }
    total += Number(base[i]) * weight;
    weight += 1;
  }
  const rest = total % 11;
  return rest > 1 ? 11 - rest : 0;
}

export interface NormalizedRuc {
  base: string;
  dv: number;
  /** `<base>-<dv>`, the form stored in `customer.tax_id`. */
  normalized: string;
}

/**
 * Removes whitespace and dots, then validates the format and the check digit.
 * Throws `RUC_INVALID_FORMAT` or `RUC_INVALID_CHECK_DIGIT`.
 */
export function normalizeRuc(raw: string): NormalizedRuc {
  const compact = String(raw ?? '').replace(/[\s.]/g, '');
  const match = RUC_PATTERN.exec(compact);
  if (!match) {
    throw invalidFormat();
  }
  const [, base, dvText] = match;
  const dv = Number(dvText);
  if (rucCheckDigit(base) !== dv) {
    throw new TaxpayerError('RUC_INVALID_CHECK_DIGIT', 'The RUC check digit is not valid.');
  }
  return { base, dv, normalized: `${base}-${dv}` };
}
