/**
 * Non-numeric warnings of a wholesale cart (T-2.48, RF-27 to RF-29, CU-02
 * step 3, architecture §8): the bag tells an approved wholesale customer that
 * the quote would be refused or repriced, without showing any amount.
 *
 * - `MINIMUM_ORDER_NOT_MET`: the final net products total is below the
 *   minimum (the request would answer 422). Not emitted while the cart holds
 *   a non-quotable product or a quantity off the grid: the total of the
 *   remaining lines says nothing about the minimum, and the request would be
 *   refused first with `PRODUCT_NOT_QUOTABLE` / `INVALID_QUANTITY`.
 * - `MIX_RULE_NOT_MET`: the mix rule removed the maximum-tier discount of a
 *   critical consumable.
 *
 * Runs the same calculation as `createQuote` over the cart's quotable items
 * on the grid; other items are left out (the cart item rules refuse them for
 * wholesale customers, and `createQuote` reports them). The contract only
 * defines the two codes above (endpoints contract, `WholesaleCartWarning`),
 * so excluded lines get no code of their own here. An empty cart has no
 * warning. Codes only: thresholds can be probed by changing quantities, a
 * bounded and accepted leak (security A16).
 */
import { calculateQuote } from '../quote/calculateQuote.js';
import { loadCartLines, prepareQuoteItems, type QuoteSettings } from '../quote/quoteInput.js';
import type { Queryable } from '../rule/ruleRow.js';

export type WholesaleWarningCode = 'MINIMUM_ORDER_NOT_MET' | 'MIX_RULE_NOT_MET';

export async function cartWholesaleWarnings(
  db: Queryable,
  cartId: number,
  settings: QuoteSettings
): Promise<WholesaleWarningCode[]> {
  const lines = await loadCartLines(db, cartId);
  if (lines.length === 0) {
    return [];
  }
  const { items, notQuotable, invalidQuantities } = await prepareQuoteItems(db, lines);
  const hasExcludedLines = notQuotable.length > 0 || invalidQuantities.length > 0;
  const calculation = calculateQuote(items, settings);
  const warnings: WholesaleWarningCode[] = [];
  if (!calculation.minimumMet && !hasExcludedLines) {
    warnings.push('MINIMUM_ORDER_NOT_MET');
  }
  if (calculation.mixRuleApplied) {
    warnings.push('MIX_RULE_NOT_MET');
  }
  return warnings;
}
