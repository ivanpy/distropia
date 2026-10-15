/**
 * D-P2-7 / W4b (a): the core admin `PATCH /api/customers/:id`
 * (`modules/customer/api/updateCustomer/updateCustomer.js`) writes the
 * request body straight into `customer`, without the core `updateCustomer`
 * service, its processors or hooks. The extension middleware that runs before
 * that handler must:
 *
 * - strip every approval column (approval only through the audited
 *   `POST /api/wholesale/customers/:id/approval`);
 * - refuse (422 `WHOLESALE_REVOKE_REQUIRED`, nothing written) a phone or
 *   tax_id change on an approved wholesale customer, re-read from the database;
 * - validate and normalize a changed tax_id of any other customer
 *   (`checkTaxpayer`, 422 with the taxpayer code) and normalize the phone;
 * - leave a body without relevant fields untouched.
 *
 * DB cases run on the rolled-back fixture transaction handed to the
 * middleware as the request context pool; runtime mode is development (DNIT
 * mock).
 */
import { randomUUID } from 'crypto';
import fs from 'fs';
import path from 'path';
import { pathToFileURL } from 'url';
import type { EvershopRequest } from '@evershop/evershop/types/request';
import type { EvershopResponse } from '@evershop/evershop/types/response';
import { PROTECTED_CUSTOMER_FIELDS } from '../../../services/customer/sanitizeWholesaleFields.js';
import { rucCheckDigit } from '../../../services/taxpayer/rucCheckDigit.js';
import { describeDb, openFixtures, type Fixtures } from '../graphql/storefrontSchema.js';
import { EXTENSION_API, sortedRouteMiddlewareIds } from './coreMiddleware.js';

const ROUTE_ID = 'updateCustomer';
const MIDDLEWARE_FILE = '[escapeHtml]guardWholesaleCustomerUpdate[updateCustomer].js';
const MIDDLEWARE_ID = 'guardWholesaleCustomerUpdate';

type Row = Record<string, unknown>;
type Middleware = (request: EvershopRequest, response: EvershopResponse, next: (err?: unknown) => void) => Promise<void>;

interface Outcome {
  status?: number;
  body?: unknown;
  next: unknown[];
  requestBody: unknown;
}

async function loadMiddleware(): Promise<Middleware> {
  return (await import(pathToFileURL(path.join(EXTENSION_API, ROUTE_ID, MIDDLEWARE_FILE)).href)).default as Middleware;
}

async function runGuard(uuid: string, body: unknown, pool?: unknown): Promise<Outcome> {
  const outcome: Outcome = { next: [], requestBody: undefined };
  const request = {
    params: { id: uuid },
    body,
    locals: { context: pool ? { pool } : {} },
    app: { locals: { context: {} } }
  };
  const response = {
    status(code: number) {
      outcome.status = code;
      return response;
    },
    json(payload: unknown) {
      outcome.body = payload;
      return response;
    }
  };
  await (await loadMiddleware())(
    request as unknown as EvershopRequest,
    response as unknown as EvershopResponse,
    (err?: unknown) => {
      outcome.next.push(err);
    }
  );
  outcome.requestBody = request.body;
  return outcome;
}

describe('admin customer PATCH guard wiring (D-P2-7)', () => {
  it('ships the middleware for the core updateCustomer route', () => {
    expect(fs.existsSync(path.join(EXTENSION_API, ROUTE_ID, MIDDLEWARE_FILE))).toBe(true);
  });

  it('is an active (3-arg) middleware: it answers refusals itself', async () => {
    expect((await loadMiddleware()).length).toBe(3);
  });

  it('runs after auth/payload validation and before the core handler writes the body', async () => {
    const ids = await sortedRouteMiddlewareIds(ROUTE_ID);
    const guard = ids.indexOf(MIDDLEWARE_ID);
    expect(guard).toBeGreaterThanOrEqual(0); // dropped by core when a dependency is missing
    expect(ids.indexOf('auth')).toBeLessThan(guard);
    expect(ids.indexOf('payloadValidate')).toBeLessThan(guard);
    expect(ids.indexOf('escapeHtml')).toBeLessThan(guard);
    expect(ids.indexOf('updateCustomer')).toBeGreaterThan(guard);
  });

  it('strips every protected column and passes a body without phone/tax_id through without the database', async () => {
    const body: Row = { full_name: 'New Name', status: 1 };
    for (const key of PROTECTED_CUSTOMER_FIELDS) body[key] = key === 'is_wholesale_approved' ? true : '2026-10-01';
    const outcome = await runGuard(randomUUID(), body);
    expect(outcome.next).toEqual([undefined]);
    expect(outcome.status).toBeUndefined();
    expect(outcome.requestBody).toEqual({ full_name: 'New Name', status: 1 });
  });

  it('passes an empty or non-object body through untouched', async () => {
    expect((await runGuard(randomUUID(), {})).requestBody).toEqual({});
    expect((await runGuard(randomUUID(), undefined)).next).toEqual([undefined]);
  });

  it('fails closed when phone/tax_id must be checked and no database pool is available', async () => {
    const outcome = await runGuard(randomUUID(), { phone: '+595981000000' });
    expect(outcome.status).toBeUndefined();
    expect(outcome.next).toHaveLength(1);
    expect(outcome.next[0]).toBeInstanceOf(Error);
  });
});

let nextBase = 71000000;
function uniqueRuc(): string {
  nextBase += 2;
  const base = String(nextBase);
  return `${base}-${rucCheckDigit(base)}`;
}

