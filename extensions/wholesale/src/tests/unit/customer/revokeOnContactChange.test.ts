/**
 * T-2.8 (RF-22, threat A7): changing `phone` or `tax_id` of an approved
 * wholesale customer revokes the approval until an admin reviews it, and
 * the automatic revocation is audited. A changed `tax_id` is validated
 * again with `checkTaxpayer` (closes advisory R3-update-taxid-unvalidated).
 *
 * The hook is called as core `updateCustomer` calls a `updateCustomerData`
 * before-hook: `(uuid, data, connection)`, mutating `data` before core writes
 * it. Here the connection is the rolled-back fixture transaction
 * (migrations 1.0.0 + 1.1.0 applied in it); runtime mode is development
 * (DNIT mock).
 */
import { randomUUID } from 'crypto';
import migrate110 from '../../../migration/Version-1.1.0.js';
import migrate111 from '../../../migration/Version-1.1.1.js';
import {
  APPROVAL_WRITE_SETTING,
  disarmApprovalWrite,
  withApprovalWrite
} from '../../../services/customer/approvalWriteFlag.js';
import { revokeApprovalOnContactChange } from '../../../services/customer/revokeOnContactChange.js';
import { rucCheckDigit } from '../../../services/taxpayer/rucCheckDigit.js';
import { describeDb, openFixtures, type Fixtures } from '../graphql/storefrontSchema.js';

type Row = Record<string, unknown>;

const APPROVED_AT = new Date('2026-10-01T12:00:00Z');

// Wholesale RUCs are unique (CUSTOMER_TAX_ID_WHOLESALE_UNIQUE): one valid,
// even (ACTIVE in the DNIT mock) base per customer of the test transaction.
let nextBase = 70000000;
function uniqueRuc(): string {
  nextBase += 2;
  const base = String(nextBase);
  return `${base}-${rucCheckDigit(base)}`;
}

