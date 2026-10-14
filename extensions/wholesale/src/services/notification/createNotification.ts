import { insert } from '@evershop/postgres-query-builder';
import type { Pool, PoolClient } from 'pg';

/**
 * Shared admin notification inbox (`wholesale_notification`, migration
 * 1.1.0; data model §7.9, G-9). The table leaves `type` open on purpose: the
 * list of types lives here.
 */
export const NOTIFICATION_TYPES = [
  'customer_pending_approval',
  'quote_awaiting_freight',
  'quote_accepted',
  'quote_send_failed',
  'order_error',
  'order_expired',
  'sifen_rejected',
  'remission_note_rejected',
  'payment_voided'
] as const;

export type NotificationType = (typeof NOTIFICATION_TYPES)[number];

export type NotificationSeverity = 'info' | 'warning' | 'critical';

export interface NotificationInput {
  type: NotificationType;
  severity?: NotificationSeverity;
  title: string;
  body?: string | null;
  entityType?: string | null;
  /** Public uuid of the related entity, never a serial id. */
  entityUuid?: string | null;
}

/** Inserts one unread notification and returns its uuid. */
export async function createNotification(
  connection: Pool | PoolClient,
  input: NotificationInput
): Promise<string> {
  const row = (await insert('wholesale_notification')
    .given({
      type: input.type,
      severity: input.severity ?? 'info',
      title: input.title,
      body: input.body ?? null,
      entity_type: input.entityType ?? null,
      entity_uuid: input.entityUuid ?? null
    })
    .execute(connection)) as { uuid: string };
  return row.uuid;
}
