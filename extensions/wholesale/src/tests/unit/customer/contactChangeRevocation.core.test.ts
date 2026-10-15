/**
 * T-2.8 end to end through the compiled core services (RF-22): a profile
 * edition (`updateCustomer`) that changes the phone of an approved wholesale
 * customer stores it unapproved with an audit row in the same transaction;
 * editing a customer address (`updateCustomerAddress`) does not touch the
 * approval.
 *
 * `updateCustomer`: a setup before-hook (priority 1, before the extension
 * hook) applies migrations 1.0.0 + 1.1.0 and inserts the customer inside the
 * core transaction; a probe after-hook snapshots the rows and throws, so the
 * whole transaction (DDL included) rolls back and nothing is left.
 *
 * `updateCustomerAddress` reads the address before any hook runs, so the
 * customer and its address are committed first and deleted in `afterAll`
 * (no audit row is involved: audit rows are append-only).
 */
import { randomUUID } from 'crypto';
import path from 'path';
import type { PoolClient } from 'pg';
import migrate100 from '../../../migration/Version-1.0.0.js';
import migrate110 from '../../../migration/Version-1.1.0.js';
import { describeDb } from '../graphql/storefrontSchema.js';

const CORE_DIST = path.resolve(process.cwd(), 'packages/evershop/dist');
const EXTENSION_DIST = path.resolve(process.cwd(), 'extensions/wholesale/dist');
const EMAIL_PREFIX = 'wholesale-t28-core-';

type Row = Record<string, unknown>;
type CorePool = { query: (sql: string, params?: unknown[]) => Promise<{ rows: Row[] }>; end: () => Promise<void> };
type Service = (uuid: string, data: Row, context?: Row) => Promise<Row>;
type Hook = (name: string, callback: (...args: unknown[]) => unknown, priority?: number) => void;

class ProbeStop extends Error {}

