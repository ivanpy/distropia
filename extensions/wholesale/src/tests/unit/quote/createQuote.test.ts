/**
 * T-2.21 / T-2.22: `createQuote` (CU-02 steps 5-7, security §6).
 *
 * Runs on a scratch database (`scratchDatabase.ts`) with real, committed
 * transactions, so concurrent requests use separate sessions exactly as in
 * production: 5 parallel requests with the same Idempotency-Key create one
 * quote. Covered as well: the snapshot (1.1.0 columns, `product` lines, SIFEN
 * breakdown), special freight (`AWAITING_SHIPPING_QUOTE` + notification in
 * the same transaction, no event), the minimum checked before any insert,
 * the domain refusals, and `wholesale_quote_created` emitted only after
 * COMMIT (a rollback emits nothing).
 */
import { randomUUID } from 'crypto';
import type { Pool, PoolClient } from 'pg';
import { calculateQuote } from '../../../services/quote/calculateQuote.js';
import {
  createQuote,
  type CreateQuoteDependencies,
  type CreateQuoteResult,
  QUOTE_CREATED_EVENT,
  QUOTE_LOCK_NAMESPACE
} from '../../../services/quote/createQuote.js';
import { QuoteError } from '../../../services/quote/quoteError.js';
import { prepareQuoteItems, toQuoteSettings } from '../../../services/quote/quoteInput.js';
import { REPLY_NONCE_PATTERN } from '../../../services/quote/replyNonce.js';
import {
  type CustomerFixture,
  insertCart,
  insertCustomer,
  insertLine,
  insertProduct,
  type LineFixture,
  type ProductFixture,
  SETTINGS
} from './quoteFixtures.js';
import { describeDb, openScratchDatabase, type ScratchDatabase } from './scratchDatabase.js';

type Row = Record<string, unknown>;

interface Emitted {
  name: string;
  data: Record<string, unknown>;
  /** Quote rows visible from another session when the event was emitted. */
  committedRows: number;
}

