/**
 * Domain refusals of quote creation (`03_endpoints_y_contratos.md` §2,
 * responses of `POST /api/wholesale/request-quote`). The endpoint (W8)
 * answers them with `status` and `code`; `details` never carries amounts.
 */
export type QuoteErrorCode =
  | 'IDEMPOTENCY_KEY_REQUIRED'
  | 'WHOLESALE_NOT_APPROVED'
  | 'CART_NOT_FOUND'
  | 'QUOTE_IN_PROGRESS'
  | 'EMPTY_CART'
  | 'INVALID_QUANTITY'
  | 'PRODUCT_NOT_QUOTABLE'
  | 'MINIMUM_ORDER_NOT_MET';

const STATUS: Readonly<Record<QuoteErrorCode, number>> = Object.freeze({
  IDEMPOTENCY_KEY_REQUIRED: 400,
  WHOLESALE_NOT_APPROVED: 403,
  CART_NOT_FOUND: 404,
  QUOTE_IN_PROGRESS: 409,
  EMPTY_CART: 422,
  INVALID_QUANTITY: 422,
  PRODUCT_NOT_QUOTABLE: 422,
  MINIMUM_ORDER_NOT_MET: 422
});

export class QuoteError extends Error {
  readonly status: number;

  constructor(
    readonly code: QuoteErrorCode,
    message: string,
    readonly details?: Record<string, unknown>
  ) {
    super(message);
    this.name = 'QuoteError';
    this.status = STATUS[code];
  }
}

export const isQuoteError = (e: unknown): e is QuoteError => e instanceof QuoteError;
