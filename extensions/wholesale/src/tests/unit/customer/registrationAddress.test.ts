/**
 * T-2.4c (RF-19, CU-00 step 3, D-P2-6): a B2B registration through the core
 * `createCustomer` service creates its commercial/fiscal address as the
 * default `customer_address` row in the same transaction as the customer.
 *
 * The core service runs end to end on its own pooled connection (it commits),
 * so a probe hook registered after the extension hooks snapshots the rows
 * through the transaction connection and then throws: the registration is
 * rolled back and nothing is left in the database. `afterAll` also deletes
 * any row with the test e-mail prefix in case a probe did not run.
 */
import path from 'path';
import {
  normalizeRegistrationAddress,
  takeRegistrationAddress
} from '../../../services/customer/registrationAddress.js';
import { describeDb } from '../graphql/storefrontSchema.js';

const CORE_DIST = path.resolve(process.cwd(), 'packages/evershop/dist');
const EXTENSION_DIST = path.resolve(process.cwd(), 'extensions/wholesale/dist');
const EMAIL_PREFIX = 'wholesale-t24c-';

type Row = Record<string, unknown>;
type Queryable = { query: (sql: string, params?: unknown[]) => Promise<{ rows: Row[] }> };
type CorePool = Queryable & { end: () => Promise<void> };
type CreateCustomer = (data: Row, context?: Row) => Promise<Row>;
type HookAfter = (name: string, callback: (...args: unknown[]) => unknown, priority?: number) => void;

const ADDRESS = {
  full_name: 'Ferreteria Central',
  telephone: '+595981123456',
  address_1: 'Av. Mcal. Lopez 1234',
  address_2: 'Piso 2',
  city: 'Asuncion',
  province: 'PY-ASU',
  country: 'PY',
  postcode: '1209'
};

class ProbeStop extends Error {}

const codeOfSync = (fn: () => unknown): unknown => {
  try {
    fn();
  } catch (e) {
    return (e as { code?: unknown }).code;
  }
  return undefined;
};

describe('normalizeRegistrationAddress', () => {
  it('keeps only the address columns, trimmed; a numeric telephone becomes a string', () => {
    expect(
      normalizeRegistrationAddress({ ...ADDRESS, city: ' Asuncion ', telephone: 595981, customer_id: 7, uuid: 'u', is_default: 0 })
    ).toEqual({ ...ADDRESS, city: 'Asuncion', telephone: '595981' });
  });

  it.each([undefined, null])('%p -> WHOLESALE_ADDRESS_REQUIRED', (raw) => {
    expect(codeOfSync(() => normalizeRegistrationAddress(raw))).toBe('WHOLESALE_ADDRESS_REQUIRED');
  });

  it.each([
    ['a string', 'Av. Mcal. Lopez 1234'],
    ['an array', [ADDRESS]],
    ['a non-string field', { ...ADDRESS, city: { name: 'Asuncion' } }],
    ['a blank required field', { ...ADDRESS, full_name: '   ' }],
    ['a missing required field', { ...ADDRESS, country: undefined }]
  ])('%s -> WHOLESALE_ADDRESS_INVALID', (_label, raw) => {
    expect(codeOfSync(() => normalizeRegistrationAddress(raw))).toBe('WHOLESALE_ADDRESS_INVALID');
  });
});

describe('takeRegistrationAddress', () => {
  it('removes address from B2C customer data without validating it', () => {
    const data: Row = { email: 'x@example.com', address: 'not an address' };
    takeRegistrationAddress(data);
    expect(data).toEqual({ email: 'x@example.com' });
  });

  it('removes address from B2B customer data and refuses a missing one', () => {
    const data: Row = { email: 'x@example.com', wholesale_requested_at: '2026-10-14T00:00:00Z', address: ADDRESS };
    takeRegistrationAddress(data);
    expect(data).not.toHaveProperty('address');
    expect(codeOfSync(() => takeRegistrationAddress({ wholesale_requested_at: '2026-10-14T00:00:00Z' }))).toBe(
      'WHOLESALE_ADDRESS_REQUIRED'
    );
  });
});

type Snapshot = { customer: Row; addresses: Row[] };

