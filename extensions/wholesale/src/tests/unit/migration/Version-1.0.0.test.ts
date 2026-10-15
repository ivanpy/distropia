/**
 * Integration test for the wholesale schema migration (Version-1.0.0).
 *
 * Runs against the real PostgreSQL configured in `.env` (DB_* variables).
 * Everything happens inside one transaction that is rolled back at the end,
 * so the test leaves no rows (and no DDL, when the schema was not applied yet)
 * behind. Constraint violations are isolated with savepoints so the outer
 * transaction stays usable. The suite is skipped when no database is
 * configured.
 */
import 'dotenv/config';
import { randomUUID } from 'crypto';
import pg from 'pg';
import migrate from '../../../migration/Version-1.0.0.js';
import { withApprovalWrite } from '../../../services/customer/approvalWriteFlag.js';

const describeDb = process.env.DB_NAME ? describe : describe.skip;

type PgError = Error & { code?: string; constraint?: string };

describeDb('wholesale migration Version-1.0.0', () => {
  let pool: pg.Pool;
  let client: pg.PoolClient;
  let savepoint = 0;
  let productId: number;
  let customerId: number;

  /** Run a statement expected to fail; returns the error and keeps the tx alive. */
  async function expectFailure(sql: string, params: unknown[] = []): Promise<PgError> {
    const name = `sp_${(savepoint += 1)}`;
    await client.query(`SAVEPOINT ${name}`);
    try {
      await client.query(sql, params);
    } catch (e) {
      await client.query(`ROLLBACK TO SAVEPOINT ${name}`);
      return e as PgError;
    }
    await client.query(`RELEASE SAVEPOINT ${name}`);
    throw new Error(`Expected statement to fail: ${sql}`);
  }

  async function insertCustomer(phone: string | null): Promise<number> {
    const { rows } = await client.query(
      `INSERT INTO "customer" ("email", "password", "full_name", "phone")
       VALUES ($1, 'x', 'Wholesale Test', $2) RETURNING "customer_id"`,
      [`wholesale-test-${randomUUID()}@example.com`, phone]
    );
    return rows[0].customer_id as number;
  }

  async function insertQuote(
    overrides: Record<string, unknown> = {}
  ): Promise<number> {
    const data: Record<string, unknown> = {
      quote_number: `WQ-TEST-${randomUUID().slice(0, 8)}`,
      customer_id: customerId,
      tax_id: '80012345-6',
      phone: '+595981123456',
      request_ip: '203.0.113.7',
      idempotency_key: randomUUID(),
      reply_nonce: 'nonce',
      currency: 'PYG',
      expires_at: new Date(Date.now() + 72 * 3600 * 1000),
      ...overrides
    };
    const columns = Object.keys(data);
    const { rows } = await client.query(
      `INSERT INTO "wholesale_quote" (${columns.map((c) => `"${c}"`).join(', ')})
       VALUES (${columns.map((_, i) => `$${i + 1}`).join(', ')})
       RETURNING "wholesale_quote_id"`,
      Object.values(data)
    );
    return rows[0].wholesale_quote_id as number;
  }

  beforeAll(async () => {
    pool = new pg.Pool({
      host: process.env.DB_HOST,
      port: Number(process.env.DB_PORT ?? 5432),
      user: process.env.DB_USER,
      password: process.env.DB_PASSWORD,
      database: process.env.DB_NAME,
      max: 1
    });
    client = await pool.connect();
    await client.query('BEGIN');
    await migrate(client);
    // Own product fixture: never depend on seeded catalog data. Only the
    // NOT NULL columns without defaults (sku, price) are required.
    const product = await client.query(
      `INSERT INTO "product" ("sku", "price")
       VALUES ($1, 10) RETURNING "product_id"`,
      [`WHOLESALE-TEST-${randomUUID()}`]
    );
    productId = product.rows[0].product_id as number;
  });

  afterAll(async () => {
    if (client) {
      await client.query('ROLLBACK');
      client.release();
    }
    if (pool) {
      await pool.end();
    }
  });

  it('is re-executable: running it again does not fail', async () => {
    await expect(migrate(client)).resolves.toBeUndefined();
  });

  it('adds the wholesale columns to customer', async () => {
    const { rows } = await client.query(
      `SELECT "column_name", "data_type", "is_nullable", "column_default",
              "character_maximum_length"
       FROM information_schema.columns
       WHERE table_schema = current_schema() AND table_name = 'customer'`
    );
    const byName = new Map(rows.map((r) => [r.column_name as string, r]));
    expect(byName.get('business_name')).toMatchObject({
      data_type: 'character varying',
      character_maximum_length: 255,
      is_nullable: 'YES'
    });
    expect(byName.get('tax_id')).toMatchObject({
      data_type: 'character varying',
      character_maximum_length: 32
    });
    expect(byName.get('phone')).toMatchObject({
      data_type: 'character varying',
      character_maximum_length: 20
    });
    expect(byName.get('is_wholesale_approved')).toMatchObject({
      data_type: 'boolean',
      is_nullable: 'NO',
      column_default: 'false'
    });
    for (const column of [
      'wholesale_requested_at',
      'wholesale_approved_at'
    ]) {
      expect(byName.get(column)).toMatchObject({
        data_type: 'timestamp with time zone',
        is_nullable: 'YES'
      });
    }
    expect(byName.get('wholesale_approved_by')).toMatchObject({
      data_type: 'integer',
      is_nullable: 'YES'
    });
  });

  it('enforces E.164 on customer.phone', async () => {
    const error = await expectFailure(
      `INSERT INTO "customer" ("email", "password", "phone")
       VALUES ($1, 'x', '0981123456')`,
      [`wholesale-test-${randomUUID()}@example.com`]
    );
    expect(error.code).toBe('23514');
    expect(error.constraint).toBe('CUSTOMER_PHONE_E164');

    customerId = await insertCustomer('+595981123456');
    expect(customerId).toBeGreaterThan(0);
    await expect(insertCustomer(null)).resolves.toBeGreaterThan(0);
  });

  it('creates the wholesale tables', async () => {
    const { rows } = await client.query(
      `SELECT "tablename" FROM pg_tables
       WHERE schemaname = current_schema() AND tablename LIKE 'wholesale%'`
    );
    // arrayContaining: once Version-1.1.0 is applied the database holds more
    // wholesale tables (see Version-1.1.0.test.ts).
    expect(rows.map((r) => r.tablename)).toEqual(
      expect.arrayContaining([
        'wholesale_product_rule',
        'wholesale_quote',
        'wholesale_quote_item',
        'wholesale_webhook_event'
      ])
    );
  });

  it('creates every named constraint', async () => {
    const { rows } = await client.query(
      `SELECT "conname" FROM pg_constraint
       WHERE conrelid IN (
         'customer'::regclass, 'wholesale_product_rule'::regclass,
         'wholesale_quote'::regclass, 'wholesale_quote_item'::regclass,
         'wholesale_webhook_event'::regclass
       )`
    );
    const names = rows.map((r) => r.conname as string);
    expect(names).toEqual(
      expect.arrayContaining([
        'CUSTOMER_PHONE_E164',
        'WHOLESALE_PRODUCT_RULE_UUID_UNIQUE',
        'WHOLESALE_PRODUCT_RULE_PRODUCT_UNIQUE',
        'FK_WHOLESALE_RULE_PRODUCT',
        'WHOLESALE_RULE_QTY_CHECK',
        'WHOLESALE_RULE_TIERS_ARRAY',
        'WHOLESALE_QUOTE_UUID_UNIQUE',
        'WHOLESALE_QUOTE_NUMBER_UNIQUE',
        'WHOLESALE_QUOTE_IDEMPOTENCY_UNIQUE',
        'WHOLESALE_QUOTE_ORDER_UNIQUE',
        'FK_WHOLESALE_QUOTE_CUSTOMER',
        'FK_WHOLESALE_QUOTE_ORDER',
        'WHOLESALE_QUOTE_STATUS_CHECK',
        'WHOLESALE_QUOTE_ITEM_UUID_UNIQUE',
        'FK_WHOLESALE_QUOTE_ITEM_QUOTE',
        'FK_WHOLESALE_QUOTE_ITEM_PRODUCT',
        'WHOLESALE_QUOTE_ITEM_QTY_CHECK',
        'WHOLESALE_QUOTE_ITEM_DISCOUNT_CHECK',
        'WHOLESALE_WEBHOOK_EVENT_EXTERNAL_UNIQUE',
        'FK_WHOLESALE_WEBHOOK_QUOTE',
        'WHOLESALE_WEBHOOK_STATUS_CHECK'
      ])
    );
    // The E.164 guard must not be duplicated by the second run.
    expect(names.filter((n) => n === 'CUSTOMER_PHONE_E164')).toHaveLength(1);
  });

  it('references the real core tables from the foreign keys', async () => {
    const { rows } = await client.query(
      `SELECT "conname", confrelid::regclass::text AS "target"
       FROM pg_constraint
       WHERE contype = 'f' AND conname LIKE 'FK_WHOLESALE%'`
    );
    const targets = Object.fromEntries(
      rows.map((r) => [r.conname as string, r.target as string])
    );
    expect(targets).toMatchObject({
      FK_WHOLESALE_RULE_PRODUCT: 'product',
      FK_WHOLESALE_QUOTE_CUSTOMER: 'customer',
      FK_WHOLESALE_QUOTE_ORDER: '"order"',
      FK_WHOLESALE_QUOTE_ITEM_QUOTE: 'wholesale_quote',
      FK_WHOLESALE_QUOTE_ITEM_PRODUCT: 'product',
      FK_WHOLESALE_WEBHOOK_QUOTE: 'wholesale_quote'
    });
  });

  it('creates every index', async () => {
    const { rows } = await client.query(
      `SELECT "indexname" FROM pg_indexes
       WHERE schemaname = current_schema()
         AND tablename IN ('customer', 'wholesale_product_rule',
           'wholesale_quote', 'wholesale_quote_item')`
    );
    expect(rows.map((r) => r.indexname)).toEqual(
      expect.arrayContaining([
        'CUSTOMER_TAX_ID_WHOLESALE_UNIQUE',
        'CUSTOMER_WHOLESALE_PENDING',
        'WHOLESALE_RULE_ENABLED',
        'WHOLESALE_QUOTE_CUSTOMER_CREATED',
        'WHOLESALE_QUOTE_TAX_ID_CREATED',
        'WHOLESALE_QUOTE_IP_CREATED',
        'WHOLESALE_QUOTE_OPEN_EXPIRES',
        'WHOLESALE_QUOTE_WA_MESSAGE',
        'FK_WHOLESALE_QUOTE_ITEM_QUOTE'
      ])
    );
  });

  it('allows one wholesale account per tax id', async () => {
    // Migration 1.1.1 protects wholesale_requested_at on UPDATE (approval write flag).
    await withApprovalWrite(client, () =>
      client.query(
        `UPDATE "customer" SET "tax_id" = 'TEST-TAX-1', "wholesale_requested_at" = now()
         WHERE "customer_id" = $1`,
        [customerId]
      )
    );
    const error = await expectFailure(
      `INSERT INTO "customer" ("email", "password", "tax_id", "wholesale_requested_at")
       VALUES ($1, 'x', 'TEST-TAX-1', now())`,
      [`wholesale-test-${randomUUID()}@example.com`]
    );
    expect(error.code).toBe('23505');
    expect(error.constraint).toBe('CUSTOMER_TAX_ID_WHOLESALE_UNIQUE');
  });

  it('scopes tax id uniqueness to wholesale requests with a tax id', async () => {
    const insert = `INSERT INTO "customer"
      ("email", "password", "tax_id", "wholesale_requested_at")
      VALUES ($1, 'x', $2, $3)`;
    const email = () => `wholesale-test-${randomUUID()}@example.com`;
    // Outside the predicate (no wholesale request): duplicates are allowed,
    // both against each other and against the wholesale account above.
    await client.query(insert, [email(), 'TEST-TAX-1', null]);
    await client.query(insert, [email(), 'TEST-TAX-1', null]);
    // Outside the predicate (no tax id): many requesters may coexist.
    await client.query(insert, [email(), null, new Date()]);
    await client.query(insert, [email(), null, new Date()]);
    // Inside the predicate with a fresh tax id: first wins, second collides.
    await client.query(insert, [email(), 'TEST-TAX-2', new Date()]);
    const error = await expectFailure(insert, [email(), 'TEST-TAX-2', new Date()]);
    expect(error.code).toBe('23505');
    expect(error.constraint).toBe('CUSTOMER_TAX_ID_WHOLESALE_UNIQUE');
  });

  it('validates wholesale_product_rule quantities and tiers', async () => {
    const insert = `INSERT INTO "wholesale_product_rule"
      ("product_id", "min_qty", "step_qty", "max_qty", "tiers")
      VALUES ($1, $2, $3, $4, $5::jsonb)`;
    // Remove a pre-existing rule for this product (rolled back at the end).
    await client.query(
      'DELETE FROM "wholesale_product_rule" WHERE "product_id" = $1',
      [productId]
    );

    for (const [min, step, max] of [
      [0, 1, null],
      [1, 0, null],
      [12, 6, 6]
    ]) {
      const error = await expectFailure(insert, [productId, min, step, max, '[]']);
      expect(error.constraint).toBe('WHOLESALE_RULE_QTY_CHECK');
    }
    const notArray = await expectFailure(insert, [productId, 12, 6, null, '{}']);
    expect(notArray.constraint).toBe('WHOLESALE_RULE_TIERS_ARRAY');

    await client.query(insert, [
      productId,
      12,
      6,
      null,
      JSON.stringify([{ from_qty: 12, discount_percent: 0 }])
    ]);
    const duplicate = await expectFailure(insert, [productId, 12, 6, null, '[]']);
    expect(duplicate.constraint).toBe('WHOLESALE_PRODUCT_RULE_PRODUCT_UNIQUE');
  });

  it('validates wholesale_quote status and idempotency', async () => {
    const badStatus = await expectFailure(
      `INSERT INTO "wholesale_quote"
       ("quote_number", "customer_id", "tax_id", "phone", "idempotency_key",
        "reply_nonce", "status", "currency", "expires_at")
       VALUES ('WQ-TEST-BAD', $1, 'T', '+595981123456', $2, 'n', 'bogus', 'PYG', now())`,
      [customerId, randomUUID()]
    );
    expect(badStatus.constraint).toBe('WHOLESALE_QUOTE_STATUS_CHECK');

    const key = randomUUID();
    await insertQuote({ idempotency_key: key });
    const duplicate = await expectFailure(
      `INSERT INTO "wholesale_quote"
       ("quote_number", "customer_id", "tax_id", "phone", "idempotency_key",
        "reply_nonce", "currency", "expires_at")
       VALUES ('WQ-TEST-DUP', $1, 'T', '+595981123456', $2, 'n', 'PYG', now())`,
      [customerId, key]
    );
    expect(duplicate.constraint).toBe('WHOLESALE_QUOTE_IDEMPOTENCY_UNIQUE');
  });

  it('validates wholesale_quote_item qty and discount', async () => {
    const quoteId = await insertQuote();
    const insert = `INSERT INTO "wholesale_quote_item"
      ("wholesale_quote_id", "product_id", "product_sku", "product_name",
       "qty", "unit_price", "discount_percent", "line_total")
      VALUES ($1, $2, 'SKU', 'Name', $3, 10, $4, 10)`;
    const zeroQty = await expectFailure(insert, [quoteId, productId, 0, 0]);
    expect(zeroQty.constraint).toBe('WHOLESALE_QUOTE_ITEM_QTY_CHECK');
    const badDiscount = await expectFailure(insert, [quoteId, productId, 12, 101]);
    expect(badDiscount.constraint).toBe('WHOLESALE_QUOTE_ITEM_DISCOUNT_CHECK');
    await expect(
      client.query(insert, [quoteId, productId, 12, 5])
    ).resolves.toBeDefined();
  });

  it('deduplicates wholesale_webhook_event by external_id', async () => {
    const insert = `INSERT INTO "wholesale_webhook_event"
      ("external_id", "event_type", "payload", "processing_status")
      VALUES ($1, 'message', '{}'::jsonb, $2)`;
    const externalId = `wamid.TEST-${randomUUID()}`;
    await client.query(insert, [externalId, 'received']);
    const duplicate = await expectFailure(insert, [externalId, 'received']);
    expect(duplicate.constraint).toBe('WHOLESALE_WEBHOOK_EVENT_EXTERNAL_UNIQUE');
    const badStatus = await expectFailure(insert, [`${externalId}-2`, 'bogus']);
    expect(badStatus.constraint).toBe('WHOLESALE_WEBHOOK_STATUS_CHECK');
  });

  it('refreshes updated_at on UPDATE', async () => {
    // CURRENT_TIMESTAMP is frozen inside a transaction, so seed an old value.
    const quoteId = await insertQuote({ updated_at: '2000-01-01T00:00:00Z' });
    const { rows } = await client.query(
      `UPDATE "wholesale_quote" SET "status" = 'sent'
       WHERE "wholesale_quote_id" = $1 RETURNING "updated_at"`,
      [quoteId]
    );
    expect((rows[0].updated_at as Date).getUTCFullYear()).toBeGreaterThan(2000);

    // Seed through INSERT: an UPDATE would be overwritten by the trigger itself.
    await client.query(
      'DELETE FROM "wholesale_product_rule" WHERE "product_id" = $1',
      [productId]
    );
    await client.query(
      `INSERT INTO "wholesale_product_rule" ("product_id", "updated_at")
       VALUES ($1, '2000-01-01T00:00:00Z')`,
      [productId]
    );
    const rule = await client.query(
      `UPDATE "wholesale_product_rule" SET "step_qty" = 12
       WHERE "product_id" = $1 RETURNING "updated_at"`,
      [productId]
    );
    expect(
      (rule.rows[0].updated_at as Date).getUTCFullYear()
    ).toBeGreaterThan(2000);
  });

  it('lets the rate-limit query use the wholesale_quote indexes', async () => {
    await client.query('SAVEPOINT explain_sp');
    await client.query('SET LOCAL enable_seqscan = off');
    const { rows } = await client.query(
      `EXPLAIN SELECT COUNT(*) FROM wholesale_quote
       WHERE created_at > now() - interval '1 day'
         AND (customer_id = $1 OR tax_id = $2 OR request_ip = $3)`,
      [customerId, '80012345-6', '203.0.113.7']
    );
    await client.query('ROLLBACK TO SAVEPOINT explain_sp');
    const plan = rows.map((r) => r['QUERY PLAN'] as string).join('\n');
    expect(plan).toMatch(/WHOLESALE_QUOTE_(CUSTOMER|TAX_ID|IP)_CREATED/);
  });
});