describeDb('revokeApprovalOnContactChange (T-2.8)', () => {
  let fixtures: Fixtures;

  beforeAll(async () => {
    fixtures = await openFixtures();
    await migrate110(fixtures.client);
    await migrate111(fixtures.client);
  }, 30000);

  afterAll(async () => {
    await fixtures?.close();
  });

  async function insertCustomer(approved: boolean): Promise<Row> {
    // Migration 1.1.1: an approved fixture row needs the approval write flag.
    const { rows } = await withApprovalWrite(fixtures.client, () => fixtures.client.query(
      `INSERT INTO "customer" ("email", "password", "full_name", "business_name", "tax_id", "phone",
                               "wholesale_requested_at", "is_wholesale_approved", "wholesale_approved_at",
                               "wholesale_approved_by")
       VALUES ($1, 'x', 'Buyer', 'FERRETERIA Y CONSTRUCCIONES CENTRAL S.A.', $5, '+595981123456',
               CURRENT_TIMESTAMP, $2, $3, $4) RETURNING *`,
      [
        `wholesale-t28-${randomUUID()}@example.com`,
        approved,
        approved ? APPROVED_AT : null,
        approved ? 7 : null,
        uniqueRuc()
      ]
    ));
    return rows[0] as Row;
  }

  async function auditRows(uuid: unknown): Promise<Row[]> {
    const { rows } = await fixtures.client.query(
      `SELECT "actor_type", "admin_user_id", "admin_email", "action", "entity_type", "before", "after", "reason"
         FROM "wholesale_audit_log" WHERE "entity_uuid" = $1`,
      [uuid]
    );
    return rows as Row[];
  }

  /** Approval write flag left by the last `run` (core disarms it in the after-hook). */
  let armed: string | null = null;

  async function run(customer: Row, data: Row): Promise<Row> {
    await revokeApprovalOnContactChange(customer.uuid as string, data, fixtures.client);
    const { rows } = await fixtures.client.query(`SELECT current_setting($1, true) AS "value"`, [
      APPROVAL_WRITE_SETTING
    ]);
    armed = rows[0].value as string | null;
    await disarmApprovalWrite(fixtures.client);
    return data;
  }

  async function codeOf(promise: Promise<unknown>): Promise<unknown> {
    try {
      await promise;
    } catch (e) {
      return (e as { code?: unknown }).code ?? (e as Error).message;
    }
    return 'RESOLVED';
  }

  it('a phone change on an approved customer revokes the approval and audits it', async () => {
    const customer = await insertCustomer(true);
    const data = await run(customer, { phone: '+595 982 000 111' });

    expect(data).toEqual({
      phone: '+595982000111',
      is_wholesale_approved: false,
      wholesale_approved_at: null,
      wholesale_approved_by: null
    });
    expect(await auditRows(customer.uuid)).toEqual([
      {
        actor_type: 'system',
        admin_user_id: null,
        admin_email: null,
        action: 'customer.revoke',
        entity_type: 'customer',
        before: {
          is_wholesale_approved: true,
          wholesale_approved_at: APPROVED_AT.toISOString(),
          wholesale_approved_by: 7,
          phone: '+595981123456',
          tax_id: customer.tax_id
        },
        after: {
          is_wholesale_approved: false,
          wholesale_approved_at: null,
          wholesale_approved_by: null,
          phone: '+595982000111',
          tax_id: customer.tax_id
        },
        reason: 'Automatic revocation (RF-22): phone changed'
      }
    ]);
    // Migration 1.1.1: core writes the revocation with the approval write flag armed.
    expect(armed).toBe('on');
  });

  it('a tax_id change is validated again, normalized and revokes the approval', async () => {
    const customer = await insertCustomer(true);
    const data = await run(customer, { tax_id: ' 80.012.346-8 ', full_name: 'Buyer 2' });

    expect(data).toEqual({
      tax_id: '80012346-8',
      // Development/demo: the DNIT mock name follows the RUC, as at registration.
      business_name: 'CONSTRUCTORA DEMO DEL ESTE S.R.L.',
      full_name: 'Buyer 2',
      is_wholesale_approved: false,
      wholesale_approved_at: null,
      wholesale_approved_by: null
    });
    const audits = await auditRows(customer.uuid);
    expect(audits).toHaveLength(1);
    expect(audits[0].reason).toBe('Automatic revocation (RF-22): tax_id changed');
    expect(armed).toBe('on');
  });

  it.each([
    ['a bad check digit', '80012344-2', 'RUC_INVALID_CHECK_DIGIT'],
    ['a blocked taxpayer', '4445551-8', 'DNIT_401'],
    ['an empty RUC', '', 'RUC_INVALID_FORMAT']
  ])('a tax_id change to %s is refused before anything is written', async (_label, taxId, code) => {
    const customer = await insertCustomer(true);
    const data: Row = { tax_id: taxId };
    expect(await codeOf(revokeApprovalOnContactChange(customer.uuid as string, data, fixtures.client))).toBe(code);
    expect(data).toEqual({ tax_id: taxId });
    expect(await auditRows(customer.uuid)).toEqual([]);
  });

  it('the same phone and RUC typed differently are not a change', async () => {
    const customer = await insertCustomer(true);
    const data = await run(customer, { phone: '+595 (981) 123-456', tax_id: customer.tax_id });
    expect(data).toEqual({ phone: '+595981123456', tax_id: customer.tax_id });
    expect(await auditRows(customer.uuid)).toEqual([]);
    expect(armed).not.toBe('on');
  });

  it('a changed RUC with the same number in another format is normalized without revoking', async () => {
    const customer = await insertCustomer(true);
    const dotted = String(customer.tax_id).replace(/^(\d{2})(\d{3})(\d{3})/, '$1.$2.$3');
    const data = await run(customer, { tax_id: ` ${dotted} ` });
    expect(data.tax_id).toBe(customer.tax_id);
    expect(data).not.toHaveProperty('is_wholesale_approved');
    expect(await auditRows(customer.uuid)).toEqual([]);
  });

  it('a customer that is not approved keeps its state and nothing is audited', async () => {
    const customer = await insertCustomer(false);
    const data = await run(customer, { phone: '+595982000111' });
    expect(data).toEqual({ phone: '+595982000111' });
    expect(await auditRows(customer.uuid)).toEqual([]);
    expect(armed).not.toBe('on');
  });

  it('a change of other fields does not touch the approval', async () => {
    const customer = await insertCustomer(true);
    const data = await run(customer, { full_name: 'New name', email: 'other@example.com' });
    expect(data).toEqual({ full_name: 'New name', email: 'other@example.com' });
    expect(await auditRows(customer.uuid)).toEqual([]);
    expect(armed).not.toBe('on');
  });
});
