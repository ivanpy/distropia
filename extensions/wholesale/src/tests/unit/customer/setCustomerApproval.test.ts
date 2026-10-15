/**
 * T-2.6 (CU-00 steps 5-6, RF-21): an admin approves or revokes a wholesale
 * customer. Approving sets `is_wholesale_approved`, `wholesale_approved_at`
 * and `wholesale_approved_by`, creates `wholesale_customer_credit` with the
 * defaults (0 / 30 days) when it does not exist, and audits
 * `customer.approve`; revoking clears the approval and audits
 * `customer.revoke`. A request that changes nothing writes nothing.
 *
 * The service runs on the caller's transaction connection: here the
 * rolled-back fixture transaction (migrations 1.0.0 + 1.1.0 applied in it).
 */
import { randomUUID } from 'crypto';
import fs from 'fs';
import path from 'path';
import type { PoolClient } from 'pg';
import type { EvershopRequest } from '@evershop/evershop/types/request';
import type { EvershopResponse } from '@evershop/evershop/types/response';
import approveCustomer from '../../../api/approveCustomer/approveCustomer.js';
import migrate110 from '../../../migration/Version-1.1.0.js';
import { setCustomerApproval } from '../../../services/customer/setCustomerApproval.js';
import { describeDb, openFixtures, type Fixtures } from '../graphql/storefrontSchema.js';

const EXTENSION_API = path.resolve(process.cwd(), 'extensions/wholesale/dist/api');
const ADMIN = { type: 'admin', adminUserId: 7, email: 'manager@example.com' } as const;

type Row = Record<string, unknown>;

async function codeOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (e) {
    return (e as { code?: unknown }).code ?? (e as Error).message;
  }
  return 'RESOLVED';
}

describe('approveCustomer route', () => {
  it('declares a private POST /wholesale/customers/:id/approval', () => {
    const file = path.join(EXTENSION_API, 'approveCustomer', 'route.json');
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({
      methods: ['POST'],
      path: '/wholesale/customers/:id/approval',
      access: 'private'
    });
  });

  it('accepts only { approved: boolean }', () => {
    const file = path.join(EXTENSION_API, 'approveCustomer', 'payloadSchema.json');
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({
      type: 'object',
      properties: { approved: { type: 'boolean' } },
      required: ['approved'],
      additionalProperties: false
    });
  });

  it('answers 404 CUSTOMER_NOT_FOUND for an id that is not a uuid, before any database work', async () => {
    const captured: { status?: number; body?: unknown; next: unknown[] } = { next: [] };
    const response = {
      status(code: number) {
        captured.status = code;
        return response;
      },
      json(body: unknown) {
        captured.body = body;
        return response;
      }
    };
    await approveCustomer(
      {
        params: { id: '42' },
        body: { approved: true },
        getCurrentUser: () => ({ admin_user_id: 7, email: 'manager@example.com' })
      } as unknown as EvershopRequest,
      response as unknown as EvershopResponse,
      (err?: unknown) => {
        captured.next.push(err);
      }
    );
    expect(captured.status).toBe(404);
    expect(captured.body).toEqual({
      error: { status: 404, code: 'CUSTOMER_NOT_FOUND', message: 'Customer not found' }
    });
    expect(captured.next).toEqual([]);
  });
});

describe('setCustomerApproval outside a transaction', () => {
  it('refuses to run and queries nothing', async () => {
    const calls: unknown[] = [];
    const connection = {
      query: async (...args: unknown[]) => {
        calls.push(args);
        return { rows: [] };
      }
    } as unknown as PoolClient;
    expect(
      await codeOf(setCustomerApproval(connection, { customerUuid: randomUUID(), approved: true, actor: ADMIN }))
    ).toMatch(/transaction/);
    expect(calls).toEqual([]);
  });
});

