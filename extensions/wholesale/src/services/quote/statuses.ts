/**
 * Quote state machine (T-2.50, ADR-14, data model §5).
 *
 * TypeScript and the UI use canonical names; `wholesale_quote.status` stores
 * the codes of migrations 1.0.0/1.1.0 (`WHOLESALE_QUOTE_STATUS_CHECK`). This
 * module is the only place that maps one to the other and that knows which
 * transitions exist. Callers still perform each transition atomically with
 * `UPDATE … WHERE status = '<origin code>'` inside a transaction.
 *
 * Pure: no I/O.
 */

const QUOTE_STATUS_CODES = {
  DRAFT_QUOTE: 'pending',
  AWAITING_SHIPPING_QUOTE: 'awaiting_freight',
  QUOTE_SENT: 'sent',
  QUOTE_APPROVED: 'accepted',
  QUOTE_REJECTED: 'rejected',
  QUOTE_EXPIRED: 'expired',
  SEND_FAILED: 'failed'
} as const;

export type QuoteStatus = keyof typeof QUOTE_STATUS_CODES;
export type QuoteStatusCode = (typeof QUOTE_STATUS_CODES)[QuoteStatus];

export const QUOTE_STATUSES = Object.freeze(Object.keys(QUOTE_STATUS_CODES) as QuoteStatus[]);

/** `createQuote` inserts every quote here. */
export const INITIAL_QUOTE_STATUS: QuoteStatus = 'DRAFT_QUOTE';

/** Allowed targets per origin (data model §5 transition table). */
const QUOTE_TRANSITIONS: Readonly<Record<QuoteStatus, readonly QuoteStatus[]>> = Object.freeze({
  // Free freight: WhatsApp delivered. Special freight: same transaction as createQuote.
  DRAFT_QUOTE: ['QUOTE_SENT', 'AWAITING_SHIPPING_QUOTE', 'SEND_FAILED'],
  // Seller quotes FLETE_LOGISTICA, then the WhatsApp is delivered (or fails for good).
  AWAITING_SHIPPING_QUOTE: ['QUOTE_SENT', 'SEND_FAILED'],
  // Customer accepts or rejects; the job or a late answer expires it.
  QUOTE_SENT: ['QUOTE_APPROVED', 'QUOTE_REJECTED', 'QUOTE_EXPIRED'],
  // The order lifecycle continues in wholesale_order (order/statuses.ts).
  QUOTE_APPROVED: [],
  QUOTE_REJECTED: [],
  QUOTE_EXPIRED: [],
  SEND_FAILED: []
});

export type QuoteStatusErrorCode = 'UNKNOWN_STATUS' | 'INVALID_STATUS_TRANSITION';

export class QuoteStatusError extends Error {
  constructor(
    readonly code: QuoteStatusErrorCode,
    message: string,
    readonly from?: string,
    readonly to?: string
  ) {
    super(message);
    this.name = 'QuoteStatusError';
  }
}

const isQuoteStatus = (value: unknown): value is QuoteStatus =>
  typeof value === 'string' && Object.prototype.hasOwnProperty.call(QUOTE_STATUS_CODES, value);

const CODE_TO_STATUS: ReadonlyMap<string, QuoteStatus> = new Map(
  QUOTE_STATUSES.map((status) => [QUOTE_STATUS_CODES[status], status])
);

export function toQuoteStatusCode(status: QuoteStatus): QuoteStatusCode {
  if (!isQuoteStatus(status)) {
    throw new QuoteStatusError('UNKNOWN_STATUS', `Unknown quote status ${JSON.stringify(status)}`);
  }
  return QUOTE_STATUS_CODES[status];
}

export function fromQuoteStatusCode(code: string): QuoteStatus {
  const status = CODE_TO_STATUS.get(code);
  if (status === undefined) {
    throw new QuoteStatusError('UNKNOWN_STATUS', `Unknown quote status code ${JSON.stringify(code)}`);
  }
  return status;
}

export function canTransitionQuote(from: QuoteStatus, to: QuoteStatus): boolean {
  return isQuoteStatus(from) && isQuoteStatus(to) && QUOTE_TRANSITIONS[from].includes(to);
}

/** Throws `INVALID_STATUS_TRANSITION` unless `from → to` is a listed transition. */
export function assertQuoteTransition(from: QuoteStatus, to: QuoteStatus): void {
  if (!canTransitionQuote(from, to)) {
    throw new QuoteStatusError(
      'INVALID_STATUS_TRANSITION',
      `Quote cannot go from ${String(from)} to ${String(to)}`,
      from,
      to
    );
  }
}
