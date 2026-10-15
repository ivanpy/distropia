/**
 * T-2.41 (RF-24, CU-01a, ADR-10): product line services — create, rename,
 * activate/deactivate and full replacement of the tier table in a
 * transaction. A duplicate name (case-insensitive) is `409
 * PRODUCT_LINE_NAME_TAKEN`; invalid tiers are `422 INVALID_TIERS` with
 * per-row errors and leave the previous table intact.
 *
 * Runs on the rolled-back fixture transaction (1.0.0 first, then 1.1.0).
 * Statements expected to fail run inside a savepoint so the fixture
 * transaction survives them.
 */
import { randomUUID } from 'crypto';
import type { PoolClient } from 'pg';
import migrate110 from '../../../migration/Version-1.1.0.js';
import {
  createProductLine,
  getProductLine,
  listProductLines,
  ProductLineError,
  replaceProductLineTiers,
  updateProductLine
} from '../../../services/line/productLines.js';
import { describeDb, openFixtures, type Fixtures } from '../graphql/storefrontSchema.js';

/** The `ProductLineError` thrown by `promise` (its code/status/details), or `'RESOLVED'`. */
async function failureOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (e) {
    if (e instanceof ProductLineError) {
      return { code: e.code, status: e.status, details: e.details };
    }
    throw e;
  }
  return 'RESOLVED';
}

