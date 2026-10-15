import type { PoolClient } from 'pg';

/**
 * Append-only audit log (`wholesale_audit_log`, migration 1.1.0; data model
 * §7.5, ADR-11, RNF-12).
 *
 * The row is written through the caller's connection, inside the caller's
 * transaction: the change and its audit row commit or roll back together.
 * An audit failure throws, so the caller's `catch` rolls the change back.
 */

/** The admin who acted; `email` is stored as a snapshot (the log outlives users). */
export interface AdminAuditActor {
  type: 'admin';
  adminUserId: number;
  email: string;
}

/** A rule applied by the system (e.g. automatic revocation, RF-22) or by a customer action. */
export interface AnonymousAuditActor {
  type: 'system' | 'customer';
}

export type AuditActor = AdminAuditActor | AnonymousAuditActor;

export interface AuditEntry {
  actor: AuditActor;
  /** `<entity>.<verb>`, e.g. `customer.approve`, `credit.update`. */
  action: string;
  entityType: string;
  /** Public uuid of the audited entity, never a serial id. */
  entityUuid?: string | null;
  before?: unknown;
  after?: unknown;
  reason?: string | null;
}

const toJson = (value: unknown): string | null => (value === undefined || value === null ? null : JSON.stringify(value));

/**
 * Inserts one audit row and returns its uuid.
 *
 * `connection` must be a client inside a transaction (flagged
 * `INTRANSACTION` by `startTransaction` of the query builder): an audit row
 * written outside the transaction of its change could survive a rolled-back
 * change, or be lost while the change commits.
 */
export async function writeAudit(connection: PoolClient, entry: AuditEntry): Promise<string> {
  if ((connection as PoolClient & { INTRANSACTION?: boolean }).INTRANSACTION !== true) {
    throw new Error('writeAudit must run on the connection of an open transaction');
  }
  const admin = entry.actor.type === 'admin' ? entry.actor : null;
  const { rows } = await connection.query<{ uuid: string }>(
    `INSERT INTO "wholesale_audit_log"
       ("actor_type", "admin_user_id", "admin_email", "action", "entity_type", "entity_uuid",
        "before", "after", "reason")
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9)
     RETURNING "uuid"`,
    [
      entry.actor.type,
      admin?.adminUserId ?? null,
      admin?.email ?? null,
      entry.action,
      entry.entityType,
      entry.entityUuid ?? null,
      toJson(entry.before),
      toJson(entry.after),
      entry.reason ?? null
    ]
  );
  return rows[0].uuid;
}
