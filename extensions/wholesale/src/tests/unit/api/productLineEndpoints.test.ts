/**
 * T-2.42 (CU-01a, `03_endpoints_y_contratos.md` §7 Catálogo): admin
 * endpoints of product lines.
 *
 * - `POST /api/wholesale/product-lines` → 201; `409 PRODUCT_LINE_NAME_TAKEN`.
 * - `PATCH /api/wholesale/product-lines/:id` → 200; `404 PRODUCT_LINE_NOT_FOUND`.
 * - `PUT /api/wholesale/product-lines/:id/tiers` → 200; `422 INVALID_TIERS`
 *   with per-row errors, previous table intact.
 * - Body shape errors are `400` from the core `payloadValidate` middleware,
 *   whose message names the offending field (ajv-errors `errorMessage`).
 *
 * Handlers run their transaction on a connection over the rolled-back fixture
 * transaction (BEGIN / COMMIT / ROLLBACK become savepoint statements).
 */
import { randomUUID } from 'crypto';
import fs from 'fs';
import path from 'path';
import { pathToFileURL } from 'url';
import type { PoolClient } from 'pg';
import type { EvershopRequest } from '@evershop/evershop/types/request';
import type { EvershopResponse } from '@evershop/evershop/types/response';
import { createCreateProductLineHandler } from '../../../api/createProductLine/createProductLine.js';
import { createSaveProductLineTiersHandler } from '../../../api/saveProductLineTiers/saveProductLineTiers.js';
import { createUpdateProductLineHandler } from '../../../api/updateProductLine/updateProductLine.js';
import migrate110 from '../../../migration/Version-1.1.0.js';
import { describeDb, openFixtures, type Fixtures } from '../graphql/storefrontSchema.js';

const EXTENSION_API = path.resolve(process.cwd(), 'extensions/wholesale/dist/api');
const CORE_GET_AJV = path.resolve(process.cwd(), 'packages/evershop/dist/modules/base/services/getAjv.js');

const readJson = (route: string, file: string) =>
  JSON.parse(fs.readFileSync(path.join(EXTENSION_API, route, file), 'utf8')) as Record<string, unknown>;

type Handler = (request: EvershopRequest, response: EvershopResponse, next: (err?: unknown) => void) => Promise<void>;

interface Outcome {
  status?: number;
  json?: unknown;
  body?: unknown;
  next: unknown[];
}

async function call(handler: Handler, params: Record<string, string>, body: unknown): Promise<Outcome> {
  const outcome: Outcome = { next: [] };
  const response = {
    status(code: number) {
      outcome.status = code;
      return response;
    },
    json(payload: unknown) {
      outcome.json = payload;
      return response;
    },
    $body: undefined as unknown
  };
  await handler(
    { params, body } as unknown as EvershopRequest,
    response as unknown as EvershopResponse,
    (err?: unknown) => {
      outcome.next.push(err);
    }
  );
  outcome.body = response.$body;
  return outcome;
}