describeDb('product line services (T-2.41)', () => {
  let fixtures: Fixtures;
  let client: PoolClient;

  beforeAll(async () => {
    fixtures = await openFixtures();
    client = fixtures.client;
    await migrate110(client);
  }, 30000);

  afterAll(async () => {
    await fixtures?.close();
  });

  /** Runs `fn` in a savepoint that is always rolled back. */
  async function inSavepoint<T>(fn: () => Promise<T>): Promise<T> {
    await client.query('SAVEPOINT product_line_test');
    try {
      return await fn();
    } finally {
      await client.query('ROLLBACK TO SAVEPOINT product_line_test');
    }
  }

  const uniqueName = (prefix: string) => `${prefix} ${randomUUID()}`;

  async function tierRows(uuid: string) {
    const { rows } = await client.query(
      `SELECT t."from_qty", t."discount_percent"::float8 AS "discount_percent", t."label"
         FROM "wholesale_product_line_tier" t
         JOIN "wholesale_product_line" l USING ("wholesale_product_line_id")
        WHERE l."uuid" = $1 ORDER BY t."from_qty"`,
      [uuid]
    );
    return rows;
  }

  it('refuses to write outside a transaction', async () => {
    const outside = { query: client.query.bind(client) } as unknown as PoolClient;
    await expect(createProductLine(outside, { name: uniqueName('Outside') })).rejects.toThrow(/open transaction/);
  });

  describe('create', () => {
    it('creates an active line with no tiers and returns its public shape', async () => {
      const name = uniqueName('Herramientas Manuales');
      const line = await createProductLine(client, { name: `  ${name} `, countsTowardMix: true });
      expect(line).toEqual({ uuid: expect.any(String), name, isActive: true, countsTowardMix: true, tiers: [] });
      expect(line).not.toHaveProperty('wholesaleProductLineId');
      expect(await getProductLine(client, line.uuid)).toEqual(line);
    });

    it('honours isActive: false and defaults countsTowardMix to false', async () => {
      const line = await createProductLine(client, { name: uniqueName('Inactive'), isActive: false });
      expect(line).toMatchObject({ isActive: false, countsTowardMix: false });
    });

    it('refuses a duplicate name, case- and whitespace-insensitively, with 409', async () => {
      const name = uniqueName('Duplicada');
      await createProductLine(client, { name });
      expect(await failureOf(createProductLine(client, { name: ` ${name.toUpperCase()} ` }))).toEqual({
        code: 'PRODUCT_LINE_NAME_TAKEN',
        status: 409,
        details: { field: 'name' }
      });
    });

    it('maps a unique-index race (another transaction won after the check) to 409', async () => {
      const name = uniqueName('Race');
      await createProductLine(client, { name });
      // The pre-check sees nothing, as when a concurrent insert commits after it.
      const racing = {
        INTRANSACTION: true,
        query: (text: string, values?: unknown[]) =>
          /^\s*SELECT 1 FROM "wholesale_product_line"/.test(text)
            ? Promise.resolve({ rows: [], rowCount: 0 })
            : client.query(text, values)
      } as unknown as PoolClient;
      const failure = await inSavepoint(() => failureOf(createProductLine(racing, { name })));
      expect(failure).toEqual({ code: 'PRODUCT_LINE_NAME_TAKEN', status: 409, details: { field: 'name' } });
    });

    it.each([
      ['blank', '   '],
      ['longer than 255 characters', 'x'.repeat(256)]
    ])('refuses a %s name with 400 INVALID_PAYLOAD', async (_case, name) => {
      expect(await failureOf(createProductLine(client, { name }))).toEqual({
        code: 'INVALID_PAYLOAD',
        status: 400,
        details: { field: 'name' }
      });
    });
  });

  describe('update (rename, activate, deactivate)', () => {
    it('renames and toggles flags, keeping the tiers', async () => {
      const line = await createProductLine(client, { name: uniqueName('Before') });
      await replaceProductLineTiers(client, line.uuid, [{ fromQty: 10, discountPercent: 5 }]);
      const renamed = uniqueName('After');

      const updated = await updateProductLine(client, line.uuid, { name: renamed, isActive: false });
      expect(updated).toEqual({
        uuid: line.uuid,
        name: renamed,
        isActive: false,
        countsTowardMix: false,
        tiers: [{ fromQty: 10, discountPercent: 5, label: null }]
      });

      const reactivated = await updateProductLine(client, line.uuid, { isActive: true, countsTowardMix: true });
      expect(reactivated).toMatchObject({ name: renamed, isActive: true, countsTowardMix: true });
    });

    it('allows a line to change only the case of its own name', async () => {
      const name = uniqueName('case');
      const line = await createProductLine(client, { name });
      expect((await updateProductLine(client, line.uuid, { name: name.toUpperCase() })).name).toBe(name.toUpperCase());
    });

    it('refuses to rename onto another line name with 409 and changes nothing', async () => {
      const taken = await createProductLine(client, { name: uniqueName('Taken') });
      const line = await createProductLine(client, { name: uniqueName('Mine') });
      expect(await failureOf(updateProductLine(client, line.uuid, { name: taken.name.toLowerCase() }))).toEqual({
        code: 'PRODUCT_LINE_NAME_TAKEN',
        status: 409,
        details: { field: 'name' }
      });
      expect((await getProductLine(client, line.uuid))?.name).toBe(line.name);
    });

    it.each([
      ['an unknown uuid', randomUUID()],
      ['an id that is not a uuid', '42']
    ])('answers 404 PRODUCT_LINE_NOT_FOUND for %s', async (_case, uuid) => {
      expect(await failureOf(updateProductLine(client, uuid, { isActive: false }))).toEqual({
        code: 'PRODUCT_LINE_NOT_FOUND',
        status: 404,
        details: undefined
      });
    });
  });

  describe('replace tiers', () => {
    it('replaces the whole table and returns it ordered', async () => {
      const line = await createProductLine(client, { name: uniqueName('Tiers') });
      await replaceProductLineTiers(client, line.uuid, [
        { fromQty: 1, discountPercent: 0 },
        { fromQty: 100, discountPercent: 10, label: 'Oro' }
      ]);
      const replaced = await replaceProductLineTiers(client, line.uuid, [
        { fromQty: 5, discountPercent: 2.5, label: ' Bronce ' },
        { fromQty: 50, discountPercent: 7.25 },
        { fromQty: 500, discountPercent: 15, label: 'Distribuidor Oro' }
      ]);
      const expected = [
        { fromQty: 5, discountPercent: 2.5, label: 'Bronce' },
        { fromQty: 50, discountPercent: 7.25, label: null },
        { fromQty: 500, discountPercent: 15, label: 'Distribuidor Oro' }
      ];
      expect(replaced.tiers).toEqual(expected);
      expect(await tierRows(line.uuid)).toEqual([
        { from_qty: 5, discount_percent: 2.5, label: 'Bronce' },
        { from_qty: 50, discount_percent: 7.25, label: null },
        { from_qty: 500, discount_percent: 15, label: 'Distribuidor Oro' }
      ]);
    });

    it('accepts an empty table (clears the tiers)', async () => {
      const line = await createProductLine(client, { name: uniqueName('Clear') });
      await replaceProductLineTiers(client, line.uuid, [{ fromQty: 10, discountPercent: 5 }]);
      expect((await replaceProductLineTiers(client, line.uuid, [])).tiers).toEqual([]);
      expect(await tierRows(line.uuid)).toEqual([]);
    });

    it('refuses invalid tiers with 422 INVALID_TIERS and per-row errors, leaving the previous table intact', async () => {
      const line = await createProductLine(client, { name: uniqueName('Intact') });
      await replaceProductLineTiers(client, line.uuid, [{ fromQty: 10, discountPercent: 5 }]);

      const failure = (await failureOf(
        replaceProductLineTiers(client, line.uuid, [
          { fromQty: 10, discountPercent: 5 },
          { fromQty: 10, discountPercent: 4 }
        ])
      )) as { code: string; status: number; details: { errors: unknown[] } };
      expect(failure.code).toBe('INVALID_TIERS');
      expect(failure.status).toBe(422);
      expect(failure.details.errors).toEqual([
        expect.objectContaining({ index: 1, field: 'fromQty', code: 'DUPLICATE_FROM_QTY' }),
        expect.objectContaining({ index: 1, field: 'discountPercent', code: 'DISCOUNT_DECREASING' })
      ]);
      expect(await tierRows(line.uuid)).toEqual([{ from_qty: 10, discount_percent: 5, label: null }]);
    });

    it('answers 404 for an unknown line before validating', async () => {
      expect(await failureOf(replaceProductLineTiers(client, randomUUID(), 'not an array'))).toMatchObject({
        code: 'PRODUCT_LINE_NOT_FOUND',
        status: 404
      });
    });
  });

  describe('read', () => {
    it('lists active lines by name with tiers ordered; inactive ones only on request', async () => {
      const prefix = `List ${randomUUID()}`;
      const b = await createProductLine(client, { name: `${prefix} b` });
      const a = await createProductLine(client, { name: `${prefix} A` });
      const off = await createProductLine(client, { name: `${prefix} c`, isActive: false });
      // Inserted out of order on purpose: the read orders by from_qty.
      await client.query(
        `INSERT INTO "wholesale_product_line_tier" ("wholesale_product_line_id", "from_qty", "discount_percent", "label")
         SELECT "wholesale_product_line_id", q, d, NULL FROM "wholesale_product_line",
                (VALUES (100, 10.0), (1, 0.0), (10, 5.5)) AS v(q, d)
          WHERE "uuid" = $1`,
        [a.uuid]
      );

      const mine = <T extends { name: string }>(lines: T[]) => lines.filter((l) => l.name.startsWith(prefix));
      const active = mine(await listProductLines(client));
      expect(active.map((l) => l.uuid)).toEqual([a.uuid, b.uuid]);
      expect(active[0].tiers).toEqual([
        { fromQty: 1, discountPercent: 0, label: null },
        { fromQty: 10, discountPercent: 5.5, label: null },
        { fromQty: 100, discountPercent: 10, label: null }
      ]);
      expect(active[1].tiers).toEqual([]);

      const all = mine(await listProductLines(client, { includeInactive: true }));
      expect(all.map((l) => l.uuid)).toEqual([a.uuid, b.uuid, off.uuid]);
    });

    it('returns null for an unknown or malformed uuid', async () => {
      expect(await getProductLine(client, randomUUID())).toBeNull();
      expect(await getProductLine(client, 'nope')).toBeNull();
    });
  });
});
