/**
 * T-2.13 (CU-01b, `03_endpoints_y_contratos.md` §7 Catálogo):
 * `POST /api/wholesale/products/:id/rule` (admin, private), `:id` = product
 * uuid, body = schema v2.0. A body with `tiers` is a 400 from the core
 * `payloadValidate` middleware (`additionalProperties: false`): tiers are
 * edited on the line.
 *
 * The handler runs its transaction on a connection over the rolled-back
 * fixture transaction (BEGIN / COMMIT / ROLLBACK become savepoints).
 */
import { randomUUID } from 'crypto';
import fs from 'fs';
import path from 'path';
import { pathToFileURL } from 'url';
import type { PoolClient } from 'pg';
import type { EvershopRequest } from '@evershop/evershop/types/request';
import type { EvershopResponse } from '@evershop/evershop/types/response';
import { createSaveProductRuleHandler } from '../../../api/saveProductRule/saveProductRule.js';
import migrate110 from '../../../migration/Version-1.1.0.js';
import { createProductLine } from '../../../services/line/productLines.js';
import { describeDb, openFixtures, type Fixtures } from '../graphql/storefrontSchema.js';
import { insertProduct } from '../rule/ruleFixtures.js';

const ROUTE_DIR = path.resolve(process.cwd(), 'extensions/wholesale/dist/api/saveProductRule');
const CORE_GET_AJV = path.resolve(process.cwd(), 'packages/evershop/dist/modules/base/services/getAjv.js');

const readJson = (file: string) => JSON.parse(fs.readFileSync(path.join(ROUTE_DIR, file), 'utf8')) as Record<string, unknown>;

const BODY = {
  isEnabled: true,
  productLineUuid: null,
  basePrice: 15000,
  vatRate: '10',
  isCriticalConsumable: false,
  minQty: 6,
  stepQty: 6,
  maxQty: null
};

type Handler = (request: EvershopRequest, response: EvershopResponse, next: (err?: unknown) => void) => Promise<void>;

interface Outcome {
  status?: number;
  json?: unknown;
  body?: unknown;
  next: unknown[];
}

async function call(handler: Handler, id: string, body: unknown): Promise<Outcome> {
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
  await handler({ params: { id }, body } as unknown as EvershopRequest, response as unknown as EvershopResponse, (err) => {
    outcome.next.push(err);
  });
  outcome.body = response.$body;
  return outcome;
}