describeDb('setCustomerApproval (T-2.6)', () => {
  let fixtures: Fixtures;

  beforeAll(async () => {
    fixtures = await openFixtures();
    await migrate110(fixtures.client);
  }, 30000);

  afterAll(async () => {
    await fixtures?.close();
  });

  async function insertCustomer(fields: Row = {}): Promise<Row> {
    const { rows } = await fixtures.client.query(
      `INSERT INTO "customer" ("email", "password", "full_name", "business_name", "tax_id", "phone",
                               "wholesale_requested_at", "is_wholesale_approved")
       VALUES ($1, 'x', 'Buyer', 'FERRETERIA CENTRAL S.A.', $2, '+595981123456', $3, $4) RETURNING *`,
      [
        `wholesale-t26-${randomUUID()}@example.com`,
        fields.tax_id ?? null,
        'wholesale_requested_at' in fields ? fields.wholesale_requested_at : new Date(),
        fields.is_wholesale_approved ?? false
      ]
    );
    return rows[0] as Row;
  }

  async function customerRow(uuid: unknown): Promise<Row> {
    const { rows } = await fixtures.client.query(
      `SELECT "is_wholesale_approved", "wholesale_approved_at", "wholesale_approved_by"
         FROM "customer" WHERE "uuid" = $1`,
      [uuid]
    );
    return rows[0] as Row;
  }

  async function creditRows(customerId: unknown): Promise<Row[]> {
    const { rows } = await fixtures.client.query(
      `SELECT "credit_limit", "payment_term_days", "manual_block", "updated_by"
         FROM "wholesale_customer_credit" WHERE "customer_id" = $1`,
      [customerId]
    );
    return rows as Row[];
  }

  async function auditRows(uuid: unknown): Promise<Row[]> {
    const { rows } = await fixtures.client.query(
      `SELECT "actor_type", "admin_user_id", "admin_email", "action", "entity_type", "before", "after", "reason"
         FROM "wholesale_audit_log" WHERE "entity_uuid" = $1 ORDER BY "wholesale_audit_log_id"`,
      [uuid]
    );
    return rows as Row[];
  }

  it('approve: sets the approval, creates the default credit and audits customer.approve', async () => {
    const customer = await insertCustomer();
    const result = await setCustomerApproval(fixtures.client, {
      customerUuid: customer.uuid as string,
      approved: true,
      actor: ADMIN
    });

    const stored = await customerRow(customer.uuid);
    expect(stored.is_wholesale_approved).toBe(true);
    expect(stored.wholesale_approved_at).toBeInstanceOf(Date);
    expect(stored.wholesale_approved_by).toBe(7);
    expect(result).toEqual({
      uuid: customer.uuid,
      approved: true,
      approvedAt: (stored.wholesale_approved_at as Date).toISOString(),
      changed: true
    });

    expect(await creditRows(customer.customer_id)).toEqual([
      { credit_limit: '0.00', payment_term_days: 30, manual_block: false, updated_by: 7 }
    ]);
    expect(await auditRows(customer.uuid)).toEqual([
      {
        actor_type: 'admin',
        admin_user_id: 7,
        admin_email: 'manager@example.com',
        action: 'customer.approve',
        entity_type: 'customer',
        before: { is_wholesale_approved: false, wholesale_approved_at: null, wholesale_approved_by: null },
        after: {
          is_wholesale_approved: true,
          wholesale_approved_at: (stored.wholesale_approved_at as Date).toISOString(),
          wholesale_approved_by: 7
        },
        reason: null
      }
    ]);
  });

  it('approving an approved customer changes and audits nothing', async () => {
    const customer = await insertCustomer();
    await setCustomerApproval(fixtures.client, { customerUuid: customer.uuid as string, approved: true, actor: ADMIN });
    const before = await customerRow(customer.uuid);

    const result = await setCustomerApproval(fixtures.client, {
      customerUuid: customer.uuid as string,
      approved: true,
      actor: { ...ADMIN, adminUserId: 8 }
    });

    expect(result.changed).toBe(false);
    expect(await customerRow(customer.uuid)).toEqual(before);
    expect(await auditRows(customer.uuid)).toHaveLength(1);
  });

  it('revoke: clears the approval, keeps the credit row and audits customer.revoke', async () => {
    const customer = await insertCustomer();
    await setCustomerApproval(fixtures.client, { customerUuid: customer.uuid as string, approved: true, actor: ADMIN });

    const result = await setCustomerApproval(fixtures.client, {
      customerUuid: customer.uuid as string,
      approved: false,
      actor: ADMIN
    });

    expect(result).toEqual({ uuid: customer.uuid, approved: false, approvedAt: null, changed: true });
    expect(await customerRow(customer.uuid)).toEqual({
      is_wholesale_approved: false,
      wholesale_approved_at: null,
      wholesale_approved_by: null
    });
    expect(await creditRows(customer.customer_id)).toHaveLength(1);
    const audits = await auditRows(customer.uuid);
    expect(audits.map((a) => a.action)).toEqual(['customer.approve', 'customer.revoke']);
    expect(audits[1]).toMatchObject({
      actor_type: 'admin',
      admin_email: 'manager@example.com',
      before: expect.objectContaining({ is_wholesale_approved: true, wholesale_approved_by: 7 }),
      after: { is_wholesale_approved: false, wholesale_approved_at: null, wholesale_approved_by: null }
    });
  });

  it('revoking a customer that is not approved changes and audits nothing', async () => {
    const customer = await insertCustomer();
    const result = await setCustomerApproval(fixtures.client, {
      customerUuid: customer.uuid as string,
      approved: false,
      actor: ADMIN
    });
    expect(result.changed).toBe(false);
    expect(await auditRows(customer.uuid)).toEqual([]);
  });

  it('re-approving after a revoke keeps the credit terms a manager set', async () => {
    const customer = await insertCustomer();
    const input = { customerUuid: customer.uuid as string, actor: ADMIN };
    await setCustomerApproval(fixtures.client, { ...input, approved: true });
    await fixtures.client.query(
      'UPDATE "wholesale_customer_credit" SET "credit_limit" = 5000000, "payment_term_days" = 60 WHERE "customer_id" = $1',
      [customer.customer_id]
    );
    await setCustomerApproval(fixtures.client, { ...input, approved: false });
    await setCustomerApproval(fixtures.client, { ...input, approved: true });

    expect(await creditRows(customer.customer_id)).toEqual([
      expect.objectContaining({ credit_limit: '5000000.00', payment_term_days: 60 })
    ]);
    expect((await customerRow(customer.uuid)).is_wholesale_approved).toBe(true);
  });

  it('a retail account (no wholesale request) cannot be approved', async () => {
    const customer = await insertCustomer({ wholesale_requested_at: null });
    expect(
      await codeOf(
        setCustomerApproval(fixtures.client, { customerUuid: customer.uuid as string, approved: true, actor: ADMIN })
      )
    ).toBe('CUSTOMER_NOT_WHOLESALE');
    expect((await customerRow(customer.uuid)).is_wholesale_approved).toBe(false);
    expect(await creditRows(customer.customer_id)).toEqual([]);
    expect(await auditRows(customer.uuid)).toEqual([]);
  });

  it('an unknown customer uuid is CUSTOMER_NOT_FOUND', async () => {
    expect(
      await codeOf(setCustomerApproval(fixtures.client, { customerUuid: randomUUID(), approved: true, actor: ADMIN }))
    ).toBe('CUSTOMER_NOT_FOUND');
  });
});
