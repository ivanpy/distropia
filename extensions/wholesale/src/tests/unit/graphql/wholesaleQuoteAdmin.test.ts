/**
 * T-2.51: admin quote detail `wholesaleQuote(uuid)` (`WholesaleQuote.admin.graphql`,
 * `03_endpoints_y_contratos.md` §9) with canonical statuses and
 * `freightLabel`.
 *
 * Quotes are created with `createQuote` in a scratch database
 * (`quote/scratchDatabase.ts`) handed to the resolvers as `context.pool`.
 */
import { randomUUID } from 'crypto';
import type { GraphQLSchema } from 'graphql';
import type { Pool } from 'pg';
import { createQuote, type CreateQuoteDependencies } from '../../../services/quote/createQuote.js';
import {
  type CustomerFixture,
  insertCart,
  insertCustomer,
  insertLine,
  insertProduct,
  type LineFixture,
  type ProductFixture,
  SETTINGS
} from '../quote/quoteFixtures.js';
import { openScratchDatabase, type ScratchDatabase } from '../quote/scratchDatabase.js';
import { buildAdminSchema, buildStorefrontSchema, describeDb, run } from './storefrontSchema.js';

const DETAIL = `
  query Detail($uuid: String!) {
    wholesaleQuote(uuid: $uuid) {
      uuid quoteNumber status currency
      customer { uuid email fullName }
      subTotal discountTotal netTotal freightAmount vatTotal grandTotal
      vatBreakdown { rate taxableBase vat }
      taxBreakdown { dSubExe dSub5 dSub10 dBaseGrav5 dBaseGrav10 dIVA5 dIVA10 dTotOpe }
      totalWeight freightLabel freightSetAt mixRuleApplied orderUuid lastError expiresAt createdAt
      items {
        uuid lineType serviceCode productSku productName productLineName tierLabel qty unitPrice
        discountPercent mixRuleApplied vatRate vatAmount lineTotal unitWeight
      }
    }
  }
`;

type Detail = Record<string, unknown> & { items: Record<string, unknown>[] };

describeDb('admin GraphQL wholesaleQuote (T-2.51)', () => {
  let scratch: ScratchDatabase;
  let pool: Pool;
  let schema: GraphQLSchema;
  let line: LineFixture;
  let product: ProductFixture;
  let fivePercent: ProductFixture;
  let weightless: ProductFixture;
  let customer: CustomerFixture;

  const deps = (): CreateQuoteDependencies => ({
    acquire: () => pool.connect(),
    emit: async () => undefined,
    settings: SETTINGS,
    weightUnit: 'kg',
    timeZone: 'UTC'
  });

  const detail = async (uuid: string): Promise<Detail | null> =>
    (await run<{ wholesaleQuote: Detail | null }>(schema, DETAIL, { pool }, { uuid })).wholesaleQuote;

  beforeAll(async () => {
    scratch = await openScratchDatabase(4);
    pool = scratch.pool;
    schema = await buildAdminSchema();
    line = await insertLine(pool, [
      { fromQty: 1, discountPercent: 0 },
      { fromQty: 12, discountPercent: 10, label: 'Bronce' }
    ]);
    product = await insertProduct(pool, { lineId: line.lineId });
    fivePercent = await insertProduct(pool, { lineId: line.lineId, vatRate: '5', basePrice: 50_000, weight: 1 });
    weightless = await insertProduct(pool, { lineId: line.lineId, weight: null });
    customer = await insertCustomer(pool);
  }, 60000);

  afterAll(async () => {
    await scratch?.close();
  }, 60000);

  it('returns a free-freight quote in DRAFT_QUOTE with its snapshot and SIFEN breakdown', async () => {
    const cart = await insertCart(pool, customer.customerId, [
      { product, qty: 60 },
      { product: fivePercent, qty: 2 }
    ]);
    const { quote } = await createQuote(
      { customerUuid: customer.uuid, cartUuid: cart.uuid, idempotencyKey: randomUUID() },
      deps()
    );

    const data = await detail(quote.uuid);

    expect(data).toMatchObject({
      uuid: quote.uuid,
      quoteNumber: quote.quoteNumber,
      status: 'DRAFT_QUOTE',
      currency: 'PYG',
      customer: { uuid: customer.uuid, fullName: 'Quote Buyer' },
      subTotal: 6_100_000,
      discountTotal: 600_000,
      netTotal: 5_500_000,
      freightAmount: 0,
      vatTotal: 545_000,
      grandTotal: 6_045_000,
      vatBreakdown: [
        { rate: '10', taxableBase: 5_400_000, vat: 540_000 },
        { rate: '5', taxableBase: 100_000, vat: 5_000 }
      ],
      taxBreakdown: {
        dSubExe: 0,
        dSub5: 105_000,
        dSub10: 5_940_000,
        dBaseGrav5: 100_000,
        dBaseGrav10: 5_400_000,
        dIVA5: 5_000,
        dIVA10: 540_000,
        dTotOpe: 6_045_000
      },
      totalWeight: 122,
      freightLabel: 'free',
      freightSetAt: null,
      mixRuleApplied: false,
      orderUuid: null,
      lastError: null,
      expiresAt: null,
      createdAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/)
    });
    expect(data?.items).toEqual([
      {
        uuid: expect.any(String),
        lineType: 'product',
        serviceCode: null,
        productSku: product.sku,
        productName: product.name,
        productLineName: line.name,
        tierLabel: 'Bronce',
        qty: 60,
        unitPrice: 100_000,
        discountPercent: 10,
        mixRuleApplied: false,
        vatRate: '10',
        vatAmount: 540_000,
        lineTotal: 5_400_000,
        unitWeight: 2
      },
      expect.objectContaining({ productSku: fivePercent.sku, tierLabel: null, qty: 2, vatRate: '5', lineTotal: 100_000 })
    ]);
  });

  it('returns a special-freight quote as AWAITING_SHIPPING_QUOTE without weight', async () => {
    const cart = await insertCart(pool, customer.customerId, [{ product: weightless, qty: 60 }]);
    const { quote } = await createQuote(
      { customerUuid: customer.uuid, cartUuid: cart.uuid, idempotencyKey: randomUUID() },
      deps()
    );
    expect(await detail(quote.uuid)).toMatchObject({
      status: 'AWAITING_SHIPPING_QUOTE',
      freightLabel: 'special',
      totalWeight: null,
      freightAmount: 0,
      expiresAt: null
    });
  });

  it('returns null for an unknown or malformed uuid', async () => {
    expect(await detail(randomUUID())).toBeNull();
    expect(await detail('WQ-2026-000001')).toBeNull();
  });

  it('is absent from the storefront schema', async () => {
    const storefront = await buildStorefrontSchema();
    expect(storefront.getType('WholesaleQuote')).toBeUndefined();
    expect(storefront.getQueryType()?.getFields().wholesaleQuote).toBeUndefined();
  });
});
