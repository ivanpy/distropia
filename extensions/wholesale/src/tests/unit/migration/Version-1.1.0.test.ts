/**
 * Integration test for the wholesale schema migration Version-1.1.0
 * (data model section 7).
 *
 * Runs against the real PostgreSQL configured in `.env` (DB_* variables)
 * inside one transaction that is rolled back at the end, so neither rows nor
 * DDL are left behind. Constraint violations are isolated with savepoints.
 * The suite is skipped when no database is configured.
 *
 * Version-1.0.0 is applied first (in the same transaction) only when the
 * database does not have it yet, to keep table locks short while other
 * suites run in parallel.
 */
import 'dotenv/config';
import { randomUUID } from 'crypto';
import pg from 'pg';
import migrate100 from '../../../migration/Version-1.0.0.js';
import migrate110 from '../../../migration/Version-1.1.0.js';
import { withApprovalWrite } from '../../../services/customer/approvalWriteFlag.js';

const describeDb = process.env.DB_NAME ? describe : describe.skip;

type PgError = Error & { code?: string; constraint?: string };

const NEW_TABLES = [
  'wholesale_admin_profile',
  'wholesale_audit_log',
  'wholesale_customer_credit',
  'wholesale_demo_message',
  'wholesale_demo_setting',
  'wholesale_driver',
  'wholesale_fiscal_issuer',
  'wholesale_fiscal_sequence',
  'wholesale_invoice',
  'wholesale_invoice_item',
  'wholesale_notification',
  'wholesale_order',
  'wholesale_payment',
  'wholesale_payment_allocation',
  'wholesale_product_line',
  'wholesale_product_line_tier',
  'wholesale_remission_note',
  'wholesale_remission_note_item',
  'wholesale_sifen_document',
  'wholesale_vehicle'
];

const SCHEMA_TABLES_SQL = `(
  SELECT c.oid FROM pg_class c
  WHERE c.relnamespace = current_schema()::regnamespace
    AND (c.relname LIKE 'wholesale%' OR c.relname IN ('cart', 'order', 'customer'))
)`;

