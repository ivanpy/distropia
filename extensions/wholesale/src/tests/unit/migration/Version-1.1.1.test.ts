/**
 * Integration test for migration Version-1.1.1 (W4c, R3-guard-read-write-race):
 * the `customer` trigger that enforces the approval rules in the database.
 *
 * 1. An UPDATE that changes `phone` or `tax_id` of an approved customer and
 *    keeps it approved fails with WH001 `WHOLESALE_REVOKE_REQUIRED`.
 * 2. The approval columns change only while the transaction-local setting
 *    `wholesale.approval_write` is `on` (WH002 `WHOLESALE_APPROVAL_PROTECTED`);
 *    an INSERT may set `wholesale_requested_at` (registration) but not an
 *    approval.
 *
 * Runs against the real PostgreSQL configured in `.env` inside one
 * transaction rolled back at the end (migrations 1.0.0 + 1.1.0 + 1.1.1
 * applied in it, 1.0.0 first to keep the lock order of the other suites). Rejections are isolated with savepoints. The flag-leak
 * check uses its own pooled connection and no DDL.
 */
import 'dotenv/config';
import { randomUUID } from 'crypto';
import { update } from '@evershop/postgres-query-builder';
import pg from 'pg';
import migrate100 from '../../../migration/Version-1.0.0.js';
import migrate110 from '../../../migration/Version-1.1.0.js';
import migrate111 from '../../../migration/Version-1.1.1.js';
import {
  APPROVAL_PROTECTED_SQLSTATE,
  APPROVAL_WRITE_SETTING,
  armApprovalWrite,
  REVOKE_REQUIRED_SQLSTATE,
  withApprovalWrite
} from '../../../services/customer/approvalWriteFlag.js';
import { guardAdminCustomerUpdate } from '../../../services/customer/guardAdminCustomerUpdate.js';
import { setCustomerApproval } from '../../../services/customer/setCustomerApproval.js';
import { rucCheckDigit } from '../../../services/taxpayer/rucCheckDigit.js';

const describeDb = process.env.DB_NAME ? describe : describe.skip;

type Row = Record<string, unknown>;
type PgError = Error & { code?: string };

const ADMIN = { type: 'admin', adminUserId: 7, email: 'manager@example.com' } as const;

const poolConfig = () => ({
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT ?? 5432),
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  max: 1
});

let nextBase = 72000000;
function uniqueRuc(): string {
  nextBase += 2;
  const base = String(nextBase);
  return `${base}-${rucCheckDigit(base)}`;
}