describeDb('B2B registration address (T-2.4c)', () => {
  let createCustomer: CreateCustomer;
  let pool: CorePool;
  let snapshot: Snapshot | null;

  beforeAll(async () => {
    ({ default: createCustomer } = (await import(
      path.join(CORE_DIST, 'modules/customer/services/customer/createCustomer.js')
    )) as { default: CreateCustomer });
    ({ pool } = (await import(path.join(CORE_DIST, 'lib/postgres/connection.js'))) as { pool: CorePool });
    const { hookAfter } = (await import(path.join(CORE_DIST, 'lib/util/hookable.js'))) as {
      hookAfter: HookAfter;
    };
    const bootstrap = (
      (await import(path.join(EXTENSION_DIST, 'bootstrap.js'))) as { default: (c?: Row) => void }
    ).default;
    bootstrap({ command: 'test' });

    // Probe: runs after every extension hook, inside the core transaction.
    hookAfter(
      'insertCustomerData',
      async function probe(...args: unknown[]) {
        const [customer, , connection] = args as [Row, Row, Queryable];
        const { rows } = await connection.query(
          'SELECT * FROM "customer_address" WHERE "customer_id" = $1 ORDER BY "customer_address_id"',
          [customer.customer_id]
        );
        const { rows: stored } = await connection.query('SELECT * FROM "customer" WHERE "customer_id" = $1', [
          customer.customer_id
        ]);
        snapshot = { customer: stored[0], addresses: rows };
        throw new ProbeStop('probe: roll the registration back');
      },
      1000
    );
  });

  beforeEach(() => {
    snapshot = null;
  });

  afterAll(async () => {
    if (pool) {
      await pool.query('DELETE FROM "customer" WHERE "email" LIKE $1', [`${EMAIL_PREFIX}%`]);
      await pool.end();
    }
  });

  const email = (label: string) => `${EMAIL_PREFIX}${label}-${Date.now()}@example.com`;

  const b2b = (label: string, extra: Row = {}): Row => ({
    email: email(label),
    password: 'Passw0rd!',
    full_name: 'Buyer',
    tax_id: '80012344-1',
    business_name: 'Typed',
    phone: '+595 981 123 456',
    ...extra
  });

  async function codeOf(promise: Promise<unknown>): Promise<unknown> {
    try {
      await promise;
    } catch (e) {
      if (e instanceof ProbeStop) return 'PROBE';
      return (e as { code?: unknown }).code ?? (e as Error).message;
    }
    return 'COMMITTED';
  }

  async function countByEmail(value: unknown): Promise<number> {
    const { rows } = await pool.query('SELECT COUNT(*)::int AS n FROM "customer" WHERE "email" = $1', [value]);
    return rows[0].n as number;
  }

  it('B2B with a valid address: customer and default address in one transaction', async () => {
    const data = b2b('valid', { address: { ...ADDRESS, is_default: 0, customer_id: 1, uuid: 'x' } });
    expect(await codeOf(createCustomer(data))).toBe('PROBE');

    expect(snapshot).not.toBeNull();
    const { customer, addresses } = snapshot as Snapshot;
    expect(customer).not.toHaveProperty('address');
    expect(addresses).toHaveLength(1);
    expect(addresses[0]).toMatchObject({ ...ADDRESS, customer_id: customer.customer_id, is_default: true });
    expect(addresses[0].uuid).not.toBe('x');
    // The probe threw: the core transaction rolled back both rows.
    expect(await countByEmail(data.email)).toBe(0);
  });

  it('B2B without address is refused with WHOLESALE_ADDRESS_REQUIRED and leaves no row', async () => {
    const data = b2b('missing');
    expect(await codeOf(createCustomer(data))).toBe('WHOLESALE_ADDRESS_REQUIRED');
    expect(snapshot).toBeNull();
    expect(await countByEmail(data.email)).toBe(0);
  });

  it('B2B with an incomplete address is refused with WHOLESALE_ADDRESS_INVALID and leaves no row', async () => {
    const data = b2b('incomplete', { address: { ...ADDRESS, address_1: '  ', postcode: undefined } });
    expect(await codeOf(createCustomer(data))).toBe('WHOLESALE_ADDRESS_INVALID');
    expect(snapshot).toBeNull();
    expect(await countByEmail(data.email)).toBe(0);
  });

  it('B2C without address is unchanged: no address row', async () => {
    const data = { email: email('b2c'), password: 'Passw0rd!', full_name: 'Retail' };
    expect(await codeOf(createCustomer(data))).toBe('PROBE');
    expect((snapshot as Snapshot).addresses).toEqual([]);
    expect(await countByEmail(data.email)).toBe(0);
  });

  it('B2C with an address: ignored, no address row', async () => {
    const data = { email: email('b2c-address'), password: 'Passw0rd!', full_name: 'Retail', address: ADDRESS };
    expect(await codeOf(createCustomer(data))).toBe('PROBE');
    expect((snapshot as Snapshot).addresses).toEqual([]);
    expect((snapshot as Snapshot).customer).not.toHaveProperty('address');
  });
});
