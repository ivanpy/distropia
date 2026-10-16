/**
 * T-2.19 / T-2.20: quote number `WQ-YYYY-NNNNNN` (unique under concurrency)
 * and the WhatsApp reply nonce (`crypto.randomBytes`).
 *
 * The concurrency case runs on a scratch database (`scratchDatabase.ts`):
 * several sessions draw numbers at the same time from the 1.1.2 sequence.
 */
import { formatQuoteNumber, nextQuoteNumber, quoteNumberYear } from '../../../services/quote/quoteNumber.js';
import { generateReplyNonce, REPLY_NONCE_PATTERN } from '../../../services/quote/replyNonce.js';
import { describeDb, openScratchDatabase, type ScratchDatabase } from './scratchDatabase.js';

describe('formatQuoteNumber (T-2.19)', () => {
  it('pads the sequence value to six digits', () => {
    expect(formatQuoteNumber(2026, 123)).toBe('WQ-2026-000123');
    expect(formatQuoteNumber(2027, 1)).toBe('WQ-2027-000001');
    expect(formatQuoteNumber(2026, 999999)).toBe('WQ-2026-999999');
  });

  it('keeps every digit past 999999 instead of truncating (unique numbers stay unique)', () => {
    expect(formatQuoteNumber(2026, 1234567)).toBe('WQ-2026-1234567');
  });

  it.each([
    [2026, 0],
    [2026, -1],
    [2026, 1.5],
    [999, 1],
    [10000, 1]
  ])('refuses year %d with value %d', (year, value) => {
    expect(() => formatQuoteNumber(year, value)).toThrow(/quote number/);
  });
});

describe('quoteNumberYear (T-2.19)', () => {
  it('takes the year in the store time zone', () => {
    // 02:00 UTC on 1 January is still 31 December in Asunción (UTC-3).
    const instant = new Date('2027-01-01T02:00:00Z');
    expect(quoteNumberYear(instant, 'America/Asuncion')).toBe(2026);
    expect(quoteNumberYear(instant, 'UTC')).toBe(2027);
  });

  it('falls back to UTC for an unknown time zone', () => {
    expect(quoteNumberYear(new Date('2027-01-01T02:00:00Z'), 'Not/AZone')).toBe(2027);
  });
});

describe('generateReplyNonce (T-2.20)', () => {
  it('encodes 16 random bytes from crypto.randomBytes as 32 hex characters', () => {
    const calls: number[] = [];
    const nonce = generateReplyNonce((size) => {
      calls.push(size);
      return Buffer.from('00112233445566778899aabbccddeeff', 'hex');
    });
    expect(calls).toEqual([16]);
    expect(nonce).toBe('00112233445566778899aabbccddeeff');
  });

  it('fits wholesale_quote.reply_nonce (varchar(32)), is at least 8 characters and safe in a button payload', () => {
    const nonce = generateReplyNonce();
    expect(nonce).toMatch(REPLY_NONCE_PATTERN);
    expect(nonce.length).toBe(32);
    // The button payload is `ACCEPT:<uuid>:<nonce>`: the nonce never carries a colon.
    expect(`ACCEPT:c4d2e8a0-5b6f-4a1e-8f0d-2b9c7e6a5d41:${nonce}`).toMatch(/^(ACCEPT|REJECT):[0-9a-f-]{36}:[0-9a-f]{32}$/);
  });

  it('does not repeat across 1000 draws', () => {
    const nonces = new Set(Array.from({ length: 1000 }, () => generateReplyNonce()));
    expect(nonces.size).toBe(1000);
  });
});

describeDb('nextQuoteNumber under concurrency (T-2.19)', () => {
  let scratch: ScratchDatabase;

  beforeAll(async () => {
    scratch = await openScratchDatabase(8);
  }, 60000);

  afterAll(async () => {
    await scratch?.close();
  }, 60000);

  it('hands out distinct numbers to 40 draws from 8 concurrent transactions', async () => {
    const draw = async (): Promise<string[]> => {
      const client = await scratch.pool.connect();
      try {
        await client.query('BEGIN');
        const numbers: string[] = [];
        for (let i = 0; i < 5; i += 1) {
          numbers.push(await nextQuoteNumber(client, new Date('2026-10-16T12:00:00Z'), 'UTC'));
        }
        await client.query('COMMIT');
        return numbers;
      } finally {
        client.release();
      }
    };
    const numbers = (await Promise.all(Array.from({ length: 8 }, draw))).flat();
    expect(numbers).toHaveLength(40);
    expect(new Set(numbers).size).toBe(40);
    for (const n of numbers) {
      expect(n).toMatch(/^WQ-2026-\d{6}$/);
    }
  }, 30000);

  it('does not reuse the number of a rolled-back creation', async () => {
    const client = await scratch.pool.connect();
    try {
      await client.query('BEGIN');
      const lost = await nextQuoteNumber(client, new Date('2026-10-16T12:00:00Z'), 'UTC');
      await client.query('ROLLBACK');
      const next = await nextQuoteNumber(client, new Date('2026-10-16T12:00:00Z'), 'UTC');
      expect(next).not.toBe(lost);
    } finally {
      client.release();
    }
  });
});
