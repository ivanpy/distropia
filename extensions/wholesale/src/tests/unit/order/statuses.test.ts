/**
 * T-2.50 (ADR-14, data model §8): canonical wholesale order statuses ↔
 * stored codes, the allowed transitions, and the orthogonal payment status.
 * Codes must match the CHECK constraints of migration 1.1.0.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  assertOrderTransition,
  assertPaymentStatusTransition,
  canTransitionOrder,
  canTransitionPaymentStatus,
  fromOrderStatusCode,
  INITIAL_ORDER_STATUS,
  INITIAL_PAYMENT_STATUS,
  ORDER_STATUSES,
  type OrderStatus,
  OrderStatusError,
  PAYMENT_STATUSES,
  type PaymentStatus,
  toOrderStatusCode
} from '../../../services/order/statuses.js';

const MAPPING: [OrderStatus, string][] = [
  ['ORDER_CONFIRMED', 'order_confirmed'],
  ['EXPIRED', 'expired'],
  ['CANCELLED', 'cancelled'],
  ['PENDING_INVOICING', 'pending_invoicing'],
  ['SIFEN_INVOICED', 'sifen_invoiced'],
  ['PARTIALLY_DISPATCHED', 'partially_dispatched'],
  ['DISPATCHED', 'dispatched']
];

const ALLOWED: [OrderStatus, OrderStatus][] = [
  ['ORDER_CONFIRMED', 'ORDER_CONFIRMED'], // payment terms
  ['ORDER_CONFIRMED', 'EXPIRED'],
  ['ORDER_CONFIRMED', 'CANCELLED'],
  ['ORDER_CONFIRMED', 'PENDING_INVOICING'],
  ['EXPIRED', 'ORDER_CONFIRMED'], // extend
  ['EXPIRED', 'CANCELLED'],
  ['PENDING_INVOICING', 'PENDING_INVOICING'], // retry invoicing
  ['PENDING_INVOICING', 'SIFEN_INVOICED'],
  ['SIFEN_INVOICED', 'PARTIALLY_DISPATCHED'],
  ['SIFEN_INVOICED', 'DISPATCHED'],
  ['PARTIALLY_DISPATCHED', 'PARTIALLY_DISPATCHED'], // another partial NRE
  ['PARTIALLY_DISPATCHED', 'DISPATCHED']
];

const PAYMENT_ALLOWED: [PaymentStatus, PaymentStatus][] = [
  ['pending', 'paid'],
  ['pending', 'unpaid'],
  ['unpaid', 'partially_paid'],
  ['unpaid', 'paid'],
  ['partially_paid', 'paid'],
  ['paid', 'unpaid'],
  ['paid', 'partially_paid'],
  ['partially_paid', 'unpaid']
];

const migration = (): string =>
  readFileSync(fileURLToPath(new URL('../../../../src/migration/Version-1.1.0.ts', import.meta.url)), 'utf8');

const checkCodes = (constraint: string): string[] => {
  const match = new RegExp(`CONSTRAINT "${constraint}" CHECK \\("[a-z_]+" IN\\s*\\(([^)]*)\\)\\)`).exec(migration());
  expect(match).not.toBeNull();
  return [...(match as RegExpExecArray)[1].matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
};

describe('wholesale order statuses (T-2.50)', () => {
  it('maps every canonical name to its stored code and back', () => {
    expect([...ORDER_STATUSES]).toEqual(MAPPING.map(([name]) => name));
    for (const [name, code] of MAPPING) {
      expect(toOrderStatusCode(name)).toBe(code);
      expect(fromOrderStatusCode(code)).toBe(name);
    }
  });

  it('uses exactly the codes allowed by WHOLESALE_ORDER_STATUS_CHECK (migration 1.1.0)', () => {
    expect(checkCodes('WHOLESALE_ORDER_STATUS_CHECK').sort()).toEqual(MAPPING.map(([, code]) => code).sort());
  });

  it('starts every order in ORDER_CONFIRMED with payment pending', () => {
    expect(INITIAL_ORDER_STATUS).toBe('ORDER_CONFIRMED');
    expect(INITIAL_PAYMENT_STATUS).toBe('pending');
  });

  it('allows exactly the transitions of the table and refuses every other pair', () => {
    for (const from of ORDER_STATUSES) {
      for (const to of ORDER_STATUSES) {
        const allowed = ALLOWED.some(([f, t]) => f === from && t === to);
        expect([from, to, canTransitionOrder(from, to)]).toEqual([from, to, allowed]);
        if (allowed) {
          expect(() => assertOrderTransition(from, to)).not.toThrow();
        } else {
          expect(() => assertOrderTransition(from, to)).toThrow(OrderStatusError);
        }
      }
    }
  });

  it('throws a coded error for an unlisted transition (no cancel after executing)', () => {
    expect(() => assertOrderTransition('PENDING_INVOICING', 'CANCELLED')).toThrow(
      expect.objectContaining({ code: 'INVALID_STATUS_TRANSITION', from: 'PENDING_INVOICING', to: 'CANCELLED' })
    );
  });

  it('treats dispatched and cancelled as terminal', () => {
    for (const terminal of ['DISPATCHED', 'CANCELLED'] as const) {
      expect(ORDER_STATUSES.filter((to) => canTransitionOrder(terminal, to))).toEqual([]);
    }
  });

  it('throws on an unknown code or name instead of guessing', () => {
    expect(() => fromOrderStatusCode('canceled')).toThrow(OrderStatusError);
    expect(() => fromOrderStatusCode('invoiced')).toThrow(OrderStatusError);
    expect(() => toOrderStatusCode('NEW' as never)).toThrow(OrderStatusError);
    expect(canTransitionOrder('NEW' as never, 'EXPIRED')).toBe(false);
  });
});

describe('wholesale order payment status (T-2.50, ADR-14 point 3)', () => {
  it('uses exactly the codes allowed by WHOLESALE_ORDER_PAYMENT_STATUS_CHECK (migration 1.1.0)', () => {
    expect(checkCodes('WHOLESALE_ORDER_PAYMENT_STATUS_CHECK').sort()).toEqual([...PAYMENT_STATUSES].sort());
  });

  it('allows exactly the transitions of the diagram and refuses every other pair', () => {
    for (const from of PAYMENT_STATUSES) {
      for (const to of PAYMENT_STATUSES) {
        const allowed = PAYMENT_ALLOWED.some(([f, t]) => f === from && t === to);
        expect([from, to, canTransitionPaymentStatus(from, to)]).toEqual([from, to, allowed]);
        if (allowed) {
          expect(() => assertPaymentStatusTransition(from, to)).not.toThrow();
        } else {
          expect(() => assertPaymentStatusTransition(from, to)).toThrow(OrderStatusError);
        }
      }
    }
  });

  it('never goes back to pending once the order was executed', () => {
    expect(PAYMENT_STATUSES.filter((from) => canTransitionPaymentStatus(from, 'pending'))).toEqual([]);
  });
});