describeDb('wholesale migration Version-1.1.1 (customer approval trigger)', () => {
  let pool: pg.Pool;
  let client: pg.PoolClient;
  let savepoint = 0;

  /** Runs `sql` in a savepoint and returns its error; fails the test if it succeeds. */
  async function expectFailure(sql: string, params: unknown[] = []): Promise<PgError> {
    const name = `sp_${(savepoint += 1)}`;
    await client.query(`SAVEPOINT ${name}`);
    try {
      await client.query(sql, params);
    } catch (e) {
      await client.query(`ROLLBACK TO SAVEPOINT ${name}`);
      return e as PgError;
    }
    await client.query(`RELEASE SAVEPOINT ${name}`);
    throw new Error(`Expected statement to fail: ${sql}`);
  }

  /** Same as `expectFailure` for any database work. */
  async function expectRejection(work: () => Promise<unknown>): Promise<PgError> {
    const name = `sp_${(savepoint += 1)}`;
    await client.query(`SAVEPOINT ${name}`);
    try {
      await work();
    } catch (e) {
      await client.query(`ROLLBACK TO SAVEPOINT ${name}`);
      return e as PgError;
    }
    await client.query(`RELEASE SAVEPOINT ${name}`);
    throw new Error('Expected the database work to fail');
  }

  async function flag(): Promise<string | null> {
    const { rows } = await client.query(`SELECT current_setting($1, true) AS "value"`, [APPROVAL_WRITE_SETTING]);
    return rows[0].value as string | null;
  }

  /** Inserts a wholesale (RUC + request) customer; approved ones through the flag. */
  async function insertCustomer(approved: boolean, wholesale = true): Promise<Row> {
    const insert = async () =>
      (
        await client.query(
          `INSERT INTO "customer" ("email", "password", "full_name", "tax_id", "phone",
                                   "wholesale_requested_at", "is_wholesale_approved", "wholesale_approved_at",
                                   "wholesale_approved_by")
           VALUES ($1, 'x', 'Trigger Test', $2, '+595981123456', $3, $4, $5, $6) RETURNING *`,
          [
            `wholesale-w4c-${randomUUID()}@example.com`,
            wholesale ? uniqueRuc() : null,
            wholesale ? new Date() : null,
            approved,
            approved ? new Date() : null,
            approved ? 7 : null
          ]
        )
      ).rows[0] as Row;
    return approved ? withApprovalWrite(client, insert) : insert();
  }

  async function stored(uuid: unknown): Promise<Row> {
    const { rows } = await client.query(
      `SELECT "phone", "tax_id", "is_wholesale_approved", "wholesale_approved_by" FROM "customer" WHERE "uuid" = $1`,
      [uuid]
    );
    return rows[0] as Row;
  }

  /** Every object 1.1.1 creates. */
  async function snapshot(): Promise<string> {
    const triggers = await client.query(
      `SELECT tgname, pg_get_triggerdef(oid) AS def FROM pg_trigger
       WHERE tgrelid = '"customer"'::regclass AND NOT tgisinternal AND tgname LIKE 'wholesale%'
       ORDER BY 1`
    );
    const functions = await client.query(
      `SELECT proname, prosrc FROM pg_proc
       WHERE proname IN ('wholesale_customer_approval_guard', 'wholesale_contact_value') ORDER BY 1`
    );
    return JSON.stringify({ triggers: triggers.rows, functions: functions.rows });
  }

  beforeAll(async () => {
    pool = new pg.Pool(poolConfig());
    client = await pool.connect();
    await client.query('BEGIN');
    (client as pg.PoolClient & { INTRANSACTION?: boolean }).INTRANSACTION = true;
    // 1.0.0 first, as every other DB suite does: its ALTER TABLE "customer"
    // takes the customer lock before any wholesale table, so suites running
    // in parallel queue on the same lock instead of deadlocking.
    await migrate100(client);
    await migrate110(client);
    await migrate111(client);
  }, 30000);

  afterAll(async () => {
    if (client) {
      await client.query('ROLLBACK');
      client.release();
    }
    if (pool) {
      await pool.end();
    }
  });

  it('creates one BEFORE INSERT OR UPDATE row trigger and is a clean no-op when it runs again', async () => {
    const first = await snapshot();
    const parsed = JSON.parse(first) as { triggers: Row[]; functions: Row[] };
    expect(parsed.triggers).toHaveLength(1);
    expect(parsed.triggers[0].def).toMatch(/BEFORE INSERT OR UPDATE ON (public\.)?customer FOR EACH ROW/);
    expect(parsed.functions).toHaveLength(2);
    await expect(migrate111(client)).resolves.toBeUndefined();
    expect(await snapshot()).toEqual(first);
  });

  it('uses the SQLSTATE codes the services recognize', () => {
    expect([REVOKE_REQUIRED_SQLSTATE, APPROVAL_PROTECTED_SQLSTATE]).toEqual(['WH001', 'WH002']);
  });

  describe('rule 1: contact change of an approved customer needs a revocation in the same write', () => {
    it('rejects a phone or tax_id change that keeps the approval, even with the flag armed', async () => {
      const customer = await insertCustomer(true);
      const phone = await expectFailure('UPDATE "customer" SET "phone" = $2 WHERE "uuid" = $1', [
        customer.uuid,
        '+595982000111'
      ]);
      expect(phone.code).toBe('WH001');
      expect(phone.message).toMatch(/^WHOLESALE_REVOKE_REQUIRED/);
      const taxId = await expectFailure('UPDATE "customer" SET "tax_id" = $2 WHERE "uuid" = $1', [
        customer.uuid,
        uniqueRuc()
      ]);
      expect(taxId.code).toBe('WH001');
      const flagged = await expectRejection(() =>
        withApprovalWrite(client, () =>
          client.query('UPDATE "customer" SET "phone" = $2 WHERE "uuid" = $1', [customer.uuid, '+595982000111'])
        )
      );
      expect(flagged.code).toBe('WH001');
      expect(await stored(customer.uuid)).toMatchObject({ phone: '+595981123456', is_wholesale_approved: true });
    });

    it('accepts the change together with the flagged revocation (W4 automatic revocation)', async () => {
      const customer = await insertCustomer(true);
      await withApprovalWrite(client, () =>
        client.query(
          `UPDATE "customer" SET "phone" = $2, "is_wholesale_approved" = false,
                  "wholesale_approved_at" = NULL, "wholesale_approved_by" = NULL
            WHERE "uuid" = $1`,
          [customer.uuid, '+595982000111']
        )
      );
      expect(await stored(customer.uuid)).toEqual({
        phone: '+595982000111',
        tax_id: customer.tax_id,
        is_wholesale_approved: false,
        wholesale_approved_by: null
      });
    });

    it('rejects the revocation itself without the flag', async () => {
      const customer = await insertCustomer(true);
      const error = await expectFailure(
        `UPDATE "customer" SET "phone" = $2, "is_wholesale_approved" = false,
                "wholesale_approved_at" = NULL, "wholesale_approved_by" = NULL
          WHERE "uuid" = $1`,
        [customer.uuid, '+595982000111']
      );
      expect(error.code).toBe('WH002');
      expect(error.message).toMatch(/^WHOLESALE_APPROVAL_PROTECTED/);
    });

    it('lets other columns, the same contact values and a whitespace-padded tax_id through', async () => {
      const customer = await insertCustomer(true);
      await client.query(
        `UPDATE "customer" SET "full_name" = 'Renamed', "phone" = "phone", "tax_id" = E'\\t ' || "tax_id" || E' \\n'
          WHERE "uuid" = $1`,
        [customer.uuid]
      );
      expect(await stored(customer.uuid)).toMatchObject({ is_wholesale_approved: true, wholesale_approved_by: 7 });
      const { rows } = await client.query(
        `SELECT wholesale_contact_value(E'\\t 80012344-1 \\r\\n') AS "padded",
                wholesale_contact_value(E' \\t ') AS "blank", wholesale_contact_value('a b') AS "inner"`
      );
      expect(rows[0]).toEqual({ padded: '80012344-1', blank: null, inner: 'a b' });
    });

    it('does not apply to pending or retail customers', async () => {
      for (const customer of [await insertCustomer(false), await insertCustomer(false, false)]) {
        await client.query('UPDATE "customer" SET "phone" = $2, "tax_id" = $3 WHERE "uuid" = $1', [
          customer.uuid,
          '+595982000111',
          uniqueRuc()
        ]);
        expect(await stored(customer.uuid)).toMatchObject({ phone: '+595982000111', is_wholesale_approved: false });
      }
    });
  });

  describe('rule 2: approval columns change only through the flagged audited path', () => {
    it.each([
      ['is_wholesale_approved', true],
      ['wholesale_approved_at', new Date()],
      ['wholesale_approved_by', 1],
      ['wholesale_requested_at', null]
    ])('rejects an UPDATE of %s without the flag', async (column, value) => {
      const customer = await insertCustomer(false);
      const error = await expectFailure(`UPDATE "customer" SET "${column}" = $2 WHERE "uuid" = $1`, [
        customer.uuid,
        value
      ]);
      expect([column, error.code]).toEqual([column, 'WH002']);
      expect(error.message).toMatch(/^WHOLESALE_APPROVAL_PROTECTED/);
    });

    it('rejects an INSERT that carries an approval without the flag', async () => {
      for (const [column, value] of [
        ['is_wholesale_approved', true],
        ['wholesale_approved_at', new Date()],
        ['wholesale_approved_by', 1]
      ] as const) {
        const error = await expectFailure(
          `INSERT INTO "customer" ("email", "password", "${column}") VALUES ($1, 'x', $2)`,
          [`wholesale-w4c-${randomUUID()}@example.com`, value]
        );
        expect([column, error.code]).toEqual([column, 'WH002']);
      }
    });

    it('accepts a registration insert with wholesale_requested_at and an unapproved state', async () => {
      const { rows } = await client.query(
        `INSERT INTO "customer" ("email", "password", "tax_id", "phone", "wholesale_requested_at",
                                 "is_wholesale_approved")
         VALUES ($1, 'x', $2, '+595981123456', $3, false) RETURNING "is_wholesale_approved", "wholesale_requested_at"`,
        [`wholesale-w4c-${randomUUID()}@example.com`, uniqueRuc(), new Date().toISOString()]
      );
      expect(rows[0]).toEqual({ is_wholesale_approved: false, wholesale_requested_at: expect.any(Date) });
    });

    it('approve and revoke through setCustomerApproval pass and leave the flag disarmed', async () => {
      const customer = await insertCustomer(false);
      const approve = await setCustomerApproval(client as never, {
        customerUuid: customer.uuid as string,
        approved: true,
        actor: ADMIN
      });
      expect(approve.changed).toBe(true);
      expect(await flag()).toBe('off');
      expect(await stored(customer.uuid)).toMatchObject({ is_wholesale_approved: true, wholesale_approved_by: 7 });

      const revoke = await setCustomerApproval(client as never, {
        customerUuid: customer.uuid as string,
        approved: false,
        actor: ADMIN
      });
      expect(revoke.changed).toBe(true);
      expect(await flag()).toBe('off');
      expect(await stored(customer.uuid)).toMatchObject({ is_wholesale_approved: false, wholesale_approved_by: null });
    });
  });

  it('race: the admin PATCH write after a committed approval is rejected (R3-guard-read-write-race)', async () => {
    const customer = await insertCustomer(false);
    const body: Row = { phone: '+595 982 000 111', full_name: 'Edited by admin' };

    // 1. The W4b guard reads the customer while it is still pending: it lets the change through.
    await guardAdminCustomerUpdate(customer.uuid as string, body, client);
    expect(body).toEqual({ phone: '+595982000111', full_name: 'Edited by admin' });

    // 2. Another admin approves the customer through the audited endpoint.
    await setCustomerApproval(client as never, { customerUuid: customer.uuid as string, approved: true, actor: ADMIN });

    // 3. Core PATCH writes the body as `update('customer').given({...body, group_id: 1})`.
    const error = await expectRejection(() =>
      update('customer')
        .given({ ...body, group_id: 1 })
        .where('uuid', '=', customer.uuid)
        .execute(client as never)
    );
    expect(error.code).toBe('WH001');
    expect(error.message).toMatch(/WHOLESALE_REVOKE_REQUIRED/);
    expect(await stored(customer.uuid)).toMatchObject({ phone: '+595981123456', is_wholesale_approved: true });
  });
});

