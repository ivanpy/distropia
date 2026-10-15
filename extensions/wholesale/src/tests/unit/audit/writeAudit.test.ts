/**
 * T-2.39 (ADR-11, RNF-12, data model §7.5): `writeAudit` appends one
 * `wholesale_audit_log` row through the caller's connection, inside the
 * caller's transaction, with a snapshot of the acting admin's e-mail.
 *
 * Everything runs inside the rolled-back fixture transaction (migrations
 * 1.0.0 + 1.1.0 applied in it): audit rows are append-only and could never
 * be deleted from a real database.
 */
import { randomUUID } from 'crypto';
import type { PoolClient } from 'pg';
import migrate110 from '../../../migration/Version-1.1.0.js';
import { writeAudit } from '../../../services/audit/writeAudit.js';
import { describeDb, openFixtures, type Fixtures } from '../graphql/storefrontSchema.js';

const ADMIN = { type: 'admin', adminUserId: 7, email: 'manager@example.com' } as const;

describe('writeAudit outside a transaction', () => {
  it('refuses a connection that is not inside a transaction and writes nothing', async () => {
    const calls: unknown[] = [];
    const connection = {
      query: async (...args: unknown[]) => {
        calls.push(args);
        return { rows: [{ uuid: 'x' }] };
      }
    } as unknown as PoolClient;
    await expect(
      writeAudit(connection, { actor: ADMIN, action: 'customer.approve', entityType: 'customer' })
    ).rejects.toThrow(/transaction/);
    expect(calls).toEqual([]);
  });
});

describeDb('writeAudit (T-2.39)', () => {
  let fixtures: Fixtures;

  beforeAll(async () => {
    fixtures = await openFixtures();
    await migrate110(fixtures.client);
  }, 30000);

  afterAll(async () => {
    await fixtures?.close();
  });

  async function auditRows(entityUuid: string): Promise<Record<string, unknown>[]> {
    const { rows } = await fixtures.client.query(
      `SELECT "actor_type", "admin_user_id", "admin_email", "action", "entity_type", "entity_uuid",
              "before", "after", "reason"
         FROM "wholesale_audit_log" WHERE "entity_uuid" = $1`,
      [entityUuid]
    );
    return rows as Record<string, unknown>[];
  }

  it('appends a row with the admin e-mail snapshot, before/after and reason', async () => {
    const entityUuid = randomUUID();
    const uuid = await writeAudit(fixtures.client, {
      actor: ADMIN,
      action: 'customer.approve',
      entityType: 'customer',
      entityUuid,
      before: { is_wholesale_approved: false },
      after: { is_wholesale_approved: true },
      reason: 'Documents checked'
    });

    expect(uuid).toMatch(/^[0-9a-f-]{36}$/);
    expect(await auditRows(entityUuid)).toEqual([
      {
        actor_type: 'admin',
        admin_user_id: 7,
        admin_email: 'manager@example.com',
        action: 'customer.approve',
        entity_type: 'customer',
        entity_uuid: entityUuid,
        before: { is_wholesale_approved: false },
        after: { is_wholesale_approved: true },
        reason: 'Documents checked'
      }
    ]);
  });

  it('a system actor stores no admin id or e-mail', async () => {
    const entityUuid = randomUUID();
    await writeAudit(fixtures.client, {
      actor: { type: 'system' },
      action: 'customer.revoke',
      entityType: 'customer',
      entityUuid
    });
    expect(await auditRows(entityUuid)).toEqual([
      expect.objectContaining({
        actor_type: 'system',
        admin_user_id: null,
        admin_email: null,
        before: null,
        after: null,
        reason: null
      })
    ]);
  });

  it('when the audit insert fails, the audited change is rolled back with it', async () => {
    const customer = await fixtures.insertCustomer(false);
    await fixtures.client.query('SAVEPOINT audit_failure');

    // The audited change and its audit row share the transaction.
    await fixtures.client.query('UPDATE "customer" SET "is_wholesale_approved" = true WHERE "uuid" = $1', [
      customer.uuid
    ]);
    await expect(
      writeAudit(fixtures.client, {
        actor: ADMIN,
        action: 'customer.approve',
        entityType: 'customer',
        // Not a UUID: the INSERT itself fails in PostgreSQL.
        entityUuid: 'not-a-uuid'
      })
    ).rejects.toThrow();

    // The caller rolls its transaction back on the audit error.
    await fixtures.client.query('ROLLBACK TO SAVEPOINT audit_failure');
    const { rows } = await fixtures.client.query(
      'SELECT "is_wholesale_approved" FROM "customer" WHERE "uuid" = $1',
      [customer.uuid]
    );
    expect(rows[0].is_wholesale_approved).toBe(false);
  });
});
