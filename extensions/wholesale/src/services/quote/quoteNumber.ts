/**
 * Quote number `WQ-YYYY-NNNNNN` (T-2.19).
 *
 * `NNNNNN` comes from `wholesale_quote_number_seq` (migration 1.1.2): a
 * PostgreSQL sequence never returns the same value twice, whatever the number
 * of concurrent sessions, so two quotes never share a number and creations of
 * different customers do not wait on each other. The counter is global (it
 * does not restart each year) and has gaps where a creation rolled back;
 * quote numbers are references, not fiscal numbers. `UNIQUE (quote_number)`
 * (1.0.0) stays as the last guard.
 *
 * `YYYY` is the creation year in the store time zone.
 */
import type { Queryable } from '../rule/ruleRow.js';

export const QUOTE_NUMBER_SEQUENCE = 'wholesale_quote_number_seq';

/** `WQ-2026-000123`; more than six digits are kept, never truncated. */
export function formatQuoteNumber(year: number, value: number): string {
  if (!Number.isInteger(year) || year < 1000 || year > 9999) {
    throw new Error(`Invalid quote number year ${year}`);
  }
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`Invalid quote number sequence value ${value}`);
  }
  return `WQ-${year}-${String(value).padStart(6, '0')}`;
}

/** Calendar year of `instant` in `timeZone` (UTC when the zone is unknown). */
export function quoteNumberYear(instant: Date, timeZone: string): number {
  const yearIn = (zone: string) =>
    Number(new Intl.DateTimeFormat('en-US', { timeZone: zone, year: 'numeric' }).format(instant));
  try {
    return yearIn(timeZone);
  } catch {
    return yearIn('UTC');
  }
}

/** Draws the next quote number; run it on the creation transaction's connection. */
export async function nextQuoteNumber(db: Queryable, instant: Date, timeZone: string): Promise<string> {
  const { rows } = await db.query<{ value: string }>(`SELECT nextval('"${QUOTE_NUMBER_SEQUENCE}"') AS "value"`);
  return formatQuoteNumber(quoteNumberYear(instant, timeZone), Number(rows[0].value));
}
