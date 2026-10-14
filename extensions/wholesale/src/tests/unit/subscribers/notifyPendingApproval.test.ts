/**
 * T-2.4b: the `customer_registered` subscriber creates an admin notification
 * "wholesale customer pending approval" (CU-00 step 4), only for accounts
 * registered as wholesale (`wholesale_requested_at` set).
 *
 * The subscriber receives the event data as core stores it (JSON of the
 * inserted customer row) and writes `wholesale_notification` (migration
 * 1.1.0) through the connection it is given: here the rolled-back fixture
 * transaction.
 */
import { randomUUID } from 'crypto';
import migrate110 from '../../../migration/Version-1.1.0.js';
import notifyPendingApproval from '../../../subscribers/customer_registered/notifyPendingApproval.js';
import { describeDb, openFixtures, type Fixtures } from '../graphql/storefrontSchema.js';

describeDb('customer_registered -> notifyPendingApproval (T-2.4b)', () => {
  let fixtures: Fixtures;

  beforeAll(async () => {
    fixtures = await openFixtures();
    await migrate110(fixtures.client);
  });

  afterAll(async () => {
    await fixtures?.close();
  });

  async function notificationsFor(uuid: string): Promise<Record<string, unknown>[]> {
    const { rows } = await fixtures.client.query(
      `SELECT "type", "severity", "title", "body", "entity_type", "entity_uuid", "read_at"
         FROM "wholesale_notification" WHERE "entity_uuid" = $1`,
      [uuid]
    );
    return rows as Record<string, unknown>[];
  }

  /** The event payload as delivered: the customer row through JSON. */
  const eventData = (row: Record<string, unknown>) => JSON.parse(JSON.stringify(row)) as Record<string, unknown>;

  it('creates one unread customer_pending_approval notification for a wholesale registration', async () => {
    const uuid = randomUUID();
    await notifyPendingApproval(
      eventData({
        customer_id: 1,
        uuid,
        email: 'b2b@example.com',
        full_name: 'Buyer',
        business_name: 'FERRETERIA Y CONSTRUCCIONES CENTRAL S.A.',
        tax_id: '80012344-1',
        is_wholesale_approved: false,
        wholesale_requested_at: new Date()
      }),
      fixtures.client
    );

    const rows = await notificationsFor(uuid);
    expect(rows).toEqual([
      {
        type: 'customer_pending_approval',
        severity: 'info',
        title: 'Wholesale customer pending approval',
        body: 'FERRETERIA Y CONSTRUCCIONES CENTRAL S.A. (RUC 80012344-1)',
        entity_type: 'customer',
        entity_uuid: uuid,
        read_at: null
      }
    ]);
  });

  it.each([
    ['null', null],
    ['missing', undefined]
  ])('does nothing for a retail registration (wholesale_requested_at %s)', async (_label, requestedAt) => {
    const uuid = randomUUID();
    const row: Record<string, unknown> = { customer_id: 2, uuid, email: 'b2c@example.com', full_name: 'Retail' };
    if (requestedAt !== undefined) row.wholesale_requested_at = requestedAt;
    await notifyPendingApproval(eventData(row), fixtures.client);
    expect(await notificationsFor(uuid)).toEqual([]);
  });
});