describe('saveProductRule route (T-2.13)', () => {
  it('declares a private admin route', () => {
    expect(readJson('route.json')).toEqual({ methods: ['POST'], path: '/wholesale/products/:id/rule', access: 'private' });
  });

  describe('payload schema v2.0 (400 per field, core payloadValidate)', () => {
    type Validate = ((data: unknown) => boolean) & { errors?: Array<{ message?: string }> | null };
    let validate: Validate;

    beforeAll(async () => {
      const { getAjv } = (await import(pathToFileURL(CORE_GET_AJV).href)) as {
        getAjv: () => { compile: (schema: unknown) => Validate };
      };
      validate = getAjv().compile(readJson('payloadSchema.json'));
    });

    const messageOf = (body: unknown): string | null => (validate(body) ? null : (validate.errors?.[0]?.message ?? ''));

    it('accepts the v2.0 body, with or without the optional keys', () => {
      expect(messageOf(BODY)).toBeNull();
      expect(messageOf({ ...BODY, productLineUuid: randomUUID(), maxQty: 60, vatRate: 'exempt' })).toBeNull();
      const { productLineUuid: _l, basePrice: _b, maxQty: _m, ...required } = BODY;
      expect(messageOf(required)).toBeNull();
    });

    it('rejects tiers: they are edited on the product line', () => {
      expect(messageOf({ ...BODY, tiers: [{ fromQty: 12, discountPercent: 10 }] })).toMatch(/unknown field/);
    });

    it.each<[string, Record<string, unknown>, RegExp]>([
      ['isEnabled missing', { isEnabled: undefined }, /isEnabled/],
      ['vatRate missing', { vatRate: undefined }, /vatRate/],
      ['minQty missing', { minQty: undefined }, /minQty/],
      ['stepQty missing', { stepQty: undefined }, /stepQty/],
      ['isCriticalConsumable missing', { isCriticalConsumable: undefined }, /isCriticalConsumable/],
      ['an unknown VAT rate', { vatRate: '0' }, /^vatRate/],
      ['a numeric VAT rate', { vatRate: 10 }, /^vatRate/],
      ['a line id that is not a uuid', { productLineUuid: '7' }, /^productLineUuid/],
      ['a zero base price', { basePrice: 0 }, /^basePrice/],
      ['a text base price', { basePrice: '100' }, /^basePrice/],
      ['a zero minQty', { minQty: 0 }, /^minQty/],
      ['a fractional stepQty', { stepQty: 1.5 }, /^stepQty/],
      ['a zero maxQty', { maxQty: 0 }, /^maxQty/],
      ['a text isEnabled', { isEnabled: 'true' }, /^isEnabled/],
      ['a numeric product id', { productId: 7 }, /unknown field/]
    ])('rejects %s', (_case, patch, message) => {
      const body: Record<string, unknown> = { ...BODY, ...patch };
      Object.keys(body).forEach((key) => body[key] === undefined && delete body[key]);
      expect(messageOf(body)).toMatch(message);
    });
  });

  it('answers 404 PRODUCT_NOT_FOUND for an id that is not a uuid, before any database work', async () => {
    let acquired = 0;
    const handler = createSaveProductRuleHandler(async () => {
      acquired += 1;
      throw new Error('must not acquire');
    });
    const outcome = await call(handler, '42', BODY);
    expect(acquired).toBe(0);
    expect(outcome.status).toBe(404);
    expect(outcome.json).toEqual({ error: { status: 404, code: 'PRODUCT_NOT_FOUND', message: 'Product not found' } });
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

function savepointConnection(client: PoolClient): SavepointConnection {
  const savepoint = 'product_rule_handler';
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
      return client.query(text as Parameters<PoolClient['query']>[0], values);
    },
    release() {
      connection.released += 1;
    }
  };
  return connection;
}

describeDb('saveProductRule handler transaction path (T-2.13)', () => {
  let fixtures: Fixtures;

  beforeAll(async () => {
    fixtures = await openFixtures();
    await migrate110(fixtures.client);
  }, 30000);

  afterAll(async () => {
    await fixtures?.close();
  });

  const handlerOn = (connection: SavepointConnection) =>
    createSaveProductRuleHandler(async () => connection as unknown as PoolClient);

  it('saves the rule (200) in one committed transaction and returns it', async () => {
    const product = await insertProduct(fixtures.client);
    const line = await createProductLine(fixtures.client, { name: `Endpoint line ${randomUUID()}` });
    const connection = savepointConnection(fixtures.client);
    const outcome = await call(handlerOn(connection), product.uuid, { ...BODY, productLineUuid: line.uuid });

    expect(connection.statements).toEqual(['BEGIN', 'COMMIT']);
    expect(connection.released).toBe(1);
    expect(outcome.status).toBe(200);
    expect(outcome.json).toBeUndefined();
    expect(outcome.body).toEqual({
      data: expect.objectContaining({
        isEnabled: true,
        isQuotable: true,
        basePrice: 15000,
        minQty: 6,
        stepQty: 6,
        maxQty: null,
        productLine: expect.objectContaining({ uuid: line.uuid })
      })
    });
    expect(outcome.next).toEqual([undefined]);
  });

  it.each<[string, () => Promise<{ id: string; body: Record<string, unknown> }>, number, string]>([
    ['an unknown product', async () => ({ id: randomUUID(), body: BODY }), 404, 'PRODUCT_NOT_FOUND'],
    [
      'an unknown line',
      async () => ({ id: (await insertProduct(fixtures.client)).uuid, body: { ...BODY, productLineUuid: randomUUID() } }),
      422,
      'PRODUCT_LINE_NOT_FOUND'
    ],
    [
      'maxQty below minQty',
      async () => ({ id: (await insertProduct(fixtures.client)).uuid, body: { ...BODY, maxQty: 3 } }),
      422,
      'INVALID_RULE'
    ]
  ])('answers %s itself and rolls back', async (_case, prepare, status, code) => {
    const { id, body } = await prepare();
    const connection = savepointConnection(fixtures.client);
    const outcome = await call(handlerOn(connection), id, body);
    expect(connection.statements).toEqual(['BEGIN', 'ROLLBACK']);
    expect(connection.released).toBe(1);
    expect(outcome.status).toBe(status);
    expect(outcome.json).toMatchObject({ error: { status, code } });
    expect(outcome.next).toEqual([]);
  });

  it('hands over after COMMIT: a downstream throw neither rolls back nor calls next twice', async () => {
    const product = await insertProduct(fixtures.client);
    const connection = savepointConnection(fixtures.client);
    const downstream = new Error('downstream failure');
    let nextCalls = 0;
    const response = { status: () => response, json: () => response, $body: undefined as unknown };
    await expect(
      handlerOn(connection)(
        { params: { id: product.uuid }, body: BODY } as unknown as EvershopRequest,
        response as unknown as EvershopResponse,
        () => {
          nextCalls += 1;
          throw downstream;
        }
      )
    ).rejects.toBe(downstream);
    expect(nextCalls).toBe(1);
    expect(connection.statements).toEqual(['BEGIN', 'COMMIT']);
  });
});