describeDb('createQuote (T-2.21, T-2.22)', () => {
  let scratch: ScratchDatabase;
  let pool: Pool;
  let line: LineFixture;
  /** 100.000 base, 10 % VAT, 2 kg, line tiers 1 → 0 %, 12 → 10 % (Bronce). */
  let product: ProductFixture;
  /** No weight: special freight. */
  let weightless: ProductFixture;
  let emitted: Emitted[];

  const countQuotes = async (customer: CustomerFixture): Promise<number> =>
    Number(
      (await pool.query(`SELECT count(*) AS "n" FROM "wholesale_quote" WHERE "customer_id" = $1`, [customer.customerId]))
        .rows[0].n
    );

  function deps(extra: Partial<CreateQuoteDependencies> = {}): CreateQuoteDependencies {
    return {
      acquire: () => pool.connect(),
      emit: async (name, data) => {
        const { rows } = await pool.query(`SELECT count(*) AS "n" FROM "wholesale_quote" WHERE "uuid" = $1`, [
          data.uuid
        ]);
        emitted.push({ name, data, committedRows: Number(rows[0].n) });
      },
      settings: SETTINGS,
      weightUnit: 'kg',
      timeZone: 'America/Asuncion',
      now: () => new Date('2026-10-16T12:00:00Z'),
      ...extra
    };
  }

  async function refusal(work: Promise<unknown>): Promise<{ code: string; status: number; details?: unknown }> {
    try {
      await work;
    } catch (e) {
      if (e instanceof QuoteError) {
        return { code: e.code, status: e.status, ...(e.details === undefined ? {} : { details: e.details }) };
      }
      throw e;
    }
    throw new Error('Expected createQuote to refuse');
  }

  /** A connection whose statements matching `failOn` throw (injected failure inside the transaction). */
  function failingAcquire(failOn: RegExp): () => Promise<PoolClient> {
    return async () => {
      const client = await pool.connect();
      const original = client.query.bind(client) as (...args: unknown[]) => Promise<unknown>;
      (client as unknown as { query: unknown }).query = (text: unknown, ...rest: unknown[]) => {
        const sql = typeof text === 'string' ? text : String((text as { text?: unknown })?.text ?? '');
        if (failOn.test(sql)) {
          return Promise.reject(new Error(`injected failure: ${sql.slice(0, 40)}`));
        }
        return original(text, ...rest);
      };
      const release = client.release.bind(client);
      client.release = (err?: Error | boolean) => {
        (client as unknown as { query: unknown }).query = original;
        release(err);
      };
      return client;
    };
  }

  beforeAll(async () => {
    scratch = await openScratchDatabase(8);
    pool = scratch.pool;
    line = await insertLine(pool, [
      { fromQty: 1, discountPercent: 0 },
      { fromQty: 12, discountPercent: 10, label: 'Bronce' }
    ]);
    product = await insertProduct(pool, { lineId: line.lineId });
    weightless = await insertProduct(pool, { lineId: line.lineId, weight: null });
  }, 60000);

  afterAll(async () => {
    await scratch?.close();
  }, 60000);

  beforeEach(() => {
    emitted = [];
  });

  it('snapshots a free-freight quote in DRAFT_QUOTE and emits wholesale_quote_created after COMMIT', async () => {
    const customer = await insertCustomer(pool);
    const cart = await insertCart(pool, customer.customerId, [{ product, qty: 60 }]);
    const key = randomUUID();

    const result = await createQuote(
      { customerUuid: customer.uuid, cartUuid: cart.uuid, idempotencyKey: key, requestIp: '203.0.113.7' },
      deps()
    );

    expect(result.created).toBe(true);
    expect(result.quote).toEqual({
      uuid: expect.any(String),
      quoteNumber: expect.stringMatching(/^WQ-2026-\d{6}$/),
      status: 'DRAFT_QUOTE',
      freightLabel: 'free',
      expiresAt: null,
      phone: expect.stringMatching(/^\+595\d{9}$/)
    });

    // Same numbers as the pure calculation.
    const prepared = await prepareQuoteItems(pool, [{ productId: product.productId, qty: 60 }]);
    const expected = calculateQuote(prepared.items, toQuoteSettings(SETTINGS, 'kg'));
    expect(expected.netTotal).toBe(5_400_000);

    const { rows } = await pool.query(`SELECT * FROM "wholesale_quote" WHERE "uuid" = $1`, [result.quote.uuid]);
    const quote = rows[0] as Row;
    expect(quote).toMatchObject({
      customer_id: customer.customerId,
      tax_id: '80012344-1',
      phone: result.quote.phone,
      request_ip: '203.0.113.7',
      idempotency_key: key,
      status: 'pending',
      currency: 'PYG',
      sub_total: '6000000.00',
      discount_total: '600000.00',
      net_total: '5400000.00',
      freight_amount: '0.00',
      vat_total: '540000.00',
      d_sub_10: '5940000.00',
      d_base_grav_10: '5400000.00',
      d_iva_10: '540000.00',
      d_sub_5: '0.00',
      d_sub_exe: '0.00',
      d_tot_ope: '5940000.00',
      grand_total: '5940000.00',
      total_weight: '120.0000',
      freight_label: 'free',
      mix_rule_applied: false,
      source_cart_id: cart.cartId,
      expires_at: null,
      sent_at: null,
      wa_message_id: null
    });
    expect(quote.reply_nonce).toMatch(REPLY_NONCE_PATTERN);
    expect(Number(quote.grand_total)).toBe(expected.grandTotal);

    const { rows: items } = await pool.query(
      `SELECT * FROM "wholesale_quote_item" WHERE "wholesale_quote_id" = $1`,
      [quote.wholesale_quote_id]
    );
    expect(items).toEqual([
      expect.objectContaining({
        line_type: 'product',
        service_code: null,
        product_id: product.productId,
        product_sku: product.sku,
        product_name: product.name,
        qty: 60,
        unit_price: '100000.00',
        discount_percent: '10.00',
        line_total: '5400000.00',
        vat_rate: '10',
        vat_amount: '540000.00',
        wholesale_product_line_id: line.lineId,
        product_line_name: line.name,
        tier_label: 'Bronce',
        is_critical_consumable: false,
        mix_rule_applied: false,
        unit_weight: '2.0000'
      })
    ]);

    expect(emitted).toEqual([
      {
        name: QUOTE_CREATED_EVENT,
        data: { uuid: result.quote.uuid, quote_number: result.quote.quoteNumber, status: 'pending', freight_label: 'free' },
        committedRows: 1
      }
    ]);
    const { rows: notes } = await pool.query(`SELECT 1 FROM "wholesale_notification" WHERE "entity_uuid" = $1`, [
      result.quote.uuid
    ]);
    expect(notes).toEqual([]);
  });

  it('returns the existing quote for a repeated Idempotency-Key without writing or emitting', async () => {
    const customer = await insertCustomer(pool);
    const cart = await insertCart(pool, customer.customerId, [{ product, qty: 60 }]);
    const input = { customerUuid: customer.uuid, cartUuid: cart.uuid, idempotencyKey: randomUUID() };
    const first = await createQuote(input, deps());
    const second = await createQuote(input, deps());

    expect(second).toEqual({ created: false, quote: first.quote });
    expect(await countQuotes(customer)).toBe(1);
    expect(emitted).toHaveLength(1);
  });

  it('creates exactly one quote for 5 parallel requests with the same Idempotency-Key', async () => {
    const customer = await insertCustomer(pool);
    const cart = await insertCart(pool, customer.customerId, [{ product, qty: 60 }]);
    const input = { customerUuid: customer.uuid, cartUuid: cart.uuid, idempotencyKey: randomUUID() };
    // Hold the lock a little so the five transactions overlap.
    const slow = deps({ underLock: () => new Promise((resolve) => setTimeout(resolve, 150)) });

    const outcomes = await Promise.allSettled(Array.from({ length: 5 }, () => createQuote(input, slow)));

    const created = outcomes.filter(
      (o): o is PromiseFulfilledResult<CreateQuoteResult> => o.status === 'fulfilled' && o.value.created
    );
    expect(created).toHaveLength(1);
    for (const outcome of outcomes) {
      if (outcome.status === 'fulfilled') {
        expect(outcome.value.quote.uuid).toBe(created[0].value.quote.uuid);
      } else {
        expect(outcome.reason).toBeInstanceOf(QuoteError);
        expect((outcome.reason as QuoteError).code).toBe('QUOTE_IN_PROGRESS');
        expect((outcome.reason as QuoteError).status).toBe(409);
      }
    }
    expect(outcomes.some((o) => o.status === 'rejected')).toBe(true);
    expect(await countQuotes(customer)).toBe(1);
    expect(emitted.filter((e) => e.name === QUOTE_CREATED_EVENT)).toHaveLength(1);
  }, 30000);

  it('creates exactly one quote for 5 parallel requests without an artificial delay', async () => {
    const customer = await insertCustomer(pool);
    const cart = await insertCart(pool, customer.customerId, [{ product, qty: 60 }]);
    const input = { customerUuid: customer.uuid, cartUuid: cart.uuid, idempotencyKey: randomUUID() };

    const outcomes = await Promise.allSettled(Array.from({ length: 5 }, () => createQuote(input, deps())));

    expect(outcomes.filter((o) => o.status === 'fulfilled' && o.value.created)).toHaveLength(1);
    for (const outcome of outcomes) {
      if (outcome.status === 'rejected') {
        expect((outcome.reason as QuoteError).code).toBe('QUOTE_IN_PROGRESS');
      }
    }
    expect(await countQuotes(customer)).toBe(1);
  }, 30000);

  it('refuses with QUOTE_IN_PROGRESS while another session holds the customer lock', async () => {
    const customer = await insertCustomer(pool);
    const cart = await insertCart(pool, customer.customerId, [{ product, qty: 60 }]);
    const holder = await pool.connect();
    try {
      await holder.query('BEGIN');
      await holder.query('SELECT pg_advisory_xact_lock($1::int, $2::int)', [QUOTE_LOCK_NAMESPACE, customer.customerId]);
      expect(
        await refusal(
          createQuote({ customerUuid: customer.uuid, cartUuid: cart.uuid, idempotencyKey: randomUUID() }, deps())
        )
      ).toEqual({ code: 'QUOTE_IN_PROGRESS', status: 409 });
    } finally {
      await holder.query('ROLLBACK');
      holder.release();
    }
    expect(await countQuotes(customer)).toBe(0);
  });

  it('special freight: AWAITING_SHIPPING_QUOTE and the notification in the same transaction, nothing sent', async () => {
    const customer = await insertCustomer(pool);
    const cart = await insertCart(pool, customer.customerId, [
      { product, qty: 60 },
      { product: weightless, qty: 1 }
    ]);

    const result = await createQuote(
      { customerUuid: customer.uuid, cartUuid: cart.uuid, idempotencyKey: randomUUID() },
      deps()
    );

    expect(result.quote).toMatchObject({ status: 'AWAITING_SHIPPING_QUOTE', freightLabel: 'special', expiresAt: null });
    const { rows } = await pool.query(
      `SELECT "status", "freight_label", "total_weight", "freight_amount", "d_tot_ope", "grand_total"
         FROM "wholesale_quote" WHERE "uuid" = $1`,
      [result.quote.uuid]
    );
    expect(rows[0]).toEqual({
      status: 'awaiting_freight',
      freight_label: 'special',
      total_weight: null,
      freight_amount: '0.00',
      // Products only until the seller quotes the freight.
      d_tot_ope: '6050000.00',
      grand_total: '6050000.00'
    });
    const { rows: notes } = await pool.query(
      `SELECT "type", "severity", "entity_type", "read_at" FROM "wholesale_notification" WHERE "entity_uuid" = $1`,
      [result.quote.uuid]
    );
    expect(notes).toEqual([
      { type: 'quote_awaiting_freight', severity: 'warning', entity_type: 'wholesale_quote', read_at: null }
    ]);
    // The WhatsApp subscriber listens to wholesale_quote_created: nothing is emitted.
    expect(emitted).toEqual([]);
  });

  it('a failing notification rolls the special-freight quote back', async () => {
    const customer = await insertCustomer(pool);
    const cart = await insertCart(pool, customer.customerId, [{ product: weightless, qty: 60 }]);
    await expect(
      createQuote(
        { customerUuid: customer.uuid, cartUuid: cart.uuid, idempotencyKey: randomUUID() },
        deps({ acquire: failingAcquire(/wholesale_notification/) })
      )
    ).rejects.toThrow(/injected failure/);
    expect(await countQuotes(customer)).toBe(0);
    expect(emitted).toEqual([]);
  });

  it('a failure after the quote insert rolls back and emits nothing (T-2.22)', async () => {
    const customer = await insertCustomer(pool);
    const cart = await insertCart(pool, customer.customerId, [{ product, qty: 60 }]);
    await expect(
      createQuote(
        { customerUuid: customer.uuid, cartUuid: cart.uuid, idempotencyKey: randomUUID() },
        deps({ acquire: failingAcquire(/INSERT INTO "wholesale_quote_item"/) })
      )
    ).rejects.toThrow(/injected failure/);
    expect(await countQuotes(customer)).toBe(0);
    expect(emitted).toEqual([]);
  });

  it.each([
    ['BEGIN fails', /^BEGIN$/],
    ['BEGIN and ROLLBACK fail', /^(BEGIN|ROLLBACK)$/]
  ])('releases the dedicated connection exactly once when %s', async (_label, failOn) => {
    const customer = await insertCustomer(pool);
    const cart = await insertCart(pool, customer.customerId, [{ product, qty: 60 }]);
    let client: PoolClient | undefined;
    const releases: unknown[] = [];
    const acquire = async () => {
      client = await failingAcquire(failOn)();
      const release = client.release.bind(client);
      client.release = (err?: Error | boolean) => {
        releases.push(err);
        release(err);
      };
      return client;
    };
    try {
      await expect(
        createQuote({ customerUuid: customer.uuid, cartUuid: cart.uuid, idempotencyKey: randomUUID() }, deps({ acquire }))
      ).rejects.toThrow(/injected failure: BEGIN/);
      expect(releases).toHaveLength(1);
    } finally {
      // Never leave the client checked out (the pool would not close).
      if (client && releases.length === 0) {
        client.release(true);
      }
    }
    expect(await countQuotes(customer)).toBe(0);
    expect(emitted).toEqual([]);
  });

  it('refuses MINIMUM_ORDER_NOT_MET before any insert: no row, no quote number, no event', async () => {
    const customer = await insertCustomer(pool);
    // 12 × 90.000 = 1.080.000 < 5.000.000.
    const cart = await insertCart(pool, customer.customerId, [{ product, qty: 12 }]);
    const statements: string[] = [];
    const recording = async () => {
      const client = await pool.connect();
      const original = client.query.bind(client) as (...args: unknown[]) => Promise<unknown>;
      (client as unknown as { query: unknown }).query = (text: unknown, ...rest: unknown[]) => {
        statements.push(typeof text === 'string' ? text : '');
        return original(text, ...rest);
      };
      const release = client.release.bind(client);
      client.release = (err?: Error | boolean) => {
        (client as unknown as { query: unknown }).query = original;
        release(err);
      };
      return client;
    };

    const outcome = await refusal(
      createQuote(
        { customerUuid: customer.uuid, cartUuid: cart.uuid, idempotencyKey: randomUUID() },
        deps({ acquire: recording })
      )
    );

    // The refusal carries no amount.
    expect(outcome).toEqual({ code: 'MINIMUM_ORDER_NOT_MET', status: 422 });
    expect(statements.filter((s) => /^\s*(INSERT|UPDATE)\b|nextval/i.test(s))).toEqual([]);
    expect(statements.at(-1)).toBe('ROLLBACK');
    expect(await countQuotes(customer)).toBe(0);
    expect(emitted).toEqual([]);
  });

  it.each([
    ['not approved', { approved: false }],
    ['without phone', { phone: null }],
    ['disabled', { status: 0 }]
  ])('refuses a customer %s with WHOLESALE_NOT_APPROVED', async (_label, options) => {
    const customer = await insertCustomer(pool, options);
    const cart = await insertCart(pool, customer.customerId, [{ product, qty: 60 }]);
    expect(
      await refusal(createQuote({ customerUuid: customer.uuid, cartUuid: cart.uuid, idempotencyKey: randomUUID() }, deps()))
    ).toEqual({ code: 'WHOLESALE_NOT_APPROVED', status: 403 });
    expect(await countQuotes(customer)).toBe(0);
  });

  it('refuses a cart of another customer, an inactive cart and an unknown cart with CART_NOT_FOUND', async () => {
    const customer = await insertCustomer(pool);
    const other = await insertCustomer(pool);
    const foreign = await insertCart(pool, other.customerId, [{ product, qty: 60 }]);
    const inactive = await insertCart(pool, customer.customerId, [{ product, qty: 60 }], { active: false });
    for (const cartUuid of [foreign.uuid, inactive.uuid, randomUUID(), 'not-a-uuid']) {
      expect(
        await refusal(createQuote({ customerUuid: customer.uuid, cartUuid, idempotencyKey: randomUUID() }, deps()))
      ).toEqual({ code: 'CART_NOT_FOUND', status: 404 });
    }
    expect(await countQuotes(customer)).toBe(0);
  });

  it('refuses an empty cart, a non-quotable product and a quantity off the grid', async () => {
    const customer = await insertCustomer(pool);
    const empty = await insertCart(pool, customer.customerId, []);
    expect(
      await refusal(createQuote({ customerUuid: customer.uuid, cartUuid: empty.uuid, idempotencyKey: randomUUID() }, deps()))
    ).toEqual({ code: 'EMPTY_CART', status: 422 });

    const noRule = await insertProduct(pool, { rule: false });
    const notQuotable = await insertCart(pool, customer.customerId, [
      { product, qty: 60 },
      { product: noRule, qty: 1 }
    ]);
    expect(
      await refusal(
        createQuote({ customerUuid: customer.uuid, cartUuid: notQuotable.uuid, idempotencyKey: randomUUID() }, deps())
      )
    ).toEqual({ code: 'PRODUCT_NOT_QUOTABLE', status: 422, details: { products: [noRule.uuid] } });

    const stepped = await insertProduct(pool, { lineId: line.lineId, minQty: 6, stepQty: 6 });
    const offGrid = await insertCart(pool, customer.customerId, [{ product: stepped, qty: 13 }]);
    expect(
      await refusal(createQuote({ customerUuid: customer.uuid, cartUuid: offGrid.uuid, idempotencyKey: randomUUID() }, deps()))
    ).toEqual({
      code: 'INVALID_QUANTITY',
      status: 422,
      details: {
        products: [
          { productUuid: stepped.uuid, reason: 'NOT_A_STEP', minQty: 6, stepQty: 6, maxQty: null, lower: 12, upper: 18 }
        ]
      }
    });
    expect(await countQuotes(customer)).toBe(0);
  });

  it('refuses a missing or malformed Idempotency-Key before touching the database', async () => {
    let acquired = 0;
    const customer = await insertCustomer(pool);
    for (const key of ['', 'abc', undefined as unknown as string]) {
      expect(
        await refusal(
          createQuote(
            { customerUuid: customer.uuid, cartUuid: randomUUID(), idempotencyKey: key },
            deps({
              acquire: async () => {
                acquired += 1;
                return pool.connect();
              }
            })
          )
        )
      ).toEqual({ code: 'IDEMPOTENCY_KEY_REQUIRED', status: 400 });
    }
    expect(acquired).toBe(0);
  });

  it('answers the committed quote even when the post-COMMIT emit fails', async () => {
    const customer = await insertCustomer(pool);
    const cart = await insertCart(pool, customer.customerId, [{ product, qty: 60 }]);
    const result = await createQuote(
      { customerUuid: customer.uuid, cartUuid: cart.uuid, idempotencyKey: randomUUID() },
      deps({
        emit: async () => {
          throw new Error('event table unavailable');
        }
      })
    );
    expect(result.created).toBe(true);
    expect(await countQuotes(customer)).toBe(1);
  });
});
