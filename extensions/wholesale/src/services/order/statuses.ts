/**
 * Wholesale order state machine and orthogonal payment status (T-2.50,
 * ADR-14, data model §8).
 *
 * TypeScript and the UI use canonical names; `wholesale_order.status` stores
 * the codes of migration 1.1.0 (`WHOLESALE_ORDER_STATUS_CHECK`). The payment
 * status (`wholesale_order.payment_status`) has no separate canonical names:
 * its stored codes are used as they are. This module is the only place that
 * maps names to codes and knows which transitions exist; callers still
 * perform each transition with `UPDATE … WHERE status = '<origin code>'`.
 *
 * Pure: no I/O.
 */

const ORDER_STATUS_CODES = {
  ORDER_CONFIRMED: 'order_confirmed',
  EXPIRED: 'expired',
  CANCELLED: 'cancelled',
  PENDING_INVOICING: 'pending_invoicing',
  SIFEN_INVOICED: 'sifen_invoiced',
  PARTIALLY_DISPATCHED: 'partially_dispatched',
  DISPATCHED: 'dispatched'
} as const;

export type OrderStatus = keyof typeof ORDER_STATUS_CODES;
export type OrderStatusCode = (typeof ORDER_STATUS_CODES)[OrderStatus];

export const ORDER_STATUSES = Object.freeze(Object.keys(ORDER_STATUS_CODES) as OrderStatus[]);

/** `createOrderFromQuote` inserts every wholesale order here. */
export const INITIAL_ORDER_STATUS: OrderStatus = 'ORDER_CONFIRMED';

/**
 * Allowed targets per origin (data model §8 transition table). Listed
 * self-transitions are real actions that keep the status: payment terms on a
 * confirmed order, an invoicing retry, another partial dispatch.
 */
const ORDER_TRANSITIONS: Readonly<Record<OrderStatus, readonly OrderStatus[]>> = Object.freeze({
  ORDER_CONFIRMED: ['ORDER_CONFIRMED', 'EXPIRED', 'CANCELLED', 'PENDING_INVOICING'],
  EXPIRED: ['ORDER_CONFIRMED', 'CANCELLED'],
  // Executed orders are never cancelled (voiding invoices and NRE is out of scope v1).
  PENDING_INVOICING: ['PENDING_INVOICING', 'SIFEN_INVOICED'],
  SIFEN_INVOICED: ['PARTIALLY_DISPATCHED', 'DISPATCHED'],
  PARTIALLY_DISPATCHED: ['PARTIALLY_DISPATCHED', 'DISPATCHED'],
  DISPATCHED: [],
  CANCELLED: []
});

export const PAYMENT_STATUSES = Object.freeze(['pending', 'unpaid', 'partially_paid', 'paid'] as const);
export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];

/** Payment is `pending` until the order is executed. */
export const INITIAL_PAYMENT_STATUS: PaymentStatus = 'pending';

/**
 * Payment status changes (ADR-14 point 3): executing moves `pending` to
 * `paid` (cash, transfer, cheque) or `unpaid` (credit); FIFO allocations move
 * forward; a payment void (ADR-16) moves back. Never back to `pending`.
 */
const PAYMENT_TRANSITIONS: Readonly<Record<PaymentStatus, readonly PaymentStatus[]>> = Object.freeze({
  pending: ['paid', 'unpaid'],
  unpaid: ['partially_paid', 'paid'],
  // Self-transition: another partial FIFO allocation, or a void that still
  // leaves part of the order paid, keeps the status.
  partially_paid: ['partially_paid', 'paid', 'unpaid'],
  paid: ['unpaid', 'partially_paid']
});

export type OrderStatusErrorCode = 'UNKNOWN_STATUS' | 'INVALID_STATUS_TRANSITION';

export class OrderStatusError extends Error {
  constructor(
    readonly code: OrderStatusErrorCode,
    message: string,
    readonly from?: string,
    readonly to?: string
  ) {
    super(message);
    this.name = 'OrderStatusError';
  }
}

const has = (record: object, key: unknown): boolean =>
  typeof key === 'string' && Object.prototype.hasOwnProperty.call(record, key);

const CODE_TO_STATUS: ReadonlyMap<string, OrderStatus> = new Map(
  ORDER_STATUSES.map((status) => [ORDER_STATUS_CODES[status], status])
);

export function toOrderStatusCode(status: OrderStatus): OrderStatusCode {
  if (!has(ORDER_STATUS_CODES, status)) {
    throw new OrderStatusError('UNKNOWN_STATUS', `Unknown order status ${JSON.stringify(status)}`);
  }
  return ORDER_STATUS_CODES[status];
}

export function fromOrderStatusCode(code: string): OrderStatus {
  const status = CODE_TO_STATUS.get(code);
  if (status === undefined) {
    throw new OrderStatusError('UNKNOWN_STATUS', `Unknown order status code ${JSON.stringify(code)}`);
  }
  return status;
}

export function canTransitionOrder(from: OrderStatus, to: OrderStatus): boolean {
  return has(ORDER_TRANSITIONS, from) && has(ORDER_TRANSITIONS, to) && ORDER_TRANSITIONS[from].includes(to);
}

/** Throws `INVALID_STATUS_TRANSITION` unless `from → to` is a listed order transition. */
export function assertOrderTransition(from: OrderStatus, to: OrderStatus): void {
  if (!canTransitionOrder(from, to)) {
    throw new OrderStatusError(
      'INVALID_STATUS_TRANSITION',
      `Wholesale order cannot go from ${String(from)} to ${String(to)}`,
      from,
      to
    );
  }
}

export function canTransitionPaymentStatus(from: PaymentStatus, to: PaymentStatus): boolean {
  return has(PAYMENT_TRANSITIONS, from) && has(PAYMENT_TRANSITIONS, to) && PAYMENT_TRANSITIONS[from].includes(to);
}

/** Throws `INVALID_STATUS_TRANSITION` unless `from → to` is a listed payment status change. */
export function assertPaymentStatusTransition(from: PaymentStatus, to: PaymentStatus): void {
  if (!canTransitionPaymentStatus(from, to)) {
    throw new OrderStatusError(
      'INVALID_STATUS_TRANSITION',
      `Payment status cannot go from ${String(from)} to ${String(to)}`,
      from,
      to
    );
  }
}
