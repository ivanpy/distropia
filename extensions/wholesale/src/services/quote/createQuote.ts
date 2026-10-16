/**
 * Quote creation (T-2.21, T-2.22; CU-02 steps 5-7, security §6, ADR-13).
 *
 * One transaction on a dedicated connection (`startTransaction` right after
 * acquiring it, see the core release trap):
 *
 * 1. Customer re-read from the database (`FOR SHARE`, so an approval
 *    revocation waits for this transaction): approved, active, with phone
 *    and RUC, or `WHOLESALE_NOT_APPROVED`. The phone of the quote is always
 *    `customer.phone`.
 * 2. `pg_try_advisory_xact_lock(QUOTE_LOCK_NAMESPACE, customer_id)`: a
 *    concurrent request of the same customer gets `QUOTE_IN_PROGRESS` (409)
 *    instead of waiting. Released by COMMIT/ROLLBACK.
 * 3. Idempotency: an existing quote with the same `(customer_id,
 *    idempotency_key)` is returned as is (`created: false`), nothing is
 *    written or emitted. `UNIQUE (customer_id, idempotency_key)` is the
 *    last guard.
 * 4. `underLock` (the rate-limit re-check of W7) runs under the lock.
 * 5. Cart of the customer (active), its items, quotability and quantities,
 *    then `calculateQuote` with the free-shipping threshold converted to the
 *    store weight unit. `MINIMUM_ORDER_NOT_MET` is refused before any
 *    insert: no row, no quote number drawn, no event.
 * 6. Snapshot: `wholesale_quote` in `DRAFT_QUOTE` with the 1.1.0 columns
 *    (totals, SIFEN breakdown, weight, freight label, mix) and one `product`
 *    line per item. Special freight moves it to `AWAITING_SHIPPING_QUOTE`
 *    and creates the `quote_awaiting_freight` notification in the same
 *    transaction.
 * 7. After COMMIT, `wholesale_quote_created` is emitted for free-freight
 *    quotes only (the WhatsApp subscriber of Phase 3 listens to it); a
 *    special-freight quote sends nothing until the seller quotes the freight
 *    (`wholesale_quote_ready`, T-3.34). A rollback emits nothing.
 *
 * No WhatsApp is sent here (Phase 3).
 */
import { pool } from '@evershop/evershop/lib/postgres';
import { emit as coreEmit } from '@evershop/evershop/lib/event';
import { error as logError } from '@evershop/evershop/lib/log';
import { getStoreTimezone } from '@evershop/evershop/setting/services';
import { commit, getConnection, rollback, startTransaction } from '@evershop/postgres-query-builder';
import type { PoolClient } from 'pg';
import { UUID_PATTERN } from '../customer/setCustomerApproval.js';
import { roundToCurrency } from '../money/roundToCurrency.js';
import { createNotification } from '../notification/createNotification.js';
import { calculateQuote, type QuoteCalculation } from './calculateQuote.js';
import { QuoteError } from './quoteError.js';
import {
  loadCartLines,
  prepareQuoteItems,
  type QuoteSettings,
  type QuoteSettingsSource,
  readQuoteSettingsSource,
  toQuoteSettings
} from './quoteInput.js';
import { nextQuoteNumber } from './quoteNumber.js';
import { generateReplyNonce } from './replyNonce.js';
import {
  assertQuoteTransition,
  fromQuoteStatusCode,
  INITIAL_QUOTE_STATUS,
  type QuoteStatus,
  toQuoteStatusCode
} from './statuses.js';
import type { FreightLabel } from './calculateQuote.js';

/** Emitted after COMMIT for a new free-freight quote. */
export const QUOTE_CREATED_EVENT = 'wholesale_quote_created';

/**
 * First key of the quote-creation advisory lock (second key: customer_id).
 * Distinct from the customer credit lock of Phase 5.
 */
export const QUOTE_LOCK_NAMESPACE = 0x57510001;

export interface CreateQuoteInput {
  /** Public uuid of the authenticated customer. */
  customerUuid: string;
  /** Public uuid of the cart (`cartId` in the request body). */
  cartUuid: string;
  /** `Idempotency-Key` header (UUID). */
  idempotencyKey: string;
  requestIp?: string | null;
}

/** What the request-quote response is shaped from (`requestQuoteResponse.ts`). */
export interface QuoteSummary {
  uuid: string;
  quoteNumber: string;
  status: QuoteStatus;
  freightLabel: FreightLabel;
  /** ISO timestamp; `null` until the quote is sent. */
  expiresAt: string | null;
  /** E.164 phone the quote goes to (`customer.phone` snapshot). */
  phone: string;
}

