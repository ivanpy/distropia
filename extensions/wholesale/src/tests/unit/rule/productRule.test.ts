/**
 * T-2.11 / T-2.12 (CU-01b, data model §7.2): per-product wholesale rule.
 *
 * - `saveRule` writes `wholesale_product_line_id`, `base_price`, `vat_rate`,
 *   `is_critical_consumable` and the quantity rules with `insertOnUpdate` on
 *   `product_id`; it never writes the deprecated `tiers` column. Keys left
 *   out keep their stored value (table default on creation); `null` clears.
 * - `getRule` reads it back by product uuid with the line (and its tiers)
 *   and `isQuotable`, exposing only uuids.
 *
 * Runs on the rolled-back fixture transaction (1.0.0 first, then 1.1.0).
 * Statements expected to fail run inside a savepoint.
 */
import { randomUUID } from 'crypto';
import type { PoolClient } from 'pg';
import migrate110 from '../../../migration/Version-1.1.0.js';
import {
  createProductLine,
  replaceProductLineTiers,
  updateProductLine
} from '../../../services/line/productLines.js';
import { getRule, getRuleByProductId } from '../../../services/rule/getRule.js';
import { RuleError, saveRule, type SaveRuleInput } from '../../../services/rule/saveRule.js';
import { describeDb, openFixtures, type Fixtures } from '../graphql/storefrontSchema.js';
import { insertProduct, type ProductFixture } from './ruleFixtures.js';

const BASE: SaveRuleInput = {
  isEnabled: true,
  vatRate: '10',
  isCriticalConsumable: false,
  minQty: 1,
  stepQty: 1
};

