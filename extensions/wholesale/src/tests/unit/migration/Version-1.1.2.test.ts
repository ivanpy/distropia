/**
 * Integration test for migration Version-1.1.2 (W6b): the quote number
 * sequence and the nullable `wholesale_quote.expires_at`.
 *
 * Runs in the rolled-back fixture transaction (1.0.0 first, then 1.1.0 and
 * 1.1.2); a quote numbered with the 1.0.0 schema exists before 1.1.2 runs,
 * so the sequence must start past it.
 */
import { randomUUID } from 'crypto';
import migrate110 from '../../../migration/Version-1.1.0.js';
import migrate112 from '../../../migration/Version-1.1.2.js';
import { describeDb, openFixtures, type Fixtures } from '../graphql/storefrontSchema.js';

describeDb('wholesale migration Version-1.1.2', () => {
  let fixtures: Fixtures;
  let customerId: number;

  beforeAll(async () => {
    fixtures = await openFixtures();
    await migrate110(fixtures.client);
    const customer = await fixtures.insertCustomer(false);
    customerId = customer.customer_id as number;
    // A quote numbered before the sequence exists (expires_at still NOT NULL here).
    await fixtures.client.query(
      `INSERT INTO "wholesale_quote" ("quote_number", "customer_id", "tax_id", "phone", "idempotency_key",
                                      "reply_nonce", "currency", "expires_at")
       VALUES ('WQ-2026-000500', $1, '80012344-1', '+595981123456', $2, 'abcdefgh', 'PYG', CURRENT_TIMESTAMP)`,
      [customerId, randomUUID()]
    );
    await migrate112(fixtures.client);
  }, 30000);

  afterAll(async () => {
    await fixtures?.close();
  });

  const nextval = async (): Promise<number> =>
    Number((await fixtures.client.query(`SELECT nextval('"wholesale_quote_number_seq"') AS "value"`)).rows[0].value);

  it('starts the sequence past the highest quote number already stored', async () => {
    expect(await nextval()).toBe(501);
  });

  it('is re-runnable and never moves the sequence backwards', async () => {
    const before = await nextval();
    await migrate112(fixtures.client);
    expect(await nextval()).toBe(before + 1);
  });

  it('makes expires_at nullable (it starts at the WhatsApp send)', async () => {
    const { rows } = await fixtures.client.query(
      `SELECT "is_nullable" FROM information_schema.columns
        WHERE table_schema = current_schema() AND table_name = 'wholesale_quote' AND column_name = 'expires_at'`
    );
    expect(rows).toEqual([{ is_nullable: 'YES' }]);
    await fixtures.client.query(
      `INSERT INTO "wholesale_quote" ("quote_number", "customer_id", "tax_id", "phone", "idempotency_key",
                                      "reply_nonce", "currency")
       VALUES ('WQ-2026-000900', $1, '80012344-1', '+595981123456', $2, 'abcdefgh', 'PYG')`,
      [customerId, randomUUID()]
    );
  });
});
