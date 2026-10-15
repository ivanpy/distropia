import type { PoolClient } from 'pg';
import { type AdminAuditActor, writeAudit } from '../audit/writeAudit.js';

/**
 * Admin approval and revocation of a wholesale customer (CU-00 steps 5-6,
 * RF-21, `POST /api/wholesale/customers/:id/approval`).
 *
 * Does not go through core `updateCustomer` (`01_arquitectura_evershop.md`
 * §4): it writes the approval columns with its own UPDATE, on the caller's
 * transaction connection, together with the credit row and the audit row.
 */

export type ApprovalErrorCode = 'CUSTOMER_NOT_FOUND' | 'CUSTOMER_NOT_WHOLESALE';

export class ApprovalError extends Error {
  readonly code: ApprovalErrorCode;

  readonly status: number;

  constructor(code: ApprovalErrorCode, status: number, message: string) {
    super(message);
    this.name = 'ApprovalError';
    this.code = code;
    this.status = status;
  }
}

export const isApprovalError = (e: unknown): e is ApprovalError => e instanceof ApprovalError;

export interface ApprovalInput {
  /** Public uuid of the customer. */
  customerUuid: string;
  approved: boolean;
  actor: AdminAuditActor;
}

export interface ApprovalResult {
  uuid: string;
  approved: boolean;
  /** ISO timestamp of the current approval, `null` when not approved. */
  approvedAt: string | null;
  /** `false` when the customer already was in the requested state (nothing written). */
  changed: boolean;
}

interface ApprovalState {
  is_wholesale_approved: boolean;
  wholesale_approved_at: string | null;
  wholesale_approved_by: number | null;
}

interface CustomerApprovalRow {
  customer_id: number;
  uuid: string;
  is_wholesale_approved: boolean;
  wholesale_approved_at: Date | null;
  wholesale_approved_by: number | null;
  wholesale_requested_at: Date | null;
}

export const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const stateOf = (row: Pick<CustomerApprovalRow, 'is_wholesale_approved' | 'wholesale_approved_at' | 'wholesale_approved_by'>): ApprovalState => ({
  is_wholesale_approved: row.is_wholesale_approved === true,
  wholesale_approved_at: row.wholesale_approved_at ? row.wholesale_approved_at.toISOString() : null,
  wholesale_approved_by: row.wholesale_approved_by
});

const notFound = () => new ApprovalError('CUSTOMER_NOT_FOUND', 404, 'Customer not found');

/**
 * Approves (`approved: true`) or revokes (`approved: false`) a customer.
 *
 * - Approve: only accounts registered as wholesale (`wholesale_requested_at`
 *   set; RUC validated at registration). Sets the approval columns, creates
 *   `wholesale_customer_credit` with the table defaults (0 / 30 days) unless
 *   it already exists (a re-approval keeps the terms a manager set) and
 *   audits `customer.approve`.
 * - Revoke: clears the approval columns (history stays in the audit log),
 *   keeps the credit row and audits `customer.revoke`.
 * - A request for the current state writes nothing (`changed: false`).
 *
 * The customer row is locked (`FOR UPDATE`) so concurrent requests serialize.
 */
export async function setCustomerApproval(connection: PoolClient, input: ApprovalInput): Promise<ApprovalResult> {
  if ((connection as PoolClient & { INTRANSACTION?: boolean }).INTRANSACTION !== true) {
    throw new Error('setCustomerApproval must run on the connection of an open transaction');
  }
  if (!UUID_PATTERN.test(input.customerUuid)) {
    throw notFound();
  }

  const { rows } = await connection.query<CustomerApprovalRow>(
    `SELECT "customer_id", "uuid", "is_wholesale_approved", "wholesale_approved_at",
            "wholesale_approved_by", "wholesale_requested_at"
       FROM "customer" WHERE "uuid" = $1 FOR UPDATE`,
    [input.customerUuid]
  );
  const customer = rows[0];
  if (!customer) {
    throw notFound();
  }
  const before = stateOf(customer);

  if (input.approved) {
    if (customer.wholesale_requested_at === null) {
      throw new ApprovalError('CUSTOMER_NOT_WHOLESALE', 422, 'Customer did not register as a wholesale customer');
    }
  }

  if (before.is_wholesale_approved === input.approved) {
    return { uuid: customer.uuid, approved: input.approved, approvedAt: before.wholesale_approved_at, changed: false };
  }

  if (input.approved) {
    // A re-approval after a revocation keeps the existing row and its terms.
    await connection.query(
      `INSERT INTO "wholesale_customer_credit" ("customer_id", "updated_by") VALUES ($1, $2)
       ON CONFLICT ("customer_id") DO NOTHING`,
      [customer.customer_id, input.actor.adminUserId]
    );
  }

  const { rows: updated } = await connection.query<CustomerApprovalRow>(
    input.approved
      ? `UPDATE "customer"
            SET "is_wholesale_approved" = true, "wholesale_approved_at" = CURRENT_TIMESTAMP,
                "wholesale_approved_by" = $2
          WHERE "customer_id" = $1
          RETURNING "is_wholesale_approved", "wholesale_approved_at", "wholesale_approved_by"`
      : `UPDATE "customer"
            SET "is_wholesale_approved" = false, "wholesale_approved_at" = NULL, "wholesale_approved_by" = NULL
          WHERE "customer_id" = $1
          RETURNING "is_wholesale_approved", "wholesale_approved_at", "wholesale_approved_by"`,
    input.approved ? [customer.customer_id, input.actor.adminUserId] : [customer.customer_id]
  );
  const after = stateOf(updated[0]);

  await writeAudit(connection, {
    actor: input.actor,
    action: input.approved ? 'customer.approve' : 'customer.revoke',
    entityType: 'customer',
    entityUuid: customer.uuid,
    before,
    after
  });

  return { uuid: customer.uuid, approved: input.approved, approvedAt: after.wholesale_approved_at, changed: true };
}