describeDb('per-product wholesale rule services (T-2.11, T-2.12)', () => {
  let fixtures: Fixtures;
  let client: PoolClient;
  let lineUuid: string;
  let inactiveLineUuid: string;

  /** Runs `work` inside a savepoint; returns the RuleError it threw (code/status/details) or `'RESOLVED'`. */
  async function failureOf(work: () => Promise<unknown>): Promise<unknown> {
    await client.query('SAVEPOINT rule_case');
    try {
      await work();
    } catch (e) {
      await client.query('ROLLBACK TO SAVEPOINT rule_case');
      if (e instanceof RuleError) {
        return { code: e.code, status: e.status, details: e.details };
      }
      throw e;
    }
    await client.query('RELEASE SAVEPOINT rule_case');
    return 'RESOLVED';
  }

  async function storedRow(product: ProductFixture) {
    const { rows } = await client.query(`SELECT * FROM "wholesale_product_rule" WHERE "product_id" = $1`, [
      product.productId
    ]);
    return rows[0] as Record<string, unknown> | undefined;
  }

  beforeAll(async () => {
    fixtures = await openFixtures();
    client = fixtures.client;
    await migrate110(client);
    const line = await createProductLine(client, { name: `Rule line ${randomUUID()}`, countsTowardMix: true });
    await replaceProductLineTiers(client, line.uuid, [
      { fromQty: 1, discountPercent: 0 },
      { fromQty: 12, discountPercent: 10, label: 'Bronce' }
    ]);
    lineUuid = line.uuid;
    const inactive = await createProductLine(client, { name: `Rule line ${randomUUID()} off` });
    await updateProductLine(client, inactive.uuid, { isActive: false });
    inactiveLineUuid = inactive.uuid;
  }, 30000);

  afterAll(async () => {
    await fixtures?.close();
  });

  describe('saveRule (T-2.11)', () => {
    it('creates the rule and returns it as getRule reads it', async () => {
      const product = await insertProduct(client);
      const saved = await saveRule(client, product.uuid, {
        isEnabled: true,
        productLineUuid: lineUuid,
        basePrice: 15000.5,
        vatRate: '5',
        isCriticalConsumable: true,
        minQty: 6,
        stepQty: 6,
        maxQty: 600
      });
      expect(saved).toEqual({
        uuid: expect.stringMatching(/^[0-9a-f-]{36}$/),
        isEnabled: true,
        isQuotable: true,
        productLine: {
          uuid: lineUuid,
          name: expect.any(String),
          isActive: true,
          countsTowardMix: true,
          tiers: [
            { fromQty: 1, discountPercent: 0, label: null },
            { fromQty: 12, discountPercent: 10, label: 'Bronce' }
          ]
        },
        basePrice: 15000.5,
        vatRate: '5',
        isCriticalConsumable: true,
        minQty: 6,
        stepQty: 6,
        maxQty: 600,
        updatedAt: expect.any(String)
      });
      expect(await getRule(client, product.uuid)).toEqual(saved);
      const row = await storedRow(product);
      expect(row).toMatchObject({ base_price: '15000.50', vat_rate: '5', min_qty: 6, step_qty: 6, max_qty: 600 });
      expect(row?.tiers).toEqual([]);
    });

    it('updates the same row (insertOnUpdate on product_id) and keeps keys left out', async () => {
      const product = await insertProduct(client);
      const first = await saveRule(client, product.uuid, { ...BASE, productLineUuid: lineUuid, basePrice: 100, maxQty: 50 });
      const second = await saveRule(client, product.uuid, { ...BASE, isEnabled: false, vatRate: 'exempt', minQty: 2, stepQty: 2 });
      expect(second.uuid).toBe(first.uuid);
      expect(second).toMatchObject({
        isEnabled: false,
        isQuotable: false,
        vatRate: 'exempt',
        minQty: 2,
        stepQty: 2,
        basePrice: 100,
        maxQty: 50,
        productLine: { uuid: lineUuid }
      });
      const { rows } = await client.query(`SELECT count(*)::int AS n FROM "wholesale_product_rule" WHERE "product_id" = $1`, [
        product.productId
      ]);
      expect(rows[0].n).toBe(1);
    });

    it('clears the line, base price and cap with explicit nulls (saved, but not quotable: CU-01b 2a)', async () => {
      const product = await insertProduct(client);
      await saveRule(client, product.uuid, { ...BASE, productLineUuid: lineUuid, basePrice: 100, maxQty: 10 });
      const cleared = await saveRule(client, product.uuid, { ...BASE, productLineUuid: null, basePrice: null, maxQty: null });
      expect(cleared).toMatchObject({ productLine: null, basePrice: null, maxQty: null, isQuotable: false });
    });

    it('creates with table defaults for keys left out (no line, no price, no cap)', async () => {
      const product = await insertProduct(client);
      expect(await saveRule(client, product.uuid, BASE)).toMatchObject({
        productLine: null,
        basePrice: null,
        maxQty: null,
        isQuotable: false
      });
    });

    it('may assign an inactive line; the product is then not quotable', async () => {
      const product = await insertProduct(client);
      const saved = await saveRule(client, product.uuid, { ...BASE, productLineUuid: inactiveLineUuid, basePrice: 5 });
      expect(saved).toMatchObject({ productLine: { uuid: inactiveLineUuid, isActive: false }, isQuotable: false });
    });

    it.each([
      ['a non-uuid product id', 'not-a-uuid'],
      ['an unknown product uuid', randomUUID()]
    ])('answers 404 PRODUCT_NOT_FOUND for %s', async (_case, uuid) => {
      expect(await failureOf(() => saveRule(client, uuid, BASE))).toEqual({
        code: 'PRODUCT_NOT_FOUND',
        status: 404,
        details: undefined
      });
    });

    it.each([randomUUID(), 'line-7'])('answers 422 PRODUCT_LINE_NOT_FOUND for the unknown line %s', async (uuid) => {
      const product = await insertProduct(client);
      expect(await failureOf(() => saveRule(client, product.uuid, { ...BASE, productLineUuid: uuid }))).toEqual({
        code: 'PRODUCT_LINE_NOT_FOUND',
        status: 422,
        details: { field: 'productLineUuid' }
      });
      expect(await storedRow(product)).toBeUndefined();
    });

    it.each<[string, Partial<SaveRuleInput>, string]>([
      ['maxQty below minQty', { minQty: 12, maxQty: 6 }, 'maxQty'],
      ['a base price with more than 2 decimals', { basePrice: 10.005 }, 'basePrice'],
      ['a zero base price', { basePrice: 0 }, 'basePrice'],
      ['a base price over numeric(14,2)', { basePrice: 1e12 }, 'basePrice'],
      ['an unknown VAT rate', { vatRate: '0' as SaveRuleInput['vatRate'] }, 'vatRate'],
      ['a fractional minQty', { minQty: 1.5 }, 'minQty'],
      ['a zero stepQty', { stepQty: 0 }, 'stepQty'],
      ['a non-boolean isEnabled', { isEnabled: 'true' as unknown as boolean }, 'isEnabled']
    ])('answers 422 INVALID_RULE for %s', async (_case, patch, field) => {
      const product = await insertProduct(client);
      expect(await failureOf(() => saveRule(client, product.uuid, { ...BASE, ...patch }))).toEqual({
        code: 'INVALID_RULE',
        status: 422,
        details: { field }
      });
    });

    it('checks maxQty against the stored minQty when minQty is the only bound sent', async () => {
      const product = await insertProduct(client);
      await saveRule(client, product.uuid, { ...BASE, maxQty: 10 });
      expect(await failureOf(() => saveRule(client, product.uuid, { ...BASE, minQty: 20 }))).toMatchObject({
        code: 'INVALID_RULE',
        details: { field: 'maxQty' }
      });
    });

    it('refuses to run outside a transaction', async () => {
      const product = await insertProduct(client);
      const outside = { query: client.query.bind(client) } as unknown as PoolClient;
      await expect(saveRule(outside, product.uuid, BASE)).rejects.toThrow(/transaction/);
    });
  });

  describe('getRule (T-2.12)', () => {
    it('returns null for a product without rule, an unknown product and a non-uuid id', async () => {
      const product = await insertProduct(client);
      expect(await getRule(client, product.uuid)).toBeNull();
      expect(await getRule(client, randomUUID())).toBeNull();
      expect(await getRule(client, '42')).toBeNull();
      expect(await getRuleByProductId(client, product.productId)).toBeNull();
    });

    it('reads by product id too, and never exposes serial ids', async () => {
      const product = await insertProduct(client);
      await saveRule(client, product.uuid, { ...BASE, productLineUuid: lineUuid, basePrice: 7 });
      const rule = await getRuleByProductId(client, product.productId);
      expect(rule).toEqual(await getRule(client, product.uuid));
      expect(JSON.stringify(rule)).not.toMatch(/_id"|"id"/);
      expect(rule?.isQuotable).toBe(true);
    });

    it('follows the line state: deactivating the line makes the product not quotable', async () => {
      const line = await createProductLine(client, { name: `Rule line ${randomUUID()} toggled` });
      const product = await insertProduct(client);
      await saveRule(client, product.uuid, { ...BASE, productLineUuid: line.uuid, basePrice: 7 });
      expect((await getRule(client, product.uuid))?.isQuotable).toBe(true);
      await updateProductLine(client, line.uuid, { isActive: false });
      expect((await getRule(client, product.uuid))?.isQuotable).toBe(false);
    });
  });
});
