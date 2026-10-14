/**
 * T-2.4: `customerDataBeforeCreate` / `customerDataBeforeUpdate` processors
 * (`01_arquitectura_evershop.md` §4 "Guardia contra asignación masiva",
 * CU-00 step 3).
 *
 * - Both strip the approval fields; create forces `is_wholesale_approved = false`.
 * - A B2B registration (`tax_id` or `business_name` present) repeats the RUC
 *   check, stores the RUC with its check digit, sets `wholesale_requested_at`
 *   and, in development/demo, takes `business_name` from the DNIT mock.
 * - The update processor is shared with core address updates, so it only
 *   removes keys.
 */
import { insert } from '@evershop/postgres-query-builder';
import {
  normalizePhone,
  PROTECTED_CUSTOMER_FIELDS,
  sanitizeWholesaleOnCreate,
  sanitizeWholesaleOnUpdate
} from '../../../services/customer/sanitizeWholesaleFields.js';
import { TaxpayerError } from '../../../services/taxpayer/TaxpayerError.js';
import { describeDb, openFixtures, type Fixtures } from '../graphql/storefrontSchema.js';

const PROTECTED_VALUES = {
  is_wholesale_approved: true,
  wholesale_approved_at: '2026-01-01T00:00:00Z',
  wholesale_approved_by: 1,
  wholesale_requested_at: '2020-01-01T00:00:00Z'
};

const B2B = {
  email: 'b2b@example.com',
  password: 'x',
  full_name: 'Buyer',
  tax_id: ' 80.012.344-1 ',
  business_name: 'Typed by the customer',
  phone: '+595 981 123-456'
};

async function codeOf(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
  } catch (e) {
    expect(e).toBeInstanceOf(TaxpayerError);
    return (e as TaxpayerError).code;
  }
  return undefined;
}

let saved: Record<string, string | undefined>;

beforeEach(() => {
  saved = { NODE_ENV: process.env.NODE_ENV, WHOLESALE_DEMO_MODE: process.env.WHOLESALE_DEMO_MODE };
});

afterEach(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe('sanitizeWholesaleOnCreate', () => {
  it('lists the protected approval fields', () => {
    expect([...PROTECTED_CUSTOMER_FIELDS].sort()).toEqual(Object.keys(PROTECTED_VALUES).sort());
  });

  it('B2C registration: strips protected fields and forces false, nothing else', async () => {
    const input = { email: 'b2c@example.com', password: 'x', full_name: 'Retail', ...PROTECTED_VALUES };
    const clean = await sanitizeWholesaleOnCreate(input);
    expect(clean).toEqual({
      email: 'b2c@example.com',
      password: 'x',
      full_name: 'Retail',
      is_wholesale_approved: false
    });
    // The input object is not mutated.
    expect(input.is_wholesale_approved).toBe(true);
  });

  it('B2B registration in development: RUC with check digit, mock name, pending', async () => {
    const before = Date.now();
    const clean = await sanitizeWholesaleOnCreate({ ...B2B, ...PROTECTED_VALUES });
    expect(clean).toMatchObject({
      tax_id: '80012344-1',
      business_name: 'FERRETERIA Y CONSTRUCCIONES CENTRAL S.A.',
      phone: '+595981123456',
      is_wholesale_approved: false
    });
    expect(clean.wholesale_approved_at).toBeUndefined();
    expect(clean.wholesale_approved_by).toBeUndefined();
    // Server-set timestamp (ISO string: the query builder JSON-encodes objects).
    expect(typeof clean.wholesale_requested_at).toBe('string');
    expect(Date.parse(clean.wholesale_requested_at as string)).toBeGreaterThanOrEqual(before - 1000);
  });

  it('B2B registration in production keeps the typed business name', async () => {
    process.env.NODE_ENV = 'production';
    delete process.env.WHOLESALE_DEMO_MODE;
    const clean = await sanitizeWholesaleOnCreate({ ...B2B });
    expect(clean).toMatchObject({
      tax_id: '80012344-1',
      business_name: 'Typed by the customer',
      is_wholesale_approved: false
    });
  });

  it('B2B registration in demo takes the mock name', async () => {
    process.env.NODE_ENV = 'production';
    process.env.WHOLESALE_DEMO_MODE = 'true';
    const clean = await sanitizeWholesaleOnCreate({ ...B2B, tax_id: '80012346-8' });
    expect(clean.business_name).toBe('CONSTRUCTORA DEMO DEL ESTE S.R.L.');
  });

  it.each([
    [{ tax_id: '80012344-2' }, 'RUC_INVALID_CHECK_DIGIT'],
    [{ tax_id: '4445551-8' }, 'DNIT_401'],
    [{ tax_id: undefined }, 'RUC_INVALID_FORMAT'],
    [{ tax_id: 80012344 }, 'RUC_INVALID_FORMAT']
  ])('B2B registration with %p is refused with %s', async (override, code) => {
    expect(await codeOf(sanitizeWholesaleOnCreate({ ...B2B, ...override }))).toBe(code);
  });

  it('a business name without RUC is a B2B registration and is refused', async () => {
    expect(await codeOf(sanitizeWholesaleOnCreate({ email: 'x@example.com', business_name: 'ACME' }))).toBe(
      'RUC_INVALID_FORMAT'
    );
  });
});

describe('sanitizeWholesaleOnUpdate', () => {
  it('strips the protected fields and does not add any', () => {
    expect(sanitizeWholesaleOnUpdate({ full_name: 'New', ...PROTECTED_VALUES })).toEqual({ full_name: 'New' });
  });

  it('leaves an address payload untouched (shared with core address updates)', () => {
    const address = { full_name: 'A', telephone: '0981', address_1: 'Street 1', is_default: 1 };
    expect(sanitizeWholesaleOnUpdate(address)).toEqual(address);
  });
});

describe('normalizePhone', () => {
  it.each([
    ['+595 981 123 456', '+595981123456'],
    ['+595-981-123-456', '+595981123456'],
    ['+595 (981) 123.456', '+595981123456'],
    ['  +595981123456  ', '+595981123456']
  ])('%p -> %p', (raw, expected) => {
    expect(normalizePhone(raw)).toBe(expected);
  });
});

describeDb('B2B registration row (T-2.4)', () => {
  let fixtures: Fixtures;

  beforeAll(async () => {
    fixtures = await openFixtures();
  });

  afterAll(async () => {
    await fixtures?.close();
  });

  it('stores the RUC with check digit, the mock name and a pending approval', async () => {
    const data = await sanitizeWholesaleOnCreate({
      ...B2B,
      email: `wholesale-b2b-${Date.now()}@example.com`,
      ...PROTECTED_VALUES
    });
    const row = (await insert('customer').given(data).execute(fixtures.client)) as Record<string, unknown>;
    expect(row).toMatchObject({
      tax_id: '80012344-1',
      business_name: 'FERRETERIA Y CONSTRUCCIONES CENTRAL S.A.',
      phone: '+595981123456',
      is_wholesale_approved: false,
      wholesale_approved_at: null,
      wholesale_approved_by: null
    });
    expect(row.wholesale_requested_at).toBeInstanceOf(Date);
  });
});