export interface CreateQuoteResult {
  /** `false`: the idempotency key matched an existing quote. */
  created: boolean;
  quote: QuoteSummary;
}

export interface UnderLockContext {
  customerId: number;
  taxId: string;
  requestIp: string | null;
}

export interface CreateQuoteDependencies {
  /** Dedicated connection for the transaction (released by commit/rollback). */
  acquire?: () => Promise<PoolClient>;
  /** Post-COMMIT emitter; defaults to core `emit` on the shared pool. */
  emit?: (name: string, data: Record<string, unknown>) => Promise<void>;
  /** `wholesale.quote` settings; defaults to node-config. */
  settings?: QuoteSettingsSource;
  /** Store weight unit; defaults to core `getWeightUnit()`. */
  weightUnit?: string;
  /** Store time zone of the quote number year; defaults to core `getStoreTimezone()`. */
  timeZone?: string;
  now?: () => Date;
  /** Runs under the advisory lock before the cart is read (W7 rate-limit re-check). */
  underLock?: (connection: PoolClient, context: UnderLockContext) => Promise<void>;
}

interface CustomerRow {
  customer_id: number;
  status: number;
  tax_id: string | null;
  phone: string | null;
  is_wholesale_approved: boolean;
}

interface SummaryRow {
  uuid: string;
  quote_number: string;
  status: string;
  freight_label: FreightLabel;
  expires_at: Date | null;
  phone: string;
}

const SUMMARY_COLUMNS = `"uuid", "quote_number", "status", "freight_label", "expires_at", "phone"`;

const toSummary = (row: SummaryRow): QuoteSummary => ({
  uuid: row.uuid,
  quoteNumber: row.quote_number,
  status: fromQuoteStatusCode(row.status),
  freightLabel: row.freight_label,
  expiresAt: row.expires_at ? row.expires_at.toISOString() : null,
  phone: row.phone
});

const nonBlank = (value: string | null): value is string => typeof value === 'string' && value.trim() !== '';

async function lockedCustomer(connection: PoolClient, customerUuid: string): Promise<CustomerRow> {
  const { rows } = await connection.query<CustomerRow>(
    `SELECT "customer_id", "status", "tax_id", "phone", "is_wholesale_approved"
       FROM "customer" WHERE "uuid" = $1 FOR SHARE`,
    [customerUuid]
  );
  const customer = rows[0];
  // Strict boolean (never `== 1`), active account, and the contact data the quote snapshots.
  if (
    !customer ||
    customer.is_wholesale_approved !== true ||
    Number(customer.status) !== 1 ||
    !nonBlank(customer.phone) ||
    !nonBlank(customer.tax_id)
  ) {
    throw new QuoteError('WHOLESALE_NOT_APPROVED', 'Customer is not an approved wholesale customer with a phone');
  }
  return customer;
}

async function calculateCartQuote(
  connection: PoolClient,
  customerId: number,
  cartUuid: string,
  settings: QuoteSettings
): Promise<{ cartId: number; calculation: QuoteCalculation; lineNames: Map<number, string>; critical: Map<number, boolean> }> {
  const { rows: carts } = await connection.query<{ cart_id: number }>(
    `SELECT "cart_id" FROM "cart" WHERE "uuid" = $1 AND "customer_id" = $2 AND "status" = true`,
    [cartUuid, customerId]
  );
  if (!carts[0]) {
    throw new QuoteError('CART_NOT_FOUND', 'Cart not found');
  }
  const cartId = carts[0].cart_id;
  const lines = await loadCartLines(connection, cartId);
  if (lines.length === 0) {
    throw new QuoteError('EMPTY_CART', 'The cart is empty');
  }
  const prepared = await prepareQuoteItems(connection, lines);
  if (prepared.notQuotable.length > 0) {
    throw new QuoteError('PRODUCT_NOT_QUOTABLE', 'A product of the cart cannot be quoted', {
      products: prepared.notQuotable.map((p) => p.productUuid)
    });
  }
  if (prepared.invalidQuantities.length > 0) {
    throw new QuoteError('INVALID_QUANTITY', 'A quantity of the cart is not allowed', {
      products: prepared.invalidQuantities.map(({ productUuid, check }) => ({
        productUuid,
        reason: check.reason,
        minQty: check.minQty,
        stepQty: check.stepQty,
        maxQty: check.maxQty,
        lower: check.lower,
        upper: check.upper
      }))
    });
  }
  const calculation = calculateQuote(prepared.items, settings);
  const lineNames = new Map(prepared.items.map((it) => [it.line.id, it.line.name]));
  const critical = new Map(prepared.items.map((it) => [it.productId, it.isCriticalConsumable]));
  return { cartId, calculation, lineNames, critical };
}

