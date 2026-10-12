/**
 * Placeholder shown instead of a price to approved wholesale customers (ADR-06).
 */
export const MASKED_PRICE_TEXT = 'Subject to quote';

/**
 * A raw amount that stands in for a hidden price.
 *
 * Core resolves every `Price` field from a raw number (`Price.value` is
 * `parseFloat(raw)`, `Price.currency` ignores it). This object coerces to 0,
 * so those core resolvers keep working unchanged and return `value: 0` and
 * the store currency, while the extension `Price.text` resolver can tell it
 * apart from a real 0 and render the placeholder instead of "$0.00".
 */
export class MaskedAmount {
  valueOf(): number {
    return 0;
  }

  toString(): string {
    return '0';
  }
}

export const MASKED_AMOUNT = new MaskedAmount();

export function isMaskedAmount(value: unknown): value is MaskedAmount {
  return value instanceof MaskedAmount;
}
