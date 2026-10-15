/**
 * Item quantity against the product's wholesale rule (T-2.14, RF-09, RF-10).
 *
 * Valid quantities are `minQty`, `minQty + stepQty`, `minQty + 2·stepQty`, …
 * up to `maxQty` (no cap when `null`). An invalid quantity is refused with
 * the nearest valid quantities as a hint; it is never rounded silently.
 *
 * Pure: no I/O. The result carries quantities only, never amounts.
 */

export interface QuantityRule {
  minQty: number;
  stepQty: number;
  maxQty: number | null;
}

export type QuantityRefusal = 'NOT_A_WHOLE_NUMBER' | 'BELOW_MINIMUM' | 'ABOVE_MAXIMUM' | 'NOT_A_STEP';

export type QuantityCheck =
  | { valid: true }
  | {
      valid: false;
      code: 'INVALID_QUANTITY';
      reason: QuantityRefusal;
      minQty: number;
      stepQty: number;
      maxQty: number | null;
      /** Largest valid quantity below the requested one, if any. */
      lower: number | null;
      /** Smallest valid quantity above the requested one, if any. */
      upper: number | null;
    };

const isPositiveInteger = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 1;

function assertRule(rule: QuantityRule): void {
  if (
    !isPositiveInteger(rule.minQty) ||
    !isPositiveInteger(rule.stepQty) ||
    (rule.maxQty !== null && (!isPositiveInteger(rule.maxQty) || rule.maxQty < rule.minQty))
  ) {
    // The database refuses such rows (WHOLESALE_RULE_QTY_CHECK): a programming error.
    throw new Error(`validateQuantity: invalid quantity rule ${JSON.stringify(rule)}`);
  }
}

export function validateQuantity(qty: number, rule: QuantityRule): QuantityCheck {
  assertRule(rule);
  const { minQty, stepQty, maxQty } = rule;
  const refuse = (reason: QuantityRefusal, lower: number | null, upper: number | null): QuantityCheck => ({
    valid: false,
    code: 'INVALID_QUANTITY',
    reason,
    minQty,
    stepQty,
    maxQty,
    lower,
    upper
  });

  /** Largest valid quantity (the cap itself when it is on the grid). */
  const largest = maxQty === null ? Number.POSITIVE_INFINITY : minQty + Math.floor((maxQty - minQty) / stepQty) * stepQty;

  if (!isPositiveInteger(qty)) {
    return refuse('NOT_A_WHOLE_NUMBER', null, null);
  }
  if (qty < minQty) {
    return refuse('BELOW_MINIMUM', null, minQty);
  }
  if (maxQty !== null && qty > maxQty) {
    return refuse('ABOVE_MAXIMUM', largest, null);
  }
  const lower = minQty + Math.floor((qty - minQty) / stepQty) * stepQty;
  if (lower === qty) {
    return { valid: true };
  }
  const upper = lower + stepQty;
  return refuse('NOT_A_STEP', lower, upper <= largest ? upper : null);
}