/**
 * `rollback` releases the connection only once ROLLBACK succeeds. When it
 * fails (broken connection, BEGIN never ran) the client is released with the
 * error so the pool discards it instead of leaking it.
 */
async function rollbackAndRelease(connection: PoolClient): Promise<void> {
  try {
    await rollback(connection);
  } catch (rollbackError) {
    logError(rollbackError);
    connection.release(rollbackError instanceof Error ? rollbackError : true);
  }
}

export async function createQuote(
  input: CreateQuoteInput,
  dependencies: CreateQuoteDependencies = {}
): Promise<CreateQuoteResult> {
  if (typeof input.idempotencyKey !== 'string' || !UUID_PATTERN.test(input.idempotencyKey)) {
    throw new QuoteError('IDEMPOTENCY_KEY_REQUIRED', 'Idempotency-Key header must be a UUID');
  }
  if (typeof input.customerUuid !== 'string' || !UUID_PATTERN.test(input.customerUuid)) {
    throw new QuoteError('WHOLESALE_NOT_APPROVED', 'Customer is not an approved wholesale customer with a phone');
  }
  if (typeof input.cartUuid !== 'string' || !UUID_PATTERN.test(input.cartUuid)) {
    throw new QuoteError('CART_NOT_FOUND', 'Cart not found');
  }

  const settings = toQuoteSettings(dependencies.settings ?? readQuoteSettingsSource(), dependencies.weightUnit);
  const acquire = dependencies.acquire ?? (() => getConnection(pool));
  const emit = dependencies.emit ?? ((name, data) => coreEmit(name, data));
  const now = dependencies.now ?? (() => new Date());
  const requestIp = input.requestIp ?? null;

  const connection = await acquire();
  let created: QuoteSummary;
  try {
    // First statement on the connection (core release trap), inside the try
    // so a failing BEGIN still releases it.
    await startTransaction(connection);
    const customer = await lockedCustomer(connection, input.customerUuid);

    const { rows: lock } = await connection.query<{ locked: boolean }>(
      'SELECT pg_try_advisory_xact_lock($1::int, $2::int) AS "locked"',
      [QUOTE_LOCK_NAMESPACE, customer.customer_id]
    );
    if (lock[0]?.locked !== true) {
      throw new QuoteError('QUOTE_IN_PROGRESS', 'Another quote request of this customer is in progress');
    }

    const { rows: existing } = await connection.query<SummaryRow>(
      `SELECT ${SUMMARY_COLUMNS} FROM "wholesale_quote" WHERE "customer_id" = $1 AND "idempotency_key" = $2`,
      [customer.customer_id, input.idempotencyKey]
    );
    if (existing[0]) {
      await rollback(connection);
      return { created: false, quote: toSummary(existing[0]) };
    }

    await dependencies.underLock?.(connection, {
      customerId: customer.customer_id,
      taxId: customer.tax_id as string,
      requestIp
    });

    const { cartId, calculation, lineNames, critical } = await calculateCartQuote(
      connection,
      customer.customer_id,
      input.cartUuid,
      settings
    );
    if (!calculation.minimumMet) {
      // RF-28: refused before anything is written; the error carries no amount.
      throw new QuoteError('MINIMUM_ORDER_NOT_MET', 'The order does not reach the wholesale minimum');
    }

    const round = (n: number) => roundToCurrency(n, settings.decimals);
    const subTotal = round(calculation.lines.reduce((sum, l) => sum + l.basePrice * l.qty, 0));
    const tax = calculation.taxBreakdown;
    const quoteNumber = await nextQuoteNumber(connection, now(), dependencies.timeZone ?? getStoreTimezone());

    const { rows: inserted } = await connection.query<{ wholesale_quote_id: number } & SummaryRow>(
      `INSERT INTO "wholesale_quote" (
         "quote_number", "customer_id", "tax_id", "phone", "request_ip", "idempotency_key", "reply_nonce",
         "status", "currency", "sub_total", "discount_total", "net_total", "freight_amount", "vat_total",
         "d_sub_exe", "d_sub_5", "d_sub_10", "d_base_grav_5", "d_base_grav_10", "d_iva_5", "d_iva_10",
         "d_tot_ope", "grand_total", "total_weight", "freight_label", "mix_rule_applied", "source_cart_id",
         "expires_at")
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, 0, $13, $14, $15, $16, $17, $18, $19, $20,
               $21, $21, $22, $23, $24, $25, NULL)
       RETURNING "wholesale_quote_id", ${SUMMARY_COLUMNS}`,
      [
        quoteNumber,
        customer.customer_id,
        customer.tax_id,
        customer.phone,
        requestIp,
        input.idempotencyKey,
        generateReplyNonce(),
        toQuoteStatusCode(INITIAL_QUOTE_STATUS),
        settings.currency,
        subTotal,
        round(subTotal - calculation.netTotal),
        calculation.netTotal,
        calculation.vatTotal,
        tax.dSubExe,
        tax.dSub5,
        tax.dSub10,
        tax.dBaseGrav5,
        tax.dBaseGrav10,
        tax.dIVA5,
        tax.dIVA10,
        tax.dTotOpe,
        calculation.totalWeight,
        calculation.freightLabel,
        calculation.mixRuleApplied,
        cartId
      ]
    );
    const quote = inserted[0];

    const lines = calculation.lines;
    await connection.query(
      `INSERT INTO "wholesale_quote_item" (
         "wholesale_quote_id", "line_type", "product_id", "product_sku", "product_name", "qty", "unit_price",
         "discount_percent", "line_total", "vat_rate", "vat_amount", "wholesale_product_line_id",
         "product_line_name", "tier_label", "is_critical_consumable", "mix_rule_applied", "unit_weight")
       SELECT $1, 'product', item.*
         FROM unnest($2::int[], $3::text[], $4::text[], $5::int[], $6::numeric[], $7::numeric[], $8::numeric[],
                     $9::text[], $10::numeric[], $11::int[], $12::text[], $13::text[], $14::boolean[],
                     $15::boolean[], $16::numeric[]) AS item`,
      [
        quote.wholesale_quote_id,
        lines.map((l) => l.productId),
        lines.map((l) => l.sku),
        lines.map((l) => l.name),
        lines.map((l) => l.qty),
        lines.map((l) => l.basePrice),
        lines.map((l) => l.discountPercent),
        lines.map((l) => l.net),
        lines.map((l) => l.vatRate),
        lines.map((l) => l.vat),
        lines.map((l) => l.lineId),
        lines.map((l) => lineNames.get(l.lineId) ?? null),
        lines.map((l) => l.tier?.label ?? null),
        lines.map((l) => critical.get(l.productId) === true),
        lines.map((l) => l.mixRuleApplied),
        lines.map((l) => l.weight)
      ]
    );

    let summary = toSummary(quote);
    if (calculation.freightLabel === 'special') {
      assertQuoteTransition(summary.status, 'AWAITING_SHIPPING_QUOTE');
      const { rows: moved } = await connection.query<SummaryRow>(
        `UPDATE "wholesale_quote" SET "status" = $2
          WHERE "wholesale_quote_id" = $1 AND "status" = $3
          RETURNING ${SUMMARY_COLUMNS}`,
        [quote.wholesale_quote_id, toQuoteStatusCode('AWAITING_SHIPPING_QUOTE'), toQuoteStatusCode(summary.status)]
      );
      if (!moved[0]) {
        throw new Error(`createQuote: quote ${summary.quoteNumber} left DRAFT_QUOTE before the freight transition`);
      }
      summary = toSummary(moved[0]);
      await createNotification(connection, {
        type: 'quote_awaiting_freight',
        severity: 'warning',
        title: `Quote ${summary.quoteNumber} awaits a freight quote`,
        body: 'Special freight: enter the freight amount to send the quote to the customer.',
        entityType: 'wholesale_quote',
        entityUuid: summary.uuid
      });
    }

    await commit(connection);
    created = summary;
  } catch (e) {
    await rollbackAndRelease(connection);
    throw e;
  }

  if (created.freightLabel === 'free') {
    try {
      await emit(QUOTE_CREATED_EVENT, {
        uuid: created.uuid,
        quote_number: created.quoteNumber,
        status: toQuoteStatusCode(created.status),
        freight_label: created.freightLabel
      });
    } catch (e) {
      // The quote is committed: answer it. The event row is lost and the
      // quote stays in DRAFT_QUOTE without a WhatsApp until resent.
      logError(e);
    }
  }
  return { created: true, quote: created };
}