describe('product line routes (T-2.42)', () => {
  it.each([
    ['createProductLine', { methods: ['POST'], path: '/wholesale/product-lines', access: 'private' }],
    ['updateProductLine', { methods: ['PATCH'], path: '/wholesale/product-lines/:id', access: 'private' }],
    ['saveProductLineTiers', { methods: ['PUT'], path: '/wholesale/product-lines/:id/tiers', access: 'private' }]
  ])('%s declares a private admin route', (route, expected) => {
    expect(readJson(route, 'route.json')).toEqual(expected);
  });

  describe('payload schemas (400 per field, core payloadValidate)', () => {
    type Validate = ((data: unknown) => boolean) & { errors?: Array<{ message?: string }> | null };
    let compile: (schema: unknown) => Validate;

    beforeAll(async () => {
      const { getAjv } = (await import(pathToFileURL(CORE_GET_AJV).href)) as {
        getAjv: () => { compile: (schema: unknown) => Validate };
      };
      const ajv = getAjv();
      compile = (schema) => ajv.compile(schema);
    });

    /** The message core `payloadValidate` would answer with (`errors[0].message`), or `null` when valid. */
    function messageOf(route: string, body: unknown): string | null {
      const validate = compile(readJson(route, 'payloadSchema.json'));
      return validate(body) ? null : (validate.errors?.[0]?.message ?? '');
    }

    it('createProductLine', () => {
      expect(messageOf('createProductLine', { name: 'Herramientas', countsTowardMix: true, isActive: true })).toBeNull();
      expect(messageOf('createProductLine', { name: 'Herramientas' })).toBeNull();
      expect(messageOf('createProductLine', {})).toMatch(/^name/);
      expect(messageOf('createProductLine', { name: '' })).toMatch(/^name/);
      expect(messageOf('createProductLine', { name: '   ' })).toMatch(/^name/);
      expect(messageOf('createProductLine', { name: 'x'.repeat(256) })).toMatch(/^name/);
      expect(messageOf('createProductLine', { name: 7 })).toMatch(/^name/);
      expect(messageOf('createProductLine', { name: 'A', countsTowardMix: 'yes' })).toMatch(/^countsTowardMix/);
      expect(messageOf('createProductLine', { name: 'A', isActive: 1 })).toMatch(/^isActive/);
      expect(messageOf('createProductLine', { name: 'A', tiers: [] })).toMatch(/unknown field/);
    });

    it('updateProductLine', () => {
      expect(messageOf('updateProductLine', { isActive: false })).toBeNull();
      expect(messageOf('updateProductLine', { name: 'B', countsTowardMix: false })).toBeNull();
      expect(messageOf('updateProductLine', {})).toMatch(/at least one/);
      expect(messageOf('updateProductLine', { name: ' ' })).toMatch(/^name/);
      expect(messageOf('updateProductLine', { isActive: 'false' })).toMatch(/^isActive/);
      expect(messageOf('updateProductLine', { countsTowardMix: null })).toMatch(/^countsTowardMix/);
      expect(messageOf('updateProductLine', { uuid: randomUUID() })).toMatch(/unknown field/);
    });

    it('saveProductLineTiers', () => {
      expect(messageOf('saveProductLineTiers', { tiers: [] })).toBeNull();
      expect(
        messageOf('saveProductLineTiers', {
          tiers: [
            { fromQty: 1, discountPercent: 0 },
            { fromQty: 10, discountPercent: 5.5, label: 'Bronce' },
            { fromQty: 20, discountPercent: 6, label: null }
          ]
        })
      ).toBeNull();
      // Ranges, order and label length are left to validateLineTiers (422 per row).
      expect(messageOf('saveProductLineTiers', { tiers: [{ fromQty: 0, discountPercent: 150, label: 'x'.repeat(80) }] })).toBeNull();
      expect(messageOf('saveProductLineTiers', {})).toMatch(/^tiers/);
      expect(messageOf('saveProductLineTiers', { tiers: {} })).toMatch(/^tiers/);
      expect(messageOf('saveProductLineTiers', { tiers: Array.from({ length: 51 }, (_v, i) => ({ fromQty: i + 1, discountPercent: 0 })) })).toMatch(/^tiers/);
      expect(messageOf('saveProductLineTiers', { tiers: [{ discountPercent: 1 }] })).toMatch(/^fromQty/);
      expect(messageOf('saveProductLineTiers', { tiers: [{ fromQty: 1.5, discountPercent: 1 }] })).toMatch(/^fromQty/);
      expect(messageOf('saveProductLineTiers', { tiers: [{ fromQty: 1 }] })).toMatch(/^discountPercent/);
      expect(messageOf('saveProductLineTiers', { tiers: [{ fromQty: 1, discountPercent: '5' }] })).toMatch(/^discountPercent/);
      expect(messageOf('saveProductLineTiers', { tiers: [{ fromQty: 1, discountPercent: 1, label: 3 }] })).toMatch(/^label/);
      expect(messageOf('saveProductLineTiers', { tiers: [{ fromQty: 1, discountPercent: 1, id: 3 }] })).toMatch(/unknown field/);
    });
  });

  it.each([
    ['updateProductLine', createUpdateProductLineHandler, { isActive: false }],
    ['saveProductLineTiers', createSaveProductLineTiersHandler, { tiers: [] }]
  ])('%s answers 404 PRODUCT_LINE_NOT_FOUND for an id that is not a uuid, before any database work', async (_route, factory, body) => {
    let acquired = 0;
    const handler = factory(async () => {
      acquired += 1;
      throw new Error('must not acquire');
    });
    const outcome = await call(handler, { id: '42' }, body);
    expect(acquired).toBe(0);
    expect(outcome.status).toBe(404);
    expect(outcome.json).toEqual({
      error: { status: 404, code: 'PRODUCT_LINE_NOT_FOUND', message: 'Product line not found' }
    });
    expect(outcome.next).toEqual([]);
  });
});

interface SavepointConnection {
  INTRANSACTION?: boolean;
  statements: string[];
  released: number;
  query(text: unknown, values?: unknown[]): Promise<unknown>;
  release(): void;
}

