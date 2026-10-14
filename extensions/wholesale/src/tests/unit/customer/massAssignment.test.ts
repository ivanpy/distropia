/**
 * T-2.3 (A9, RF-20): a customer can never approve itself by mass assignment.
 *
 * Core registration (`createCustomer`) and profile edition (`updateCustomer`)
 * pass the request body through the `customerDataBeforeCreate` /
 * `customerDataBeforeUpdate` processors and then hand it whole to
 * `insert('customer').given(data)` / `update('customer').given(data)`, which
 * write every key matching a column. This test reproduces that path: the
 * processors registered by the extension bootstrap run through the core
 * registry, then the result is written with the core query builder inside a
 * rolled-back transaction.
 */
import path from 'path';
import { insert, select, update } from '@evershop/postgres-query-builder';
import { describeDb, openFixtures, type Fixtures } from '../graphql/storefrontSchema.js';

const CORE_DIST = path.resolve(process.cwd(), 'packages/evershop/dist');
const EXTENSION_DIST = path.resolve(process.cwd(), 'extensions/wholesale/dist');

type GetValue = (name: string, value: unknown, context?: Record<string, unknown>) => Promise<Record<string, unknown>>;

const SELF_APPROVAL = {
  is_wholesale_approved: true,
  wholesale_approved_at: '2026-01-01T00:00:00Z',
  wholesale_approved_by: 1
};

describeDb('mass assignment of wholesale approval (T-2.3)', () => {
  let fixtures: Fixtures;
  let getValue: GetValue;

  beforeAll(async () => {
    ({ getValue } = (await import(path.join(CORE_DIST, 'lib/util/registry.js'))) as { getValue: GetValue });
    const bootstrap = (
      (await import(path.join(EXTENSION_DIST, 'bootstrap.js'))) as { default: () => void }
    ).default;
    bootstrap();
    fixtures = await openFixtures();
  });

  afterAll(async () => {
    await fixtures?.close();
  });

  async function approvalOf(uuid: unknown): Promise<Record<string, unknown>> {
    return (await select('is_wholesale_approved', 'wholesale_approved_at', 'wholesale_approved_by')
      .from('customer')
      .where('uuid', '=', uuid)
      .load(fixtures.client)) as Record<string, unknown>;
  }

  it('registration with is_wholesale_approved: true stores an unapproved customer', async () => {
    const payload = {
      email: `wholesale-a9-${Date.now()}@example.com`,
      password: 'x',
      full_name: 'Mass Assignment',
      ...SELF_APPROVAL
    };
    const data = await getValue('customerDataBeforeCreate', payload, { routeId: 'createCustomer' });
    const row = (await insert('customer').given(data).execute(fixtures.client)) as Record<string, unknown>;

    expect(await approvalOf(row.uuid)).toEqual({
      is_wholesale_approved: false,
      wholesale_approved_at: null,
      wholesale_approved_by: null
    });
  });

  it('profile update with is_wholesale_approved: true leaves the customer unapproved', async () => {
    const customer = await fixtures.insertCustomer(false);
    const data = await getValue('customerDataBeforeUpdate', { full_name: 'Self Approved', ...SELF_APPROVAL });
    await update('customer').given(data).where('uuid', '=', customer.uuid).execute(fixtures.client);

    expect(await approvalOf(customer.uuid)).toEqual({
      is_wholesale_approved: false,
      wholesale_approved_at: null,
      wholesale_approved_by: null
    });
  });
});