describeDb('admin customer PATCH guard (D-P2-7)', () => {
  let fixtures: Fixtures;

  beforeAll(async () => {
    fixtures = await openFixtures();
  }, 30000);

  afterAll(async () => {
    await fixtures?.close();
  });

  async function insertCustomer(approved: boolean, wholesale = true): Promise<Row> {
    const { rows } = await fixtures.client.query(
      `INSERT INTO "customer" ("email", "password", "full_name", "business_name", "tax_id", "phone",
                               "wholesale_requested_at", "is_wholesale_approved", "wholesale_approved_at",
                               "wholesale_approved_by")
       VALUES ($1, 'x', 'Buyer', 'FERRETERIA CENTRAL S.A.', $2, '+595981123456', $3, $4, $5, $6) RETURNING *`,
      [
        `wholesale-w4b-${randomUUID()}@example.com`,
        wholesale ? uniqueRuc() : null,
        wholesale ? new Date() : null,
        approved,
        approved ? new Date() : null,
        approved ? 7 : null
      ]
    );
    return rows[0] as Row;
  }

  async function stored(uuid: unknown): Promise<Row> {
    const { rows } = await fixtures.client.query(
      `SELECT "phone", "tax_id", "is_wholesale_approved", "wholesale_approved_by" FROM "customer" WHERE "uuid" = $1`,
      [uuid]
    );
    return rows[0] as Row;
  }

  const refusal = {
    error: {
      status: 422,
      code: 'WHOLESALE_REVOKE_REQUIRED',
      message: expect.stringMatching(/approval/i)
    }
  };

  it('approved customer: a phone change is refused with 422 and nothing reaches the core handler', async () => {
    const customer = await insertCustomer(true);
    const before = await stored(customer.uuid);
    const outcome = await runGuard(customer.uuid as string, { phone: '+595971999888', full_name: 'X' }, fixtures.client);
    expect(outcome.status).toBe(422);
    expect(outcome.body).toEqual(refusal);
    expect(outcome.next).toEqual([]);
    expect(await stored(customer.uuid)).toEqual(before);
  });

  it('approved customer: a tax_id change (also an invalid or emptied one) is refused with 422', async () => {
    const customer = await insertCustomer(true);
    for (const taxId of [uniqueRuc(), '80012344-9', '', null]) {
      const outcome = await runGuard(customer.uuid as string, { tax_id: taxId }, fixtures.client);
      expect([taxId, outcome.status, outcome.next]).toEqual([taxId, 422, []]);
      expect(outcome.body).toEqual(refusal);
    }
  });

  it('approved customer: the same phone and RUC in another format pass, normalized', async () => {
    const customer = await insertCustomer(true);
    const ruc = customer.tax_id as string;
    const outcome = await runGuard(
      customer.uuid as string,
      { phone: '+595 (981) 123-456', tax_id: ` ${ruc.slice(0, 2)}.${ruc.slice(2)} `, full_name: 'Renamed' },
      fixtures.client
    );
    expect(outcome.next).toEqual([undefined]);
    expect(outcome.requestBody).toEqual({ phone: '+595981123456', tax_id: ruc, full_name: 'Renamed' });
  });

  it('approved customer: approval columns in the body are stripped, the rest passes', async () => {
    const customer = await insertCustomer(true);
    const outcome = await runGuard(
      customer.uuid as string,
      { is_wholesale_approved: false, wholesale_approved_by: 1, email: 'other@example.com' },
      fixtures.client
    );
    expect(outcome.next).toEqual([undefined]);
    expect(outcome.requestBody).toEqual({ email: 'other@example.com' });
  });

  it('pending customer: a changed RUC is validated and normalized, the phone normalized', async () => {
    const customer = await insertCustomer(false);
    const ruc = uniqueRuc();
    const outcome = await runGuard(
      customer.uuid as string,
      { tax_id: ruc.replace('-', ' - '), phone: '+595 971 000 111', is_wholesale_approved: true },
      fixtures.client
    );
    expect(outcome.next).toEqual([undefined]);
    expect(outcome.requestBody).toMatchObject({ tax_id: ruc, phone: '+595971000111' });
    expect(outcome.requestBody).not.toHaveProperty('is_wholesale_approved');
  });

  it('pending or retail customer: an invalid RUC is refused with 422 and the taxpayer code', async () => {
    for (const customer of [await insertCustomer(false), await insertCustomer(false, false)]) {
      const outcome = await runGuard(customer.uuid as string, { tax_id: '80012344-9' }, fixtures.client);
      expect(outcome.status).toBe(422);
      expect(outcome.body).toMatchObject({ error: { status: 422, code: 'RUC_INVALID_CHECK_DIGIT' } });
      expect(outcome.next).toEqual([]);
    }
  });

  it('retail customer: an unchanged empty tax_id is not validated', async () => {
    const customer = await insertCustomer(false, false);
    const outcome = await runGuard(customer.uuid as string, { tax_id: '', full_name: 'Retail' }, fixtures.client);
    expect(outcome.next).toEqual([undefined]);
    expect(outcome.requestBody).toEqual({ tax_id: '', full_name: 'Retail' });
  });

  it('unknown customer: passes through so the core handler answers "Invalid customer id"', async () => {
    const outcome = await runGuard(randomUUID(), { phone: '+595981000000' }, fixtures.client);
    expect(outcome.next).toEqual([undefined]);
  });
});
