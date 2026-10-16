/**
 * T-2.50 (ADR-14, data model §5): canonical quote statuses ↔ stored codes and
 * the allowed transitions. Codes must match WHOLESALE_QUOTE_STATUS_CHECK of
 * migration 1.1.0.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  assertQuoteTransition,
  canTransitionQuote,
  fromQuoteStatusCode,
  INITIAL_QUOTE_STATUS,
  QUOTE_STATUSES,
  type QuoteStatus,
  QuoteStatusError,
  toQuoteStatusCode
} from '../../../services/quote/statuses.js';

const MAPPING: [QuoteStatus, string][] = [
  ['DRAFT_QUOTE', 'pending'],
  ['AWAITING_SHIPPING_QUOTE', 'awaiting_freight'],
  ['QUOTE_SENT', 'sent'],
  ['QUOTE_APPROVED', 'accepted'],
  ['QUOTE_REJECTED', 'rejected'],
  ['QUOTE_EXPIRED', 'expired'],
  ['SEND_FAILED', 'failed']
];

const ALLOWED: [QuoteStatus, QuoteStatus][] = [
  ['DRAFT_QUOTE', 'QUOTE_SENT'],
  ['DRAFT_QUOTE', 'AWAITING_SHIPPING_QUOTE'],
  ['DRAFT_QUOTE', 'SEND_FAILED'],
  ['AWAITING_SHIPPING_QUOTE', 'QUOTE_SENT'],
  ['AWAITING_SHIPPING_QUOTE', 'SEND_FAILED'],
  ['QUOTE_SENT', 'QUOTE_APPROVED'],
  ['QUOTE_SENT', 'QUOTE_REJECTED'],
  ['QUOTE_SENT', 'QUOTE_EXPIRED']
];

describe('quote statuses (T-2.50)', () => {
  it('maps every canonical name to its stored code and back', () => {
    expect([...QUOTE_STATUSES]).toEqual(MAPPING.map(([name]) => name));
    for (const [name, code] of MAPPING) {
      expect(toQuoteStatusCode(name)).toBe(code);
      expect(fromQuoteStatusCode(code)).toBe(name);
    }
  });

  it('uses exactly the codes allowed by WHOLESALE_QUOTE_STATUS_CHECK (migration 1.1.0)', () => {
    const migration = readFileSync(
      fileURLToPath(new URL('../../../../src/migration/Version-1.1.0.ts', import.meta.url)),
      'utf8'
    );
    const check = /ADD CONSTRAINT "WHOLESALE_QUOTE_STATUS_CHECK"\s+CHECK \("status" IN \(([^)]*)\)\)/.exec(migration);
    expect(check).not.toBeNull();
    const codes = [...(check as RegExpExecArray)[1].matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
    expect(codes.sort()).toEqual(MAPPING.map(([, code]) => code).sort());
  });

  it('starts every quote in DRAFT_QUOTE', () => {
    expect(INITIAL_QUOTE_STATUS).toBe('DRAFT_QUOTE');
  });

  it('allows exactly the transitions of the table and refuses every other pair', () => {
    for (const from of QUOTE_STATUSES) {
      for (const to of QUOTE_STATUSES) {
        const allowed = ALLOWED.some(([f, t]) => f === from && t === to);
        expect([from, to, canTransitionQuote(from, to)]).toEqual([from, to, allowed]);
        if (allowed) {
          expect(() => assertQuoteTransition(from, to)).not.toThrow();
        } else {
          expect(() => assertQuoteTransition(from, to)).toThrow(QuoteStatusError);
        }
      }
    }
  });

  it('throws a coded error naming both statuses for an unlisted transition', () => {
    expect(() => assertQuoteTransition('QUOTE_EXPIRED', 'QUOTE_SENT')).toThrow(
      expect.objectContaining({ code: 'INVALID_STATUS_TRANSITION', from: 'QUOTE_EXPIRED', to: 'QUOTE_SENT' })
    );
  });

  it('treats approved, rejected, expired and failed as terminal', () => {
    for (const terminal of ['QUOTE_APPROVED', 'QUOTE_REJECTED', 'QUOTE_EXPIRED', 'SEND_FAILED'] as const) {
      expect(QUOTE_STATUSES.filter((to) => canTransitionQuote(terminal, to))).toEqual([]);
    }
  });

  it('throws on an unknown code or name instead of guessing', () => {
    expect(() => fromQuoteStatusCode('canceled')).toThrow(QuoteStatusError);
    expect(() => toQuoteStatusCode('PENDING' as never)).toThrow(QuoteStatusError);
    expect(() => assertQuoteTransition('NOPE' as never, 'QUOTE_SENT')).toThrow(QuoteStatusError);
    expect(canTransitionQuote('NOPE' as never, 'QUOTE_SENT')).toBe(false);
  });
});
