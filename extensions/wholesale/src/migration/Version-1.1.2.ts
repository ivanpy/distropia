import { execute } from '@evershop/postgres-query-builder';
import type { PoolClient } from '@evershop/postgres-query-builder';

/**
 * Wholesale schema 1.1.2 (W6b, quote persistence).
 *
 * 1. `wholesale_quote_number_seq` feeds `quote_number` (`WQ-YYYY-NNNNNN`,
 *    T-2.19). A sequence never hands the same value to two sessions, so
 *    concurrent quote creations of different customers get distinct numbers
 *    without serializing on a counter row; a rolled-back creation leaves a
 *    gap (quote numbers are not fiscal numbers). When quotes already exist,
 *    the sequence is moved past the highest numeric suffix stored.
 * 2. `wholesale_quote.expires_at` becomes nullable: the expiration runs from
 *    the WhatsApp send (`sent_at`, RF-16, data model §5), so a quote is
 *    created without it and an `AWAITING_SHIPPING_QUOTE` quote never expires
 *    (P-3). Migration 1.0.0 declared it NOT NULL.
 *
 * Idempotent: CREATE SEQUENCE IF NOT EXISTS, a `setval` that never moves the
 * sequence backwards and DROP NOT NULL (a no-op on a nullable column). The
 * core runner wraps this function in a transaction and records the version;
 * do not open BEGIN/COMMIT here. Never edit this file once applied.
 */
export default async (connection: PoolClient): Promise<void> => {
  await execute(
    connection,
    `CREATE SEQUENCE IF NOT EXISTS "wholesale_quote_number_seq" AS bigint START WITH 1 INCREMENT BY 1 MINVALUE 1`
  );
  await execute(
    connection,
    `DO $$
     DECLARE
       highest bigint;
     BEGIN
       SELECT max(substring("quote_number" FROM '^WQ-[0-9]{4}-([0-9]+)$')::bigint) INTO highest
         FROM "wholesale_quote";
       IF highest IS NOT NULL THEN
         PERFORM setval('"wholesale_quote_number_seq"',
                        GREATEST(highest, (SELECT last_value FROM "wholesale_quote_number_seq")));
       END IF;
     END $$`
  );
  await execute(connection, `ALTER TABLE "wholesale_quote" ALTER COLUMN "expires_at" DROP NOT NULL`);
};