function savepointConnection(client: PoolClient, failOn?: RegExp): SavepointConnection {
  const savepoint = 'product_line_handler';
  const connection: SavepointConnection = {
    statements: [],
    released: 0,
    async query(text: unknown, values?: unknown[]) {
      const sql = typeof text === 'string' ? text : String((text as { text?: unknown })?.text ?? '');
      const statement = sql.trim().toUpperCase();
      if (statement === 'BEGIN' || statement === 'COMMIT' || statement === 'ROLLBACK') {
        connection.statements.push(statement);
        return client.query(
          { BEGIN: `SAVEPOINT ${savepoint}`, COMMIT: `RELEASE SAVEPOINT ${savepoint}`, ROLLBACK: `ROLLBACK TO SAVEPOINT ${savepoint}` }[
            statement
          ]
        );
      }
      if (failOn?.test(sql)) {
        throw new Error(`injected failure: ${sql.slice(0, 40)}`);
      }
      return client.query(text as string, values);
    },
    release() {
      connection.released += 1;
    }
  };
  return connection;
}

describeDb('product line handlers transaction path (T-2.42)', () => {
  let fixtures: Fixtures;

  beforeAll(async () => {
    fixtures = await openFixtures();
    await migrate110(fixtures.client);
  }, 30000);

  afterAll(async () => {
    await fixtures?.close();
  });

  const acquireFrom = (connection: SavepointConnection) => async () => connection as unknown as PoolClient;
  const name = (prefix: string) => `${prefix} ${randomUUID()}`;

  async function created(lineName: string) {
    const connection = savepointConnection(fixtures.client);
    const outcome = await call(createCreateProductLineHandler(acquireFrom(connection)), {}, { name: lineName });
    return (outcome.body as { data: { uuid: string } }).data;
  }

  async function tiersOf(uuid: string) {
    const { rows } = await fixtures.client.query(
      `SELECT t."from_qty" FROM "wholesale_product_line_tier" t
         JOIN "wholesale_product_line" l USING ("wholesale_product_line_id")
        WHERE l."uuid" = $1 ORDER BY 1`,
      [uuid]
    );
    return rows.map((r) => r.from_qty as number);
  }

  it('POST creates the line (201) inside one committed transaction', async () => {
    const lineName = name('Herramientas Manuales');
    const connection = savepointConnection(fixtures.client);
    const outcome = await call(createCreateProductLineHandler(acquireFrom(connection)), {}, {
      name: lineName,
      countsTowardMix: true,
      isActive: true
    });
    expect(connection.statements).toEqual(['BEGIN', 'COMMIT']);
    expect(connection.released).toBe(1);
    expect(outcome.status).toBe(201);
    expect(outcome.json).toBeUndefined();
    expect(outcome.body).toEqual({
      data: { uuid: expect.any(String), name: lineName, isActive: true, countsTowardMix: true, tiers: [] }
    });
    expect(outcome.next).toEqual([undefined]);
  });

  it('POST answers 409 PRODUCT_LINE_NAME_TAKEN itself and rolls back', async () => {
    const lineName = name('Taken');
    await created(lineName);
    const connection = savepointConnection(fixtures.client);
    const outcome = await call(createCreateProductLineHandler(acquireFrom(connection)), {}, { name: lineName.toUpperCase() });
    expect(connection.statements).toEqual(['BEGIN', 'ROLLBACK']);
    expect(connection.released).toBe(1);
    expect(outcome.status).toBe(409);
    expect(outcome.json).toEqual({
      error: {
        status: 409,
        code: 'PRODUCT_LINE_NAME_TAKEN',
        message: 'Another product line already uses this name',
        details: { field: 'name' }
      }
    });
    expect(outcome.next).toEqual([]);
  });

  it('POST answers 400 INVALID_PAYLOAD itself for a name over 255 characters after core HTML escaping', async () => {
    const connection = savepointConnection(fixtures.client);
    const outcome = await call(createCreateProductLineHandler(acquireFrom(connection)), {}, { name: '&lt;'.repeat(64) });
    expect(outcome.status).toBe(400);
    expect(outcome.json).toMatchObject({ error: { status: 400, code: 'INVALID_PAYLOAD', details: { field: 'name' } } });
  });

  it('PATCH renames and deactivates (200)', async () => {
    const line = await created(name('Rename'));
    const renamed = name('Renamed');
    const connection = savepointConnection(fixtures.client);
    const outcome = await call(createUpdateProductLineHandler(acquireFrom(connection)), { id: line.uuid }, {
      name: renamed,
      isActive: false
    });
    expect(connection.statements).toEqual(['BEGIN', 'COMMIT']);
    expect(outcome.status).toBe(200);
    expect(outcome.body).toEqual({
      data: { uuid: line.uuid, name: renamed, isActive: false, countsTowardMix: false, tiers: [] }
    });
  });

  it('PATCH answers 404 for an unknown uuid and rolls back', async () => {
    const connection = savepointConnection(fixtures.client);
    const outcome = await call(createUpdateProductLineHandler(acquireFrom(connection)), { id: randomUUID() }, { isActive: true });
    expect(connection.statements).toEqual(['BEGIN', 'ROLLBACK']);
    expect(outcome.status).toBe(404);
    expect(outcome.json).toMatchObject({ error: { status: 404, code: 'PRODUCT_LINE_NOT_FOUND' } });
  });

  it('PUT tiers replaces the table (200) and returns it ordered', async () => {
    const line = await created(name('Tiers'));
    const connection = savepointConnection(fixtures.client);
    const outcome = await call(createSaveProductLineTiersHandler(acquireFrom(connection)), { id: line.uuid }, {
      tiers: [
        { fromQty: 1, discountPercent: 0 },
        { fromQty: 12, discountPercent: 8, label: 'Oro' }
      ]
    });
    expect(connection.statements).toEqual(['BEGIN', 'COMMIT']);
    expect(outcome.status).toBe(200);
    expect(outcome.body).toEqual({
      data: {
        uuid: line.uuid,
        name: expect.any(String),
        isActive: true,
        countsTowardMix: false,
        tiers: [
          { fromQty: 1, discountPercent: 0, label: null },
          { fromQty: 12, discountPercent: 8, label: 'Oro' }
        ]
      }
    });
    expect(await tiersOf(line.uuid)).toEqual([1, 12]);
  });

  it('PUT tiers answers 422 INVALID_TIERS with per-row errors and keeps the previous table', async () => {
    const line = await created(name('Invalid'));
    await call(createSaveProductLineTiersHandler(acquireFrom(savepointConnection(fixtures.client))), { id: line.uuid }, {
      tiers: [{ fromQty: 5, discountPercent: 1 }]
    });

    const connection = savepointConnection(fixtures.client);
    const outcome = await call(createSaveProductLineTiersHandler(acquireFrom(connection)), { id: line.uuid }, {
      tiers: [
        { fromQty: 10, discountPercent: 10 },
        { fromQty: 5, discountPercent: 101, label: 'x'.repeat(65) }
      ]
    });
    expect(connection.statements).toEqual(['BEGIN', 'ROLLBACK']);
    expect(outcome.status).toBe(422);
    expect(outcome.json).toEqual({
      error: {
        status: 422,
        code: 'INVALID_TIERS',
        message: 'The tier table is invalid',
        details: {
          errors: [
            { index: 1, field: 'fromQty', code: 'TIERS_OUT_OF_ORDER', message: expect.any(String) },
            { index: 1, field: 'discountPercent', code: 'DISCOUNT_INVALID', message: expect.any(String) },
            { index: 1, field: 'label', code: 'LABEL_TOO_LONG', message: expect.any(String) }
          ]
        }
      }
    });
    expect(await tiersOf(line.uuid)).toEqual([5]);
  });

  it('PUT tiers rolls back and forwards an unexpected failure to the core error handler', async () => {
    const line = await created(name('Failure'));
    await call(createSaveProductLineTiersHandler(acquireFrom(savepointConnection(fixtures.client))), { id: line.uuid }, {
      tiers: [{ fromQty: 5, discountPercent: 1 }]
    });

    const connection = savepointConnection(fixtures.client, /INSERT INTO "wholesale_product_line_tier"/);
    const outcome = await call(createSaveProductLineTiersHandler(acquireFrom(connection)), { id: line.uuid }, {
      tiers: [{ fromQty: 7, discountPercent: 2 }]
    });
    expect(connection.statements).toEqual(['BEGIN', 'ROLLBACK']);
    expect(connection.released).toBe(1);
    expect(outcome.status).toBeUndefined();
    expect(outcome.body).toBeUndefined();
    expect(outcome.next).toHaveLength(1);
    expect(String(outcome.next[0])).toMatch(/injected failure/);
    // The DELETE ran before the failing INSERT; the rollback restores the table.
    expect(await tiersOf(line.uuid)).toEqual([5]);
  });
});
