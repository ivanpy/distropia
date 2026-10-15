/**
 * T-2.44 (RF-03, data model §7.2): a product is quotable only with an
 * enabled wholesale rule, a base price and an active product line.
 * `loadQuoteProducts` loads what the quote calculation needs (rule, base
 * price, VAT rate, active line with ordered tiers, `product.weight`).
 */
import type { PoolClient } from 'pg';
import migrate110 from '../../../migration/Version-1.1.0.js';
import {
  createProductLine,
  replaceProductLineTiers,
  updateProductLine
} from '../../../services/line/productLines.js';
import { isQuotable, loadQuoteProducts } from '../../../services/rule/isQuotable.js';
import { describeDb, openFixtures, type Fixtures } from '../graphql/storefrontSchema.js';
import { insertProduct, insertRule, lineIdOf } from './ruleFixtures.js';

describe('isQuotable (T-2.44)', () => {
  const line = { isActive: true };

  it('is true only with an enabled rule, a base price and an active line', () => {
    expect(isQuotable({ isEnabled: true, basePrice: 10 }, line)).toBe(true);
  });

  it.each([
    ['no rule', null, line],
    ['a disabled rule', { isEnabled: false, basePrice: 10 }, line],
    ['no base price', { isEnabled: true, basePrice: null }, line],
    ['no line', { isEnabled: true, basePrice: 10 }, null],
    ['an inactive line', { isEnabled: true, basePrice: 10 }, { isActive: false }]
  ])('is false with %s', (_case, rule, ruleLine) => {
    expect(isQuotable(rule, ruleLine)).toBe(false);
  });

  it('never treats a non-positive or non-finite base price as a price', () => {
    expect(isQuotable({ isEnabled: true, basePrice: 0 }, line)).toBe(false);
    expect(isQuotable({ isEnabled: true, basePrice: Number.NaN }, line)).toBe(false);
  });
});

describeDb('loadQuoteProducts (T-2.44)', () => {
  let fixtures: Fixtures;
  let client: PoolClient;
  let activeLineId: number;
  let inactiveLineId: number;
  let activeLineUuid: string;

  beforeAll(async () => {
    fixtures = await openFixtures();
    client = fixtures.client;
    await migrate110(client);
    const active = await createProductLine(client, { name: `Quote data ${Date.now()} active`, countsTowardMix: true });
    activeLineUuid = active.uuid;
    await replaceProductLineTiers(client, active.uuid, [
      { fromQty: 1, discountPercent: 0, label: 'Precio Base Mayorista' },
      { fromQty: 12, discountPercent: 10, label: 'Mayorista Bronce' },
      { fromQty: 48, discountPercent: 20, label: 'Distribuidor Oro' }
    ]);
    const inactive = await createProductLine(client, { name: `Quote data ${Date.now()} inactive` });
    await updateProductLine(client, inactive.uuid, { isActive: false });
    activeLineId = await lineIdOf(client, active.uuid);
    inactiveLineId = await lineIdOf(client, inactive.uuid);
  }, 30000);

  afterAll(async () => {
    await fixtures?.close();
  });

  it('loads rule, base price, VAT rate, the active line with ordered tiers and the weight', async () => {
    const product = await insertProduct(client, { weight: 2.5, name: 'Llave combinada 10 mm' });
    await insertRule(client, product.productId, {
      lineId: activeLineId,
      basePrice: 15000,
      vatRate: '5',
      isCriticalConsumable: true,
      minQty: 6,
      stepQty: 6,
      maxQty: 600
    });

    const data = await loadQuoteProducts(client, [product.productId]);
    expect(data.get(product.productId)).toEqual({
      productId: product.productId,
      productUuid: product.uuid,
      sku: product.sku,
      name: 'Llave combinada 10 mm',
      weight: 2.5,
      quotable: true,
      rule: {
        isEnabled: true,
        basePrice: 15000,
        vatRate: '5',
        isCriticalConsumable: true,
        minQty: 6,
        stepQty: 6,
        maxQty: 600
      },
      line: {
        id: activeLineId,
        uuid: activeLineUuid,
        name: expect.any(String),
        isActive: true,
        countsTowardMix: true,
        tiers: [
          { fromQty: 1, discountPercent: 0, label: 'Precio Base Mayorista' },
          { fromQty: 12, discountPercent: 10, label: 'Mayorista Bronce' },
          { fromQty: 48, discountPercent: 20, label: 'Distribuidor Oro' }
        ]
      }
    });
  });

  it('keeps a null weight null (special freight is decided later)', async () => {
    const product = await insertProduct(client, { weight: null });
    await insertRule(client, product.productId, { lineId: activeLineId });
    expect((await loadQuoteProducts(client, [product.productId])).get(product.productId)?.weight).toBeNull();
  });

  it.each([
    ['without a base price', { basePrice: null }],
    ['without a line', { lineId: null }],
    ['with a disabled rule', { isEnabled: false }],
    ['with an inactive line', 'inactive' as const]
  ])('marks a product %s as not quotable', async (_case, rule) => {
    const product = await insertProduct(client);
    await insertRule(
      client,
      product.productId,
      rule === 'inactive' ? { lineId: inactiveLineId } : { lineId: activeLineId, ...rule }
    );
    const data = (await loadQuoteProducts(client, [product.productId])).get(product.productId);
    expect(data?.quotable).toBe(false);
  });

  it('returns a product without rule as not quotable with a null rule and line', async () => {
    const product = await insertProduct(client);
    const data = (await loadQuoteProducts(client, [product.productId])).get(product.productId);
    expect(data).toMatchObject({ productId: product.productId, quotable: false, rule: null, line: null });
  });

  it('loads several products in one call and leaves unknown ids out', async () => {
    const a = await insertProduct(client);
    const b = await insertProduct(client);
    await insertRule(client, a.productId, { lineId: activeLineId });
    const data = await loadQuoteProducts(client, [a.productId, b.productId, a.productId, 2147483000]);
    expect([...data.keys()].sort((x, y) => x - y)).toEqual([a.productId, b.productId].sort((x, y) => x - y));
    expect(data.get(a.productId)?.quotable).toBe(true);
    expect(data.get(b.productId)?.quotable).toBe(false);
    expect((await loadQuoteProducts(client, [])).size).toBe(0);
  });
});
