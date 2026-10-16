/**
 * T-2.51: the response of `POST /api/wholesale/request-quote`
 * (`03_endpoints_y_contratos.md` §2) — canonical status, `freightLabel`,
 * `expiresAt` null until sent, masked phone and no amounts.
 */
import { maskPhone, toRequestQuoteResponse } from '../../../services/quote/requestQuoteResponse.js';

describe('toRequestQuoteResponse (T-2.51)', () => {
  const base = {
    uuid: 'c4d2e8a0-5b6f-4a1e-8f0d-2b9c7e6a5d41',
    quoteNumber: 'WQ-2026-000123',
    expiresAt: null,
    phone: '+595981123456'
  };

  it('answers a free-freight quote as DRAFT_QUOTE with the contract shape', () => {
    expect(toRequestQuoteResponse({ ...base, status: 'DRAFT_QUOTE', freightLabel: 'free' })).toEqual({
      uuid: base.uuid,
      quoteNumber: 'WQ-2026-000123',
      status: 'DRAFT_QUOTE',
      freightLabel: 'free',
      expiresAt: null,
      maskedPhone: '+595 9•• ••• 456'
    });
  });

  it('answers a special-freight quote as AWAITING_SHIPPING_QUOTE', () => {
    expect(toRequestQuoteResponse({ ...base, status: 'AWAITING_SHIPPING_QUOTE', freightLabel: 'special' })).toMatchObject({
      status: 'AWAITING_SHIPPING_QUOTE',
      freightLabel: 'special'
    });
  });

  it('keeps the current canonical status of a replayed quote', () => {
    expect(
      toRequestQuoteResponse({
        ...base,
        status: 'QUOTE_SENT',
        freightLabel: 'free',
        expiresAt: '2026-10-19T12:00:00.000Z'
      })
    ).toMatchObject({ status: 'QUOTE_SENT', expiresAt: '2026-10-19T12:00:00.000Z' });
  });

  it('carries no amount and never the full phone', () => {
    const body = toRequestQuoteResponse({ ...base, status: 'DRAFT_QUOTE', freightLabel: 'free' });
    expect(Object.keys(body).sort()).toEqual(['expiresAt', 'freightLabel', 'maskedPhone', 'quoteNumber', 'status', 'uuid']);
    expect(JSON.stringify(body)).not.toContain('981123456');
  });
});

describe('maskPhone (T-2.51)', () => {
  it.each([
    ['+595981123456', '+595 9•• ••• 456'],
    ['+595211234567', '+595 2•• ••• 567'],
    ['+59598112345', '+595 9• ••• 345']
  ])('masks %s', (phone, masked) => {
    expect(maskPhone(phone)).toBe(masked);
  });

  it('keeps only the country code, the first subscriber digit and the last three digits', () => {
    const masked = maskPhone('+12025550123');
    expect(masked.startsWith('+120 2')).toBe(true);
    expect(masked.endsWith('123')).toBe(true);
    expect(masked.replace(/[^0-9]/g, '')).toBe('1202123');
  });

  it('masks everything it cannot read as E.164', () => {
    expect(maskPhone('')).toBe('•••');
    expect(maskPhone('12345')).toBe('•••');
  });
});
