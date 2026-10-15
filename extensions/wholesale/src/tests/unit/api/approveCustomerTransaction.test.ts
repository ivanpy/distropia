/**
 * R3-handler-txn-path-untested: the transaction path of the approval
 * handler `POST /api/wholesale/customers/:id/approval`
 * (`api/approveCustomer/approveCustomer.ts`).
 *
 * The handler acquires its own connection, so the test hands it a connection
 * over the rolled-back fixture transaction where the handler's BEGIN /
 * COMMIT / ROLLBACK become SAVEPOINT / RELEASE / ROLLBACK TO SAVEPOINT.
 * Every row (approval, credit, audit, event) disappears with the fixture
 * rollback: no audit row is ever committed (the audit log is append-only).
 * Inner failures are injected on the audit and event inserts.
 */
import { randomUUID } from 'crypto';
import type { PoolClient } from 'pg';
import type { EvershopRequest } from '@evershop/evershop/types/request';
import type { EvershopResponse } from '@evershop/evershop/types/response';
import { createApproveCustomerHandler } from '../../../api/approveCustomer/approveCustomer.js';
import migrate110 from '../../../migration/Version-1.1.0.js';
import { describeDb, openFixtures, type Fixtures } from '../graphql/storefrontSchema.js';

type Row = Record<string, unknown>;

const ADMIN = { uuid: randomUUID(), admin_user_id: 7, email: 'manager@example.com' };

interface SavepointConnection {
  INTRANSACTION?: boolean;
  /** Transaction statements the handler issued, in order. */
  statements: string[];
  released: number;
  /** SQL text matching this pattern fails (injected inner failure). */
  failOn?: RegExp;
  query(text: unknown, values?: unknown[]): Promise<unknown>;
  release(): void;
}

function savepointConnection(client: PoolClient, failOn?: RegExp): SavepointConnection {
  const savepoint = 'approve_customer_handler';
  const connection: SavepointConnection = {
    statements: [],
    released: 0,
    failOn,
    async query(text: unknown, values?: unknown[]) {
      const sql = typeof text === 'string' ? text : String((text as { text?: unknown })?.text ?? '');
      const statement = sql.trim().toUpperCase();
      if (statement === 'BEGIN' || statement === 'COMMIT' || statement === 'ROLLBACK') {
        connection.statements.push(statement);
        const translated = {
          BEGIN: `SAVEPOINT ${savepoint}`,
          COMMIT: `RELEASE SAVEPOINT ${savepoint}`,
          ROLLBACK: `ROLLBACK TO SAVEPOINT ${savepoint}`
        }[statement];
        return client.query(translated);
      }
      if (connection.failOn?.test(sql)) {
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

interface Outcome {
  status?: number;
  json?: unknown;
  body?: unknown;
  next: unknown[];
}

async function callHandler(connection: SavepointConnection, uuid: string, approved: boolean): Promise<Outcome> {
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
  const handler = createApproveCustomerHandler(async () => connection as unknown as PoolClient);
  await handler(
    { params: { id: uuid }, body: { approved }, getCurrentUser: () => ADMIN } as unknown as EvershopRequest,
    response as unknown as EvershopResponse,
    (err?: unknown) => {
      outcome.next.push(err);
    }
  );
  outcome.body = response.$body;
  return outcome;
}

describeDb('approval handler transaction path (R3-handler-txn-path-untested)', () => {
  let fixtures: Fixtures;

  beforeAll(async () => {
    fixtures = await openFixtures();
    await migrate110(fixtures.client);
  }, 30000);

  afterAll(async () => {
    await fixtures?.close();
  });

  async function insertCustomer(wholesale = true): Promise<Row> {
    const { rows } = await fixtures.client.query(
      `INSERT INTO "customer" ("email", "password", "full_name", "phone", "wholesale_requested_at")
       VALUES ($1, 'x', 'Buyer', '+595981123456', $2) RETURNING *`,
      [`wholesale-w4b-txn-${randomUUID()}@example.com`, wholesale ? new Date() : null]
    );
    return rows[0] as Row;
  }

  async function writes(customer: Row) {
    const one = async (sql: string, value: unknown) => (await fixtures.client.query(sql, [value])).rows;
    return {
      approved: (await one('SELECT "is_wholesale_approved" FROM "customer" WHERE "uuid" = $1', customer.uuid))[0]
        .is_wholesale_approved,
      credit: (await one('SELECT 1 FROM "wholesale_customer_credit" WHERE "customer_id" = $1', customer.customer_id))
        .length,
      audit: (await one('SELECT 1 FROM "wholesale_audit_log" WHERE "entity_uuid" = $1', customer.uuid)).length,
      events: (
        await one(
          `SELECT 1 FROM "event" WHERE "name" = 'wholesale_customer_approved' AND "data"->>'uuid' = $1`,
          customer.uuid
        )
      ).length
    };
  }

  it('commits the approval, credit, audit and event together and answers through apiResponse', async () => {
    const customer = await insertCustomer();
    const connection = savepointConnection(fixtures.client);
    const outcome = await callHandler(connection, customer.uuid as string, true);

    expect(connection.statements).toEqual(['BEGIN', 'COMMIT']);
    expect(connection.released).toBe(1);
    expect(outcome.status).toBe(200);
    expect(outcome.json).toBeUndefined();
    expect(outcome.body).toEqual({
      data: { uuid: customer.uuid, approved: true, approvedAt: expect.any(String), changed: true }
    });
    expect(outcome.next).toEqual([undefined]);
    expect(await writes(customer)).toEqual({ approved: true, credit: 1, audit: 1, events: 1 });
  });

  it.each([
    ['the audit insert', /INSERT INTO "wholesale_audit_log"/],
    ['the event insert', /INSERT INTO\s+"?event"?[\s(]/]
  ])('rolls everything back when %s fails, leaving no approval, credit, audit or event', async (_step, failOn) => {
    const customer = await insertCustomer();
    const connection = savepointConnection(fixtures.client, failOn);
    const outcome = await callHandler(connection, customer.uuid as string, true);

    expect(connection.statements).toEqual(['BEGIN', 'ROLLBACK']);
    expect(connection.released).toBe(1);
    expect(outcome.status).toBeUndefined();
    expect(outcome.body).toBeUndefined();
    expect(outcome.next).toHaveLength(1);
    expect(String(outcome.next[0])).toMatch(/injected failure/);
    expect(await writes(customer)).toEqual({ approved: false, credit: 0, audit: 0, events: 0 });
  });

  it('rolls back and answers 422 itself on a domain refusal (CUSTOMER_NOT_WHOLESALE)', async () => {
    const customer = await insertCustomer(false);
    const connection = savepointConnection(fixtures.client);
    const outcome = await callHandler(connection, customer.uuid as string, true);

    expect(connection.statements).toEqual(['BEGIN', 'ROLLBACK']);
    expect(connection.released).toBe(1);
    expect(outcome.status).toBe(422);
    expect(outcome.json).toMatchObject({ error: { status: 422, code: 'CUSTOMER_NOT_WHOLESALE' } });
    expect(outcome.next).toEqual([]);
    expect(await writes(customer)).toEqual({ approved: false, credit: 0, audit: 0, events: 0 });
  });
});
