/**
 * ADR-06: render the placeholder text for masked amounts.
 *
 * Replaces core `Price.text` for every `Price` in the storefront schema. Real
 * amounts are formatted exactly as core does (`resolveCorePriceText`); only a
 * `MaskedAmount` produced by the wholesale price resolvers gets the
 * placeholder. `Price.value` and `Price.currency` stay core: a masked amount
 * coerces to 0 and the currency keeps the store/argument currency.
 */
import { isMaskedAmount, MASKED_PRICE_TEXT } from '../../../services/pricing/maskedAmount.js';
import { resolveCorePriceText } from '../../../services/pricing/resolveCorePrice.js';

export default {
  Price: {
    text: (rawPrice: unknown, args: { currency?: string | null }): string =>
      isMaskedAmount(rawPrice)
        ? MASKED_PRICE_TEXT
        : resolveCorePriceText(rawPrice, args?.currency)
  }
};