describeDb('wholesale migration Version-1.1.0', () => {
  let pool: pg.Pool;
  let client: pg.PoolClient;
  let savepoint = 0;
  let approvedCustomerId: number;
  let pendingCustomerId: number;
  let firstRunSnapshot: string;

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

  async function insertRow(
    table: string,
    data: Record<string, unknown>,
    returning: string
  ): Promise<number> {
    const columns = Object.keys(data);
    const { rows } = await client.query(
      `INSERT INTO "${table}" (${columns.map((c) => `"${c}"`).join(', ')})
       VALUES (${columns.map((_, i) => `$${i + 1}`).join(', ')})
       RETURNING "${returning}"`,
      Object.values(data)
    );
    return rows[0][returning] as number;
  }

  async function insertCustomer(approved: boolean): Promise<number> {
    // Migration 1.1.1 (approval trigger): an approved row needs the approval write flag.
    return withApprovalWrite(client, () => insertRow(
      'customer',
      {
        email: `wholesale-test-${randomUUID()}@example.com`,
        password: 'x',
        full_name: 'Wholesale 1.1.0 Test',
        is_wholesale_approved: approved
      },
      'customer_id'
    ));
  }

  async function insertQuote(overrides: Record<string, unknown> = {}): Promise<number> {
    return insertRow(
      'wholesale_quote',
      {
        quote_number: `WQ-TEST-${randomUUID().slice(0, 8)}`,
        customer_id: approvedCustomerId,
        tax_id: '80012344-1',
        phone: '+595981123456',
        idempotency_key: randomUUID(),
        reply_nonce: 'nonce',
        currency: 'PYG',
        expires_at: new Date(Date.now() + 72 * 3600 * 1000),
        ...overrides
      },
      'wholesale_quote_id'
    );
  }

  /** Opening invoice: net 1000 at 10 % -> 1100. */
  async function insertInvoice(overrides: Record<string, unknown> = {}): Promise<number> {
    return insertRow(
      'wholesale_invoice',
      {
        customer_id: approvedCustomerId,
        source: 'opening',
        condition: 'credit',
        invoice_number: `OPEN-${randomUUID().slice(0, 8)}`,
        issue_date: '2026-10-01',
        due_date: '2026-10-31',
        currency: 'PYG',
        net_total: 1000,
        vat_total: 100,
        grand_total: 1100,
        d_sub_10: 1100,
        d_base_grav_10: 1000,
        d_iva_10: 100,
        d_tot_ope: 1100,
        ...overrides
      },
      'wholesale_invoice_id'
    );
  }

  async function insertPayment(amount: number): Promise<number> {
    return insertRow(
      'wholesale_payment',
      {
        customer_id: approvedCustomerId,
        amount,
        method: 'cash',
        received_at: '2026-10-02',
        recorded_by: 1
      },
      'wholesale_payment_id'
    );
  }

  /** Every schema object 1.1.0 touches, with constraint oids (drop + re-add changes them). */
  async function schemaSnapshot(): Promise<string> {
    const constraints = await client.query(
      `SELECT conrelid::regclass::text AS rel, conname, oid::int AS oid,
              pg_get_constraintdef(oid) AS def, convalidated
       FROM pg_constraint WHERE conrelid IN ${SCHEMA_TABLES_SQL}
       ORDER BY 1, 2`
    );
    const indexes = await client.query(
      `SELECT tablename, indexname, indexdef FROM pg_indexes
       WHERE schemaname = current_schema()
         AND (tablename LIKE 'wholesale%' OR tablename IN ('cart', 'order', 'customer'))
       ORDER BY 1, 2`
    );
    const columns = await client.query(
      `SELECT table_name, column_name, data_type, column_default, is_nullable,
              character_maximum_length
       FROM information_schema.columns
       WHERE table_schema = current_schema()
         AND (table_name LIKE 'wholesale%' OR table_name IN ('cart', 'order', 'customer'))
       ORDER BY 1, 2`
    );
    const triggers = await client.query(
      `SELECT tgrelid::regclass::text AS rel, tgname, pg_get_triggerdef(oid) AS def
       FROM pg_trigger WHERE NOT tgisinternal AND tgrelid IN ${SCHEMA_TABLES_SQL}
       ORDER BY 1, 2`
    );
    const views = await client.query(
      `SELECT viewname, definition FROM pg_views
       WHERE schemaname = current_schema() AND viewname LIKE 'wholesale%'
       ORDER BY 1`
    );
    return JSON.stringify({
      constraints: constraints.rows,
      indexes: indexes.rows,
      columns: columns.rows,
      triggers: triggers.rows,
      views: views.rows
    });
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
    const { rows } = await client.query(
      `SELECT to_regclass('wholesale_quote') IS NOT NULL AS applied`
    );
    if (!rows[0].applied) {
      await migrate100(client);
    }
    // Customers that exist before 1.1.0 runs (backfill of credit rows).
    approvedCustomerId = await insertCustomer(true);
    pendingCustomerId = await insertCustomer(false);
    await migrate110(client);
    firstRunSnapshot = await schemaSnapshot();
  }, 30000);

  afterAll(async () => {
    if (client) {
      await client.query('ROLLBACK');
      client.release();
    }
    if (pool) {
      await pool.end();
    }
  });

  it('is a clean no-op when it runs again', async () => {
    await expect(migrate110(client)).resolves.toBeUndefined();
    expect(await schemaSnapshot()).toEqual(firstRunSnapshot);
  });

  it('creates every new table and the views', async () => {
    const tables = await client.query(
      `SELECT "tablename" FROM pg_tables
       WHERE schemaname = current_schema() AND tablename LIKE 'wholesale%'`
    );
    expect(tables.rows.map((r) => r.tablename)).toEqual(expect.arrayContaining(NEW_TABLES));
    const views = await client.query(
      `SELECT "viewname" FROM pg_views
       WHERE schemaname = current_schema() AND viewname LIKE 'wholesale%'`
    );
    expect(views.rows.map((r) => r.viewname).sort()).toEqual([
      'wholesale_active_allocation',
      'wholesale_invoice_balance'
    ]);
  });

  it('creates every named constraint once', async () => {
    const { rows } = await client.query(
      `SELECT "conname" FROM pg_constraint WHERE conrelid IN ${SCHEMA_TABLES_SQL}`
    );
    const names = rows.map((r) => r.conname as string);
    const expected = [
      'WHOLESALE_PRODUCT_LINE_UUID_UNIQUE',
      'WHOLESALE_LINE_TIER_UNIQUE',
      'FK_WHOLESALE_LINE_TIER_LINE',
      'WHOLESALE_LINE_TIER_CHECK',
      'FK_WHOLESALE_RULE_LINE',
      'WHOLESALE_RULE_VAT_RATE_CHECK',
      'WHOLESALE_RULE_BASE_PRICE_CHECK',
      'WHOLESALE_QUOTE_STATUS_CHECK',
      'WHOLESALE_QUOTE_FREIGHT_LABEL_CHECK',
      'WHOLESALE_QUOTE_TOTALS_CHECK',
      'WHOLESALE_QUOTE_ITEM_LINE_TYPE_CHECK',
      'WHOLESALE_QUOTE_ITEM_SERVICE_CODE_CHECK',
      'WHOLESALE_QUOTE_ITEM_VAT_RATE_CHECK',
      'FK_WHOLESALE_QUOTE_ITEM_LINE',
      'FK_WHOLESALE_CREDIT_CUSTOMER',
      'WHOLESALE_CREDIT_CHECK',
      'FK_WHOLESALE_ADMIN_PROFILE_USER',
      'WHOLESALE_AUDIT_LOG_UUID_UNIQUE',
      'WHOLESALE_AUDIT_ACTOR_TYPE_CHECK',
      'CART_CHANNEL_CHECK',
      'ORDER_CHANNEL_CHECK',
      'FK_ORDER_WHOLESALE_QUOTE',
      'WHOLESALE_ORDER_UUID_UNIQUE',
      'WHOLESALE_ORDER_ORDER_UNIQUE',
      'WHOLESALE_ORDER_QUOTE_UNIQUE',
      'FK_WHOLESALE_ORDER_ORDER',
      'FK_WHOLESALE_ORDER_QUOTE',
      'FK_WHOLESALE_ORDER_CUSTOMER',
      'WHOLESALE_ORDER_STATUS_CHECK',
      'WHOLESALE_ORDER_PAYMENT_STATUS_CHECK',
      'WHOLESALE_ORDER_PAYMENT_METHOD_CHECK',
      'WHOLESALE_ORDER_FREIGHT_CHECK',
      'WHOLESALE_ORDER_TOTALS_CHECK',
      'WHOLESALE_FISCAL_ISSUER_SINGLE_ROW',
      'WHOLESALE_FISCAL_SEQUENCE_TYPE_CHECK',
      'WHOLESALE_FISCAL_SEQUENCE_NUMBER_CHECK',
      'WHOLESALE_SIFEN_DOCUMENT_UUID_UNIQUE',
      'FK_WHOLESALE_SIFEN_DOCUMENT_ORDER',
      'FK_WHOLESALE_SIFEN_DOCUMENT_REMISSION',
      'WHOLESALE_SIFEN_DOCUMENT_TYPE_CHECK',
      'WHOLESALE_SIFEN_DOCUMENT_REMISSION_CHECK',
      'WHOLESALE_SIFEN_DOCUMENT_ENVIRONMENT_CHECK',
      'WHOLESALE_SIFEN_DOCUMENT_STATUS_CHECK',
      'WHOLESALE_INVOICE_UUID_UNIQUE',
      'WHOLESALE_INVOICE_NUMBER_UNIQUE',
      'WHOLESALE_INVOICE_ORDER_UNIQUE',
      'FK_WHOLESALE_INVOICE_CUSTOMER',
      'FK_WHOLESALE_INVOICE_ORDER',
      'WHOLESALE_INVOICE_SOURCE_CHECK',
      'WHOLESALE_INVOICE_CONDITION_CHECK',
      'WHOLESALE_INVOICE_CREDIT_DUE',
      'WHOLESALE_INVOICE_DUE_AFTER_ISSUE',
      'WHOLESALE_INVOICE_TOTAL_CHECK',
      'WHOLESALE_INVOICE_TOTALS_CHECK',
      'WHOLESALE_INVOICE_ITEM_LINE_UNIQUE',
      'FK_WHOLESALE_INVOICE_ITEM_INVOICE',
      'WHOLESALE_INVOICE_ITEM_LINE_TYPE_CHECK',
      'WHOLESALE_INVOICE_ITEM_SERVICE_CODE_CHECK',
      'WHOLESALE_INVOICE_ITEM_VAT_RATE_CHECK',
      'WHOLESALE_INVOICE_ITEM_QTY_CHECK',
      'WHOLESALE_PAYMENT_UUID_UNIQUE',
      'FK_WHOLESALE_PAYMENT_CUSTOMER',
      'FK_WHOLESALE_PAYMENT_ORDER',
      'WHOLESALE_PAYMENT_AMOUNT_CHECK',
      'WHOLESALE_PAYMENT_METHOD_CHECK',
      'WHOLESALE_PAYMENT_VOID_CHECK',
      'WHOLESALE_PAYMENT_ALLOCATION_UNIQUE',
      'FK_WHOLESALE_ALLOCATION_PAYMENT',
      'FK_WHOLESALE_ALLOCATION_INVOICE',
      'WHOLESALE_PAYMENT_ALLOCATION_AMOUNT_CHECK',
      'WHOLESALE_VEHICLE_UUID_UNIQUE',
      'WHOLESALE_VEHICLE_PLATE_UNIQUE',
      'FK_WHOLESALE_VEHICLE_CUSTOMER',
      'WHOLESALE_VEHICLE_OWNER_CHECK',
      'WHOLESALE_DRIVER_UUID_UNIQUE',
      'WHOLESALE_DRIVER_DOCUMENT_UNIQUE',
      'FK_WHOLESALE_DRIVER_CUSTOMER',
      'WHOLESALE_REMISSION_UUID_UNIQUE',
      'WHOLESALE_REMISSION_TRIP_UNIQUE',
      'WHOLESALE_REMISSION_SHIPMENT_UNIQUE',
      'FK_WHOLESALE_REMISSION_ORDER',
      'FK_WHOLESALE_REMISSION_INVOICE',
      'FK_WHOLESALE_REMISSION_VEHICLE',
      'FK_WHOLESALE_REMISSION_DRIVER',
      'WHOLESALE_REMISSION_STATUS_CHECK',
      'WHOLESALE_REMISSION_TRANSPORT_CHECK',
      'WHOLESALE_REMISSION_CARRIER_CHECK',
      'WHOLESALE_REMISSION_APPROVED_CHECK',
      'WHOLESALE_REMISSION_ITEM_UNIQUE',
      'FK_WHOLESALE_REMISSION_ITEM_NOTE',
      'FK_WHOLESALE_REMISSION_ITEM_ORDER_ITEM',
      'WHOLESALE_REMISSION_ITEM_QTY_CHECK',
      'WHOLESALE_NOTIFICATION_UUID_UNIQUE',
      'WHOLESALE_NOTIFICATION_SEVERITY_CHECK',
      'WHOLESALE_DEMO_MESSAGE_UUID_UNIQUE',
      'FK_WHOLESALE_DEMO_MESSAGE_QUOTE',
      'WHOLESALE_DEMO_MESSAGE_DIRECTION_CHECK',
      'WHOLESALE_DEMO_MESSAGE_KIND_CHECK',
      'WHOLESALE_DEMO_SETTING_KEY_CHECK'
    ];
    expect(names).toEqual(expect.arrayContaining(expected));
    for (const name of expected) {
      expect([name, names.filter((n) => n === name).length]).toEqual([name, 1]);
    }
  });

  it('points every new foreign key at the right table', async () => {
    const { rows } = await client.query(
      `SELECT "conname", confrelid::regclass::text AS "target", confdeltype
       FROM pg_constraint
       WHERE contype = 'f' AND conrelid IN ${SCHEMA_TABLES_SQL}`
    );
    const fks = Object.fromEntries(
      rows.map((r) => [r.conname as string, `${r.target}:${r.confdeltype}`])
    );
    // confdeltype: r = RESTRICT, c = CASCADE, n = SET NULL, a = NO ACTION
    expect(fks).toMatchObject({
      FK_WHOLESALE_LINE_TIER_LINE: 'wholesale_product_line:c',
      FK_WHOLESALE_RULE_LINE: 'wholesale_product_line:r',
      FK_WHOLESALE_QUOTE_ITEM_LINE: 'wholesale_product_line:n',
      FK_WHOLESALE_CREDIT_CUSTOMER: 'customer:r',
      FK_WHOLESALE_ADMIN_PROFILE_USER: 'admin_user:c',
      FK_ORDER_WHOLESALE_QUOTE: 'wholesale_quote:r',
      FK_WHOLESALE_ORDER_ORDER: '"order":r',
      FK_WHOLESALE_ORDER_QUOTE: 'wholesale_quote:r',
      FK_WHOLESALE_ORDER_CUSTOMER: 'customer:r',
      FK_WHOLESALE_SIFEN_DOCUMENT_ORDER: 'wholesale_order:r',
      FK_WHOLESALE_SIFEN_DOCUMENT_REMISSION: 'wholesale_remission_note:r',
      FK_WHOLESALE_INVOICE_CUSTOMER: 'customer:r',
      FK_WHOLESALE_INVOICE_ORDER: 'wholesale_order:r',
      FK_WHOLESALE_INVOICE_ITEM_INVOICE: 'wholesale_invoice:c',
      FK_WHOLESALE_PAYMENT_CUSTOMER: 'customer:r',
      FK_WHOLESALE_PAYMENT_ORDER: 'wholesale_order:r',
      FK_WHOLESALE_ALLOCATION_PAYMENT: 'wholesale_payment:r',
      FK_WHOLESALE_ALLOCATION_INVOICE: 'wholesale_invoice:r',
      FK_WHOLESALE_VEHICLE_CUSTOMER: 'customer:r',
      FK_WHOLESALE_DRIVER_CUSTOMER: 'customer:r',
      FK_WHOLESALE_REMISSION_ORDER: 'wholesale_order:r',
      FK_WHOLESALE_REMISSION_INVOICE: 'wholesale_invoice:r',
      FK_WHOLESALE_REMISSION_VEHICLE: 'wholesale_vehicle:r',
      FK_WHOLESALE_REMISSION_DRIVER: 'wholesale_driver:r',
      FK_WHOLESALE_REMISSION_ITEM_NOTE: 'wholesale_remission_note:c',
      FK_WHOLESALE_REMISSION_ITEM_ORDER_ITEM: 'order_item:r',
      FK_WHOLESALE_DEMO_MESSAGE_QUOTE: 'wholesale_quote:n'
    });
  });

  it('creates the indexes of section 7', async () => {
    const { rows } = await client.query(
      `SELECT "indexname", "indexdef" FROM pg_indexes WHERE schemaname = current_schema()`
    );
    const defs = Object.fromEntries(rows.map((r) => [r.indexname as string, r.indexdef as string]));
    for (const name of [
      'WHOLESALE_PRODUCT_LINE_NAME_UNIQUE',
      'WHOLESALE_RULE_LINE',
      'WHOLESALE_QUOTE_ITEM_ONE_FREIGHT',
      'WHOLESALE_AUDIT_ENTITY',
      'ORDER_CHANNEL_CREATED',
      'WHOLESALE_ORDER_DUE',
      'WHOLESALE_ORDER_CUSTOMER_STATUS',
      'WHOLESALE_SIFEN_ONE_APPROVED_INVOICE',
      'WHOLESALE_SIFEN_ONE_APPROVED_REMISSION',
      'WHOLESALE_INVOICE_CUSTOMER_DUE',
      'WHOLESALE_REMISSION_ORDER_STATUS',
      'WHOLESALE_NOTIFICATION_UNREAD'
    ]) {
      expect([name, defs[name] !== undefined]).toEqual([name, true]);
    }
    expect(defs.WHOLESALE_QUOTE_ITEM_ONE_FREIGHT).toMatch(/UNIQUE/);
    expect(defs.WHOLESALE_QUOTE_ITEM_ONE_FREIGHT).toMatch(/FLETE_LOGISTICA/);
    expect(defs.WHOLESALE_SIFEN_ONE_APPROVED_INVOICE).toMatch(/UNIQUE[\s\S]*approved/);
    expect(defs.WHOLESALE_NOTIFICATION_UNREAD).toMatch(/read_at IS NULL/);
  });

  describe('product lines and rules', () => {
    it('validates tiers and keeps line names unique regardless of case', async () => {
      const lineId = await insertRow(
        'wholesale_product_line',
        { name: `Line ${randomUUID()}` },
        'wholesale_product_line_id'
      );
      const tier = `INSERT INTO "wholesale_product_line_tier"
        ("wholesale_product_line_id", "from_qty", "discount_percent", "label")
        VALUES ($1, $2, $3, $4)`;
      await client.query(tier, [lineId, 12, 5, 'Distribuidor Oro']);
      expect((await expectFailure(tier, [lineId, 12, 6, null])).constraint).toBe(
        'WHOLESALE_LINE_TIER_UNIQUE'
      );
      expect((await expectFailure(tier, [lineId, 0, 5, null])).constraint).toBe(
        'WHOLESALE_LINE_TIER_CHECK'
      );
      expect((await expectFailure(tier, [lineId, 24, 101, null])).constraint).toBe(
        'WHOLESALE_LINE_TIER_CHECK'
      );

      const name = `Case ${randomUUID()}`;
      await client.query('INSERT INTO "wholesale_product_line" ("name") VALUES ($1)', [name]);
      const duplicate = await expectFailure(
        'INSERT INTO "wholesale_product_line" ("name") VALUES ($1)',
        [name.toUpperCase()]
      );
      expect(duplicate.code).toBe('23505');
      expect(duplicate.constraint).toBe('WHOLESALE_PRODUCT_LINE_NAME_UNIQUE');
    });

    it('adds the per-product wholesale data with its checks', async () => {
      const product = await client.query(
        `INSERT INTO "product" ("sku", "price") VALUES ($1, 10) RETURNING "product_id"`,
        [`WHOLESALE-110-${randomUUID()}`]
      );
      const productId = product.rows[0].product_id as number;
      const insert = `INSERT INTO "wholesale_product_rule"
        ("product_id", "vat_rate", "base_price", "wholesale_product_line_id")
        VALUES ($1, $2, $3, $4)`;
      expect((await expectFailure(insert, [productId, '0', 100, null])).constraint).toBe(
        'WHOLESALE_RULE_VAT_RATE_CHECK'
      );
      expect((await expectFailure(insert, [productId, '10', 0, null])).constraint).toBe(
        'WHOLESALE_RULE_BASE_PRICE_CHECK'
      );
      expect((await expectFailure(insert, [productId, '10', 100, -1])).constraint).toBe(
        'FK_WHOLESALE_RULE_LINE'
      );
      await client.query(insert, [productId, 'exempt', null, null]);
      const { rows } = await client.query(
        `SELECT "vat_rate", "is_critical_consumable", "base_price"
         FROM "wholesale_product_rule" WHERE "product_id" = $1`,
        [productId]
      );
      expect(rows[0]).toEqual({
        vat_rate: 'exempt',
        is_critical_consumable: false,
        base_price: null
      });
      const comment = await client.query(
        `SELECT col_description('"wholesale_product_rule"'::regclass, attnum) AS "comment"
         FROM pg_attribute
         WHERE attrelid = '"wholesale_product_rule"'::regclass AND attname = 'tiers'`
      );
      expect(comment.rows[0].comment).toMatch(/Deprecated since 1\.1\.0/);
    });
  });

  describe('quotes', () => {
    it('relaxes the status check to accept awaiting_freight only', async () => {
      expect('awaiting_freight'.length).toBeLessThanOrEqual(16);
      const quoteId = await insertQuote({ status: 'awaiting_freight' });
      expect(quoteId).toBeGreaterThan(0);
      const bogus = await expectFailure(
        `UPDATE "wholesale_quote" SET "status" = 'bogus' WHERE "wholesale_quote_id" = $1`,
        [quoteId]
      );
      expect(bogus.constraint).toBe('WHOLESALE_QUOTE_STATUS_CHECK');
      for (const status of ['pending', 'sent', 'accepted', 'rejected', 'expired', 'failed']) {
        await expect(insertQuote({ status })).resolves.toBeGreaterThan(0);
      }
    });

    it('defaults the new quote columns to an empty special-freight quote', async () => {
      const quoteId = await insertQuote();
      const { rows } = await client.query(
        `SELECT "freight_label", "net_total", "freight_amount", "vat_total", "d_tot_ope",
                "total_weight", "mix_rule_applied"
         FROM "wholesale_quote" WHERE "wholesale_quote_id" = $1`,
        [quoteId]
      );
      expect(rows[0]).toEqual({
        freight_label: 'special',
        net_total: '0.00',
        freight_amount: '0.00',
        vat_total: '0.00',
        d_tot_ope: '0.00',
        total_weight: null,
        mix_rule_applied: false
      });
      expect(
        (await expectFailure(
          `UPDATE "wholesale_quote" SET "freight_label" = 'cheap' WHERE "wholesale_quote_id" = $1`,
          [quoteId]
        )).constraint
      ).toBe('WHOLESALE_QUOTE_FREIGHT_LABEL_CHECK');
    });

    it('refuses to migrate while a quote carries totals without a breakdown', async () => {
      await client.query('SAVEPOINT legacy_quote');
      try {
        await client.query(
          `ALTER TABLE "wholesale_quote" DROP CONSTRAINT "WHOLESALE_QUOTE_TOTALS_CHECK"`
        );
        await insertQuote({ grand_total: 100 });
        await expect(migrate110(client)).rejects.toThrow(
          /1 quote\(s\) carry totals without the SIFEN breakdown/
        );
      } finally {
        await client.query('ROLLBACK TO SAVEPOINT legacy_quote');
      }
    });

    it('adds the totals check validated and enforces it on every row', async () => {
      const { rows } = await client.query(
        `SELECT "convalidated" FROM pg_constraint
         WHERE conname = 'WHOLESALE_QUOTE_TOTALS_CHECK'
           AND conrelid = '"wholesale_quote"'::regclass`
      );
      expect(rows[0].convalidated).toBe(true);
      const bad = await expectFailure(
        `INSERT INTO "wholesale_quote"
         ("quote_number", "customer_id", "tax_id", "phone", "idempotency_key",
          "reply_nonce", "currency", "expires_at", "grand_total")
         VALUES ($1, $2, 'T', '+595981123456', $3, 'n', 'PYG', now(), 100)`,
        [`WQ-TEST-${randomUUID().slice(0, 8)}`, approvedCustomerId, randomUUID()]
      );
      expect(bad.constraint).toBe('WHOLESALE_QUOTE_TOTALS_CHECK');
      await expect(
        insertQuote({
          net_total: 1000,
          vat_total: 100,
          d_sub_10: 1100,
          d_base_grav_10: 1000,
          d_iva_10: 100,
          d_tot_ope: 1100,
          grand_total: 1100
        })
      ).resolves.toBeGreaterThan(0);
    });

    it('allows one FLETE_LOGISTICA service line per quote', async () => {
      const quoteId = await insertQuote();
      const insert = `INSERT INTO "wholesale_quote_item"
        ("wholesale_quote_id", "product_id", "product_sku", "product_name", "qty",
         "unit_price", "line_total", "line_type", "service_code", "vat_rate", "vat_amount")
        VALUES ($1, NULL, 'FLETE_LOGISTICA', 'Servicio de flete y logística', 1,
                $2, $2, $3, $4, '10', 10)`;
      await client.query(insert, [quoteId, 100, 'service', 'FLETE_LOGISTICA']);
      const second = await expectFailure(insert, [quoteId, 100, 'service', 'FLETE_LOGISTICA']);
      expect(second.constraint).toBe('WHOLESALE_QUOTE_ITEM_ONE_FREIGHT');
      expect((await expectFailure(insert, [quoteId, 100, 'service', null])).constraint).toBe(
        'WHOLESALE_QUOTE_ITEM_SERVICE_CODE_CHECK'
      );
      expect(
        (await expectFailure(insert, [quoteId, 100, 'product', 'FLETE_LOGISTICA'])).constraint
      ).toBe('WHOLESALE_QUOTE_ITEM_SERVICE_CODE_CHECK');
      expect((await expectFailure(insert, [quoteId, 100, 'fee', null])).constraint).toBe(
        'WHOLESALE_QUOTE_ITEM_LINE_TYPE_CHECK'
      );
    });
  });

  it('backfills credit rows for customers approved before 1.1.0', async () => {
    const { rows } = await client.query(
      `SELECT "customer_id", "credit_limit", "payment_term_days", "manual_block"
       FROM "wholesale_customer_credit" WHERE "customer_id" = ANY($1::int[])`,
      [[approvedCustomerId, pendingCustomerId]]
    );
    expect(rows).toEqual([
      {
        customer_id: approvedCustomerId,
        credit_limit: '0.00',
        payment_term_days: 30,
        manual_block: false
      }
    ]);
    const missing = await client.query(
      `SELECT COUNT(*)::int AS n FROM "customer" c
       WHERE c."is_wholesale_approved" = true
         AND NOT EXISTS (SELECT 1 FROM "wholesale_customer_credit" w
                         WHERE w."customer_id" = c."customer_id")`
    );
    expect(missing.rows[0].n).toBe(0);
    const bad = await expectFailure(
      `UPDATE "wholesale_customer_credit" SET "payment_term_days" = 400 WHERE "customer_id" = $1`,
      [approvedCustomerId]
    );
    expect(bad.constraint).toBe('WHOLESALE_CREDIT_CHECK');
  });

  it('adds channel to cart and order; every existing order stays b2c', async () => {
    const { rows } = await client.query(
      `SELECT "table_name", "column_name", "column_default", "is_nullable"
       FROM information_schema.columns
       WHERE table_schema = current_schema() AND table_name IN ('cart', 'order')
         AND column_name IN ('channel', 'wholesale_quote_id')
       ORDER BY 1, 2`
    );
    expect(rows).toEqual([
      { table_name: 'cart', column_name: 'channel', column_default: "'b2c'::character varying", is_nullable: 'NO' },
      { table_name: 'cart', column_name: 'wholesale_quote_id', column_default: null, is_nullable: 'YES' },
      { table_name: 'order', column_name: 'channel', column_default: "'b2c'::character varying", is_nullable: 'NO' },
      { table_name: 'order', column_name: 'wholesale_quote_id', column_default: null, is_nullable: 'YES' }
    ]);
    const orders = await client.query(
      `SELECT COUNT(*) FILTER (WHERE "channel" <> 'b2c')::int AS non_b2c,
              COUNT(*) FILTER (WHERE "wholesale_quote_id" IS NOT NULL)::int AS linked
       FROM "order"`
    );
    expect(orders.rows[0]).toEqual({ non_b2c: 0, linked: 0 });
    const carts = await client.query(
      `SELECT COUNT(*) FILTER (WHERE "channel" <> 'b2c')::int AS non_b2c FROM "cart"`
    );
    expect(carts.rows[0].non_b2c).toBe(0);

    // Core cart/order rows need many NOT NULL totals; read the checks instead.
    const defs = await client.query(
      `SELECT conrelid::regclass::text AS rel, pg_get_constraintdef(oid) AS def
       FROM pg_constraint
       WHERE (conname = 'CART_CHANNEL_CHECK' AND conrelid = '"cart"'::regclass)
          OR (conname = 'ORDER_CHANNEL_CHECK' AND conrelid = '"order"'::regclass)
       ORDER BY 1`
    );
    expect(defs.rows).toHaveLength(2);
    for (const row of defs.rows) {
      expect(row.def).toMatch(/'b2c'[\s\S]*'b2b'/);
    }
  });

  it('checks wholesale_order states, payment methods (incl. cheque) and totals', async () => {
    const insert = `INSERT INTO "wholesale_order"
      ("order_id", "wholesale_quote_id", "customer_id", "status", "payment_status",
       "payment_method", "net_total", "vat_total", "d_sub_10", "d_base_grav_10", "d_iva_10",
       "d_tot_ope", "grand_total", "payment_due_at")
      VALUES (-1, -1, -1, $1, $2, $3, 1000, 100, 1100, 1000, 100, 1100, $4, now())`;
    expect((await expectFailure(insert, ['pending_payment', 'pending', null, 1100])).constraint).toBe(
      'WHOLESALE_ORDER_STATUS_CHECK'
    );
    expect((await expectFailure(insert, ['order_confirmed', 'overpaid', null, 1100])).constraint).toBe(
      'WHOLESALE_ORDER_PAYMENT_STATUS_CHECK'
    );
    expect((await expectFailure(insert, ['order_confirmed', 'pending', 'card', 1100])).constraint).toBe(
      'WHOLESALE_ORDER_PAYMENT_METHOD_CHECK'
    );
    expect((await expectFailure(insert, ['order_confirmed', 'pending', 'cheque', 1200])).constraint).toBe(
      'WHOLESALE_ORDER_TOTALS_CHECK'
    );
    // Every CHECK passes with cheque: only the foreign keys reject the fake ids.
    const fk = await expectFailure(insert, ['dispatched', 'paid', 'cheque', 1100]);
    expect(fk.code).toBe('23503');
  });

  it('makes wholesale_audit_log append-only', async () => {
    const id = await insertRow(
      'wholesale_audit_log',
      {
        actor_type: 'admin',
        admin_user_id: 1,
        admin_email: 'admin@example.com',
        action: 'credit.update',
        entity_type: 'customer',
        entity_uuid: randomUUID(),
        after: JSON.stringify({ credit_limit: 10 })
      },
      'wholesale_audit_log_id'
    );
    const update = await expectFailure(
      `UPDATE "wholesale_audit_log" SET "reason" = 'edit' WHERE "wholesale_audit_log_id" = $1`,
      [id]
    );
    expect(update.message).toMatch(/append-only/);
    const del = await expectFailure(
      'DELETE FROM "wholesale_audit_log" WHERE "wholesale_audit_log_id" = $1',
      [id]
    );
    expect(del.message).toMatch(/append-only/);
  });

  describe('invoices, payments and allocations', () => {
    it('checks the invoice SIFEN breakdown', async () => {
      const bad = await expectFailure(
        `INSERT INTO "wholesale_invoice"
         ("customer_id", "source", "condition", "invoice_number", "issue_date", "due_date",
          "currency", "net_total", "vat_total", "grand_total", "d_sub_10", "d_iva_10", "d_tot_ope")
         VALUES ($1, 'opening', 'credit', 'BAD-1', '2026-10-01', '2026-10-31', 'PYG',
                 1000, 100, 1100, 1000, 100, 1100)`,
        [approvedCustomerId]
      );
      expect(bad.constraint).toBe('WHOLESALE_INVOICE_TOTALS_CHECK');
      const noDue = await expectFailure(
        `INSERT INTO "wholesale_invoice"
         ("customer_id", "source", "condition", "invoice_number", "issue_date",
          "currency", "net_total", "vat_total", "grand_total", "d_sub_10", "d_iva_10", "d_tot_ope")
         VALUES ($1, 'opening', 'credit', 'BAD-2', '2026-10-01', 'PYG',
                 1000, 100, 1100, 1100, 100, 1100)`,
        [approvedCustomerId]
      );
      expect(noDue.constraint).toBe('WHOLESALE_INVOICE_CREDIT_DUE');
      await expect(insertInvoice()).resolves.toBeGreaterThan(0);
    });

    it('rejects editing a payment amount and deleting a payment', async () => {
      const paymentId = await insertPayment(500);
      const amount = await expectFailure(
        `UPDATE "wholesale_payment" SET "amount" = 1 WHERE "wholesale_payment_id" = $1`,
        [paymentId]
      );
      expect(amount.message).toMatch(/wholesale_payment/);
      const voidAndEdit = await expectFailure(
        `UPDATE "wholesale_payment"
         SET "amount" = 1, "voided_at" = now(), "voided_by" = 1, "void_reason" = 'typo'
         WHERE "wholesale_payment_id" = $1`,
        [paymentId]
      );
      expect(voidAndEdit.message).toMatch(/immutable/);
      const partialVoid = await expectFailure(
        `UPDATE "wholesale_payment" SET "voided_at" = now() WHERE "wholesale_payment_id" = $1`,
        [paymentId]
      );
      expect(partialVoid.message).toMatch(/void/);
      const blankReason = await expectFailure(
        `UPDATE "wholesale_payment" SET "voided_at" = now(), "voided_by" = 1, "void_reason" = '  '
         WHERE "wholesale_payment_id" = $1`,
        [paymentId]
      );
      expect(blankReason.message).toMatch(/void/);
      const del = await expectFailure(
        'DELETE FROM "wholesale_payment" WHERE "wholesale_payment_id" = $1',
        [paymentId]
      );
      expect(del.message).toMatch(/wholesale_payment/);
    });

    it('voids a payment once and hides its allocations from the balances', async () => {
      const invoiceId = await insertInvoice();
      const kept = await insertPayment(300);
      const voided = await insertPayment(200);
      const allocate = `INSERT INTO "wholesale_payment_allocation"
        ("wholesale_payment_id", "wholesale_invoice_id", "amount") VALUES ($1, $2, $3)`;
      await client.query(allocate, [kept, invoiceId, 300]);
      await client.query(allocate, [voided, invoiceId, 200]);
      expect((await expectFailure(allocate, [kept, invoiceId, 1])).constraint).toBe(
        'WHOLESALE_PAYMENT_ALLOCATION_UNIQUE'
      );

      const outstanding = async () =>
        (
          await client.query(
            `SELECT "outstanding" FROM "wholesale_invoice_balance" WHERE "wholesale_invoice_id" = $1`,
            [invoiceId]
          )
        ).rows[0].outstanding;
      expect(await outstanding()).toBe('600.00');

      await client.query(
        `UPDATE "wholesale_payment"
         SET "voided_at" = now(), "voided_by" = 1, "void_reason" = 'Bounced cheque'
         WHERE "wholesale_payment_id" = $1`,
        [voided]
      );
      const active = await client.query(
        `SELECT "wholesale_payment_id" FROM "wholesale_active_allocation"
         WHERE "wholesale_invoice_id" = $1`,
        [invoiceId]
      );
      expect(active.rows.map((r) => r.wholesale_payment_id)).toEqual([kept]);
      expect(await outstanding()).toBe('800.00');

      const again = await expectFailure(
        `UPDATE "wholesale_payment"
         SET "voided_at" = now(), "voided_by" = 2, "void_reason" = 'again'
         WHERE "wholesale_payment_id" = $1`,
        [voided]
      );
      expect(again.message).toMatch(/already voided/);

      const editAllocation = await expectFailure(
        `UPDATE "wholesale_payment_allocation" SET "amount" = 1 WHERE "wholesale_payment_id" = $1`,
        [kept]
      );
      expect(editAllocation.message).toMatch(/append-only/);
      const deleteAllocation = await expectFailure(
        'DELETE FROM "wholesale_payment_allocation" WHERE "wholesale_payment_id" = $1',
        [voided]
      );
      expect(deleteAllocation.message).toMatch(/append-only/);
    });
  });

  it('ties SIFEN documents to remission notes only for type remission_note', async () => {
    const { rows } = await client.query(
      `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
       WHERE conname = 'WHOLESALE_SIFEN_DOCUMENT_REMISSION_CHECK'`
    );
    expect(rows[0].def).toMatch(/remission_note/);
    // CHECKs run before foreign keys: an invoice attempt pointing at a note fails the check.
    const bad = await expectFailure(
      `INSERT INTO "wholesale_sifen_document"
       ("document_type", "wholesale_order_id", "wholesale_remission_note_id", "attempt_no",
        "document_number", "cdc", "environment", "status")
       VALUES ('invoice', -1, -1, 1, '001-001-0000001', $1, 'mock', 'approved')`,
      ['0'.repeat(44)]
    );
    expect(bad.constraint).toBe('WHOLESALE_SIFEN_DOCUMENT_REMISSION_CHECK');
  });

  it('keeps a single fiscal issuer row and closed demo setting keys', async () => {
    const issuer = await expectFailure(
      `INSERT INTO "wholesale_fiscal_issuer"
       ("wholesale_fiscal_issuer_id", "ruc", "ruc_dv", "business_name", "timbrado_number",
        "timbrado_valid_from", "establishment", "expedition_point", "address", "activity_code")
       VALUES (2, '80012344', '1', 'Emisor', '12345678', '2026-01-01', '001', '001', 'Asunción', '46100')`
    );
    expect(issuer.constraint).toBe('WHOLESALE_FISCAL_ISSUER_SINGLE_ROW');
    const setting = `INSERT INTO "wholesale_demo_setting" ("key", "value") VALUES ($1, true)
                     ON CONFLICT ("key") DO UPDATE SET "value" = EXCLUDED."value"`;
    await client.query(setting, ['force_sifen_reject_invoice']);
    await client.query(setting, ['force_sifen_reject_remission_note']);
    expect((await expectFailure(setting, ['force_anything'])).constraint).toBe(
      'WHOLESALE_DEMO_SETTING_KEY_CHECK'
    );
  });

  it('refreshes updated_at on every new table that has it', async () => {
    const { rows } = await client.query(
      `SELECT tgrelid::regclass::text AS rel FROM pg_trigger
       WHERE NOT tgisinternal AND tgname LIKE '%_updated_at'`
    );
    expect(rows.map((r) => r.rel)).toEqual(
      expect.arrayContaining([
        'wholesale_product_line',
        'wholesale_customer_credit',
        'wholesale_admin_profile',
        'wholesale_order',
        'wholesale_fiscal_issuer',
        'wholesale_vehicle',
        'wholesale_driver',
        'wholesale_remission_note',
        'wholesale_demo_setting'
      ])
    );
    const lineId = await insertRow(
      'wholesale_product_line',
      { name: `Stamp ${randomUUID()}`, updated_at: '2000-01-01T00:00:00Z' },
      'wholesale_product_line_id'
    );
    const updated = await client.query(
      `UPDATE "wholesale_product_line" SET "is_active" = false
       WHERE "wholesale_product_line_id" = $1 RETURNING "updated_at"`,
      [lineId]
    );
    expect((updated.rows[0].updated_at as Date).getUTCFullYear()).toBeGreaterThan(2000);
  });
});
