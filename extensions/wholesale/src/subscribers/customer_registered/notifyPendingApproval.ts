import { pool } from '@evershop/evershop/lib/postgres';
import type { Pool, PoolClient } from 'pg';
import { createNotification } from '../../services/notification/createNotification.js';

/**
 * `customer_registered` subscriber (CU-00 step 4, T-2.4b): a customer who
 * registered as wholesale (`wholesale_requested_at` set by the registration
 * processor) gets an admin notification "pending approval". Retail
 * registrations are ignored.
 *
 * Subscribers run in the event process after core committed the
 * registration; `data` is the inserted customer row, delivered as JSON.
 * `connection` is only passed by tests.
 */
export default async function notifyPendingApproval(
  data: Record<string, unknown>,
  connection: Pool | PoolClient = pool
): Promise<void> {
  if (data.wholesale_requested_at === null || data.wholesale_requested_at === undefined) {
    return;
  }
  const name = data.business_name ?? data.full_name;
  await createNotification(connection, {
    type: 'customer_pending_approval',
    severity: 'info',
    title: 'Wholesale customer pending approval',
    body: `${String(name)} (RUC ${String(data.tax_id)})`,
    entityType: 'customer',
    entityUuid: typeof data.uuid === 'string' ? data.uuid : null
  });
}
