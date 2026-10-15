/**
 * Validation of a product line's tier table (T-2.40, RF-11, ADR-10).
 *
 * The database guarantees `UNIQUE (line, from_qty)`, `from_qty >= 1` and
 * `discount_percent BETWEEN 0 AND 100`; the order and the non-decreasing
 * discount live only here (`02_modelo_datos_postgresql.md` §7.1). The
 * validator also reports everything the database would refuse, so an admin
 * gets per-row errors (`422 INVALID_TIERS`) instead of a constraint error.
 *
 * Pure: no I/O. A row's field is compared with earlier rows only when that
 * field is valid in both, so one bad value does not cascade into order errors.
 */

/** `wholesale_product_line_tier.label` is `varchar(64)`. */
export const MAX_TIER_LABEL_LENGTH = 64;

/** `from_qty` is a PostgreSQL `INT`. */
const MAX_FROM_QTY = 2147483647;

export interface LineTier {
  fromQty: number;
  discountPercent: number;
  label: string | null;
}

export type TierErrorCode =
  | 'TIERS_NOT_AN_ARRAY'
  | 'TIER_NOT_AN_OBJECT'
  | 'FROM_QTY_INVALID'
  | 'DISCOUNT_INVALID'
  | 'LABEL_INVALID'
  | 'LABEL_TOO_LONG'
  | 'DUPLICATE_FROM_QTY'
  | 'TIERS_OUT_OF_ORDER'
  | 'DISCOUNT_DECREASING';

export interface TierError {
  /** Row index in the submitted table; `null` for the table itself. */
  index: number | null;
  field: 'fromQty' | 'discountPercent' | 'label' | null;
  code: TierErrorCode;
  message: string;
}

export type TierValidation = { valid: true; tiers: LineTier[] } | { valid: false; errors: TierError[] };

const isValidFromQty = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= MAX_FROM_QTY;

/** 0-100 with at most two decimals (`numeric(5,2)` would round silently). */
const isValidDiscount = (value: unknown): value is number =>
  typeof value === 'number' &&
  Number.isFinite(value) &&
  value >= 0 &&
  value <= 100 &&
  Math.round(value * 100) / 100 === value;

/** Characters as PostgreSQL `varchar(n)` counts them (code points). */
const characterLength = (value: string): number => Array.from(value).length;

export function validateLineTiers(input: unknown): TierValidation {
  if (!Array.isArray(input)) {
    return {
      valid: false,
      errors: [{ index: null, field: null, code: 'TIERS_NOT_AN_ARRAY', message: 'tiers must be an array' }]
    };
  }

  const errors: TierError[] = [];
  const tiers: LineTier[] = [];
  const seenFromQty = new Set<number>();
  let maxFromQty: number | null = null;
  let maxDiscount: number | null = null;

  input.forEach((row: unknown, index) => {
    if (row === null || typeof row !== 'object' || Array.isArray(row)) {
      errors.push({ index, field: null, code: 'TIER_NOT_AN_OBJECT', message: `Tier ${index + 1} must be an object` });
      return;
    }
    const { fromQty, discountPercent, label } = row as Record<string, unknown>;

    if (!isValidFromQty(fromQty)) {
      errors.push({
        index,
        field: 'fromQty',
        code: 'FROM_QTY_INVALID',
        message: `Tier ${index + 1}: quantity must be a whole number of at least 1`
      });
    } else if (seenFromQty.has(fromQty)) {
      errors.push({
        index,
        field: 'fromQty',
        code: 'DUPLICATE_FROM_QTY',
        message: `Tier ${index + 1}: quantity ${fromQty} is already used by another tier`
      });
    } else if (maxFromQty !== null && fromQty < maxFromQty) {
      errors.push({
        index,
        field: 'fromQty',
        code: 'TIERS_OUT_OF_ORDER',
        message: `Tier ${index + 1}: quantities must be in ascending order`
      });
    }

    if (!isValidDiscount(discountPercent)) {
      errors.push({
        index,
        field: 'discountPercent',
        code: 'DISCOUNT_INVALID',
        message: `Tier ${index + 1}: discount must be between 0 and 100 with at most two decimals`
      });
    } else if (maxDiscount !== null && discountPercent < maxDiscount) {
      errors.push({
        index,
        field: 'discountPercent',
        code: 'DISCOUNT_DECREASING',
        message: `Tier ${index + 1}: discount cannot be lower than the discount of a smaller quantity`
      });
    }

    let normalizedLabel: string | null = null;
    if (label !== undefined && label !== null) {
      if (typeof label !== 'string') {
        errors.push({ index, field: 'label', code: 'LABEL_INVALID', message: `Tier ${index + 1}: label must be text` });
      } else {
        const trimmed = label.trim();
        if (characterLength(trimmed) > MAX_TIER_LABEL_LENGTH) {
          errors.push({
            index,
            field: 'label',
            code: 'LABEL_TOO_LONG',
            message: `Tier ${index + 1}: label must be at most ${MAX_TIER_LABEL_LENGTH} characters`
          });
        }
        normalizedLabel = trimmed === '' ? null : trimmed;
      }
    }

    if (isValidFromQty(fromQty)) {
      seenFromQty.add(fromQty);
      maxFromQty = maxFromQty === null ? fromQty : Math.max(maxFromQty, fromQty);
    }
    if (isValidDiscount(discountPercent)) {
      maxDiscount = maxDiscount === null ? discountPercent : Math.max(maxDiscount, discountPercent);
    }
    if (isValidFromQty(fromQty) && isValidDiscount(discountPercent)) {
      tiers.push({ fromQty, discountPercent, label: normalizedLabel });
    }
  });

  return errors.length > 0 ? { valid: false, errors } : { valid: true, tiers };
}