describeDb('RF-22 through core services (T-2.8)', () => {
  let updateCustomer: Service;
  let updateCustomerAddress: Service;
  let pool: CorePool;
  let setup: ((connection: PoolClient) => Promise<void>) | null = null;
  let snapshot: { customer: Row; audits: Row[] } | null = null;

  beforeAll(async () => {
    ({ default: updateCustomer } = (await import(
      path.join(CORE_DIST, 'modules/customer/services/customer/updateCustomer.js')
    )) as { default: Service });
    ({ default: updateCustomerAddress } = (await import(
      path.join(CORE_DIST, 'modules/customer/services/customer/address/updateCustomerAddress.js')
    )) as { default: Service });
    ({ pool } = (await import(path.join(CORE_DIST, 'lib/postgres/connection.js'))) as { pool: CorePool });
    const { hookBefore, hookAfter } = (await import(path.join(CORE_DIST, 'lib/util/hookable.js'))) as {
      hookBefore: Hook;
      hookAfter: Hook;
    };
    const bootstrap = (
      (await import(path.join(EXTENSION_DIST, 'bootstrap.js'))) as { default: (c?: Row) => void }
    ).default;
    bootstrap({ command: 'test' });

    hookBefore(
      'updateCustomerData',
      async function setupInCoreTransaction(...args: unknown[]) {
        if (setup) await setup(args[2] as PoolClient);
      },
      1
    );
    const probe = (table: 'customer' | 'customer_address') =>
      async function probe(...args: unknown[]) {
        // After-hooks receive (result, uuid, data, connection); both results carry `customer_id`.
        const result = args[0] as Row;
        const connection = args[3] as PoolClient;
        const { rows } = await connection.query(
          `SELECT "phone", "is_wholesale_approved", "wholesale_approved_at", "wholesale_approved_by"
             FROM "customer" WHERE "customer_id" = $1`,
          [result.customer_id]
        );
        let audits: Row[] = [];
        if (table === 'customer') {
          ({ rows: audits } = await connection.query(
            `SELECT "actor_type", "action", "reason" FROM "wholesale_audit_log" WHERE "entity_uuid" = $1`,
            [result.uuid]
          ));
        }
        snapshot = { customer: rows[0], audits };
        throw new ProbeStop('probe: roll the update back');
      };
    hookAfter('updateCustomerData', probe('customer'), 1000);
    hookAfter('updateCustomerAddressData', probe('customer_address'), 1000);
  }, 30000);

  beforeEach(() => {
    setup = null;
    snapshot = null;
  });

  afterAll(async () => {
    if (pool) {
      await pool.query(
        `DELETE FROM "customer_address" WHERE "customer_id" IN (SELECT "customer_id" FROM "customer" WHERE "email" LIKE $1)`,
        [`${EMAIL_PREFIX}%`]
      );
      await pool.query('DELETE FROM "customer" WHERE "email" LIKE $1', [`${EMAIL_PREFIX}%`]);
      await pool.end();
    }
  });

  async function outcome(promise: Promise<unknown>): Promise<unknown> {
    try {
      await promise;
    } catch (e) {
      if (e instanceof ProbeStop) return 'PROBE';
      return (e as Error).message;
    }
    return 'COMMITTED';
  }

  /** Inserts an approved wholesale customer inside the core transaction (after the migrations). */
  const approvedCustomerSetup = (uuid: string) => async (connection: PoolClient) => {
    await migrate100(connection);
    await migrate110(connection);
    await connection.query(
      `INSERT INTO "customer" ("uuid", "email", "password", "full_name", "tax_id", "phone",
                               "wholesale_requested_at", "is_wholesale_approved", "wholesale_approved_at",
                               "wholesale_approved_by")
       VALUES ($1, $2, 'x', 'Buyer', NULL, '+595981123456', CURRENT_TIMESTAMP, true, CURRENT_TIMESTAMP, 7)`,
      [uuid, `${EMAIL_PREFIX}${uuid}@example.com`]
    );
  };

  it('a profile phone change stores the customer unapproved, audited in the same transaction', async () => {
    const uuid = randomUUID();
    setup = approvedCustomerSetup(uuid);
    expect(await outcome(updateCustomer(uuid, { phone: '+595 982 000 111' }, { routeId: 'updateCustomerProfile' }))).toBe(
      'PROBE'
    );
    expect(snapshot).toEqual({
      customer: {
        phone: '+595982000111',
        is_wholesale_approved: false,
        wholesale_approved_at: null,
        wholesale_approved_by: null
      },
      audits: [{ actor_type: 'system', action: 'customer.revoke', reason: 'Automatic revocation (RF-22): phone changed' }]
    });
  }, 30000);

  it('a profile change of other fields keeps the approval', async () => {
    const uuid = randomUUID();
    setup = approvedCustomerSetup(uuid);
    expect(await outcome(updateCustomer(uuid, { full_name: 'Renamed' }, { routeId: 'updateCustomerProfile' }))).toBe(
      'PROBE'
    );
    expect(snapshot?.customer).toMatchObject({ is_wholesale_approved: true, wholesale_approved_by: 7 });
    expect(snapshot?.audits).toEqual([]);
  }, 30000);

  it('editing an address of an approved customer does not touch the approval', async () => {
    const { rows } = await pool.query(
      `INSERT INTO "customer" ("email", "password", "full_name", "phone", "wholesale_requested_at",
                               "is_wholesale_approved", "wholesale_approved_at", "wholesale_approved_by")
       VALUES ($1, 'x', 'Buyer', '+595981123456', CURRENT_TIMESTAMP, true, CURRENT_TIMESTAMP, 7)
       RETURNING "customer_id"`,
      [`${EMAIL_PREFIX}address-${randomUUID()}@example.com`]
    );
    const { rows: addresses } = await pool.query(
      `INSERT INTO "customer_address" ("customer_id", "full_name", "telephone", "address_1", "city", "province",
                                       "country", "postcode", "is_default")
       VALUES ($1, 'Buyer', '+595981123456', 'Street 1', 'Asuncion', 'PY-ASU', 'PY', '1209', true)
       RETURNING "uuid"`,
      [rows[0].customer_id]
    );

    expect(
      await outcome(
        updateCustomerAddress(addresses[0].uuid as string, { telephone: '+595982000111', address_1: 'Street 2' }, {})
      )
    ).toBe('PROBE');
    expect(snapshot?.customer).toEqual({
      phone: '+595981123456',
      is_wholesale_approved: true,
      wholesale_approved_at: expect.any(Date),
      wholesale_approved_by: 7
    });
  }, 30000);
});
