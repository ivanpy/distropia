import type { Pool, PoolClient } from 'pg';

/**
 * R3-guard-read-write-race (W4c): migration 1.1.1 adds a `customer` trigger
 * that rejects every change of the approval columns unless this
 * transaction-local setting is `on`. Only the audited approval paths arm it:
 *
 * - `setCustomerApproval` (approve / revoke endpoint), around its UPDATE;
 * - `revokeApprovalOnContactChange` (core `updateCustomerData` before-hook)
 *   when it revokes, disarmed by `disarmApprovalWriteAfterUpdate` (after-hook)
 *   once core has written the row.
 *
 * `set_config(..., true)` is `SET LOCAL`: the value ends with the
 * transaction (COMMIT or ROLLBACK), so it never leaks to the next request
 * that reuses the pooled connection. Outside a transaction block it only
 * lasts for its own statement, i.e. it has no effect. Callers still disarm it
 * right after the protected write, so the rest of their transaction runs
 * without it.
 *
 * Operators: a manual approval change in SQL must run inside a transaction
 * that first executes `SELECT set_config('wholesale.approval_write', 'on', true)`,
 * and it is not audited — use the approval endpoint instead.
 */
export const APPROVAL_WRITE_SETTING = 'wholesale.approval_write';

/** SQLSTATE raised by the trigger: phone/tax_id change of an approved customer without revocation. */
export const REVOKE_REQUIRED_SQLSTATE = 'WH001';

/** SQLSTATE raised by the trigger: approval column written outside the audited paths. */
export const APPROVAL_PROTECTED_SQLSTATE = 'WH002';

type Queryable = Pick<Pool | PoolClient, 'query'>;

/** Allows approval column writes until the transaction ends or `disarmApprovalWrite`. */
export async function armApprovalWrite(connection: Queryable): Promise<void> {
  await connection.query(`SELECT set_config('${APPROVAL_WRITE_SETTING}', 'on', true)`);
}

/** Forbids approval column writes again for the rest of the transaction. */
export async function disarmApprovalWrite(connection: Queryable): Promise<void> {
  await connection.query(`SELECT set_config('${APPROVAL_WRITE_SETTING}', 'off', true)`);
}

/**
 * Runs `write` with approval writes allowed and disarms them afterwards. On a
 * failure the transaction is normally aborted (its rollback drops the
 * setting); disarming is still attempted for errors raised outside SQL.
 */
export async function withApprovalWrite<T>(connection: Queryable, write: () => Promise<T>): Promise<T> {
  await armApprovalWrite(connection);
  let result: T;
  try {
    result = await write();
  } catch (e) {
    await disarmApprovalWrite(connection).catch(() => undefined);
    throw e;
  }
  await disarmApprovalWrite(connection);
  return result;
}