describeDb('wholesale.approval_write does not leak between transactions', () => {
  let pool: pg.Pool;

  beforeAll(() => {
    pool = new pg.Pool(poolConfig());
  });

  afterAll(async () => {
    await pool?.end();
  });

  const read = async (connection: pg.PoolClient) =>
    (await connection.query(`SELECT current_setting($1, true) AS "value"`, [APPROVAL_WRITE_SETTING])).rows[0]
      .value as string | null;

  it.each(['COMMIT', 'ROLLBACK'])('a flag armed in a transaction ended by %s is gone for the next one', async (end) => {
    const first = await pool.connect();
    const pid = (await first.query('SELECT pg_backend_pid() AS pid')).rows[0].pid as number;
    await first.query('BEGIN');
    await armApprovalWrite(first);
    expect(await read(first)).toBe('on');
    await first.query(end);
    first.release();

    // max: 1, so the pool hands out the same physical connection again.
    const second = await pool.connect();
    try {
      expect((await second.query('SELECT pg_backend_pid() AS pid')).rows[0].pid).toBe(pid);
      expect(await read(second)).not.toBe('on');
      await second.query('BEGIN');
      expect(await read(second)).not.toBe('on');
      await second.query('ROLLBACK');
    } finally {
      second.release();
    }
  });

  it('arming outside a transaction block lasts only for its own statement', async () => {
    const connection = await pool.connect();
    try {
      await armApprovalWrite(connection);
      expect(await read(connection)).not.toBe('on');
    } finally {
      connection.release();
    }
  });
});
