/**
 * Body of `POST /api/wholesale/request-quote` (T-2.51,
 * `03_endpoints_y_contratos.md` §2): `{ data: toRequestQuoteResponse(...) }`
 * with 201 (created) or 200 (same Idempotency-Key).
 *
 * The status is the canonical name (ADR-14): a new quote is `DRAFT_QUOTE`
 * with free freight (the WhatsApp leaves right away) or
 * `AWAITING_SHIPPING_QUOTE` with special freight; a replayed key answers the
 * quote's current status. The frontend picks its confirmation message from
 * `freightLabel` (RF-15). No amounts (RF-08, RF-32) and only a masked phone.
 */
import type { QuoteSummary } from './createQuote.js';

export interface RequestQuoteResponse {
  uuid: string;
  quoteNumber: string;
  status: QuoteSummary['status'];
  freightLabel: QuoteSummary['freightLabel'];
  /** `null` until the quote is sent (expiration runs from `sent_at`, RF-16). */
  expiresAt: string | null;
  maskedPhone: string;
}

const MASK = '•';

/**
 * `+595981123456` → `+595 9•• ••• 456`: the first three digits (the
 * Paraguayan country code), the first subscriber digit and the last three
 * digits stay; the subscriber number is grouped in threes from the right.
 * Anything that is not E.164 is masked entirely.
 */
export function maskPhone(phone: string): string {
  if (!/^\+[1-9]\d{7,14}$/.test(phone)) {
    return MASK.repeat(3);
  }
  const digits = phone.slice(1);
  const country = digits.slice(0, 3);
  const subscriber = digits.slice(3);
  const visible = [...subscriber].map((d, i) => (i === 0 || i >= subscriber.length - 3 ? d : MASK)).join('');
  const groups: string[] = [];
  for (let end = visible.length; end > 0; end -= 3) {
    groups.unshift(visible.slice(Math.max(0, end - 3), end));
  }
  return `+${country} ${groups.join(' ')}`;
}

export function toRequestQuoteResponse(quote: QuoteSummary): RequestQuoteResponse {
  return {
    uuid: quote.uuid,
    quoteNumber: quote.quoteNumber,
    status: quote.status,
    freightLabel: quote.freightLabel,
    expiresAt: quote.expiresAt,
    maskedPhone: maskPhone(quote.phone)
  };
}
