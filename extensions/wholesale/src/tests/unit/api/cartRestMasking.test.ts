/**
 * Integration test for T-2.31 (D-P2-3): the core storefront REST cart API
 * must not return amounts to approved wholesale customers.
 *
 * Three layers:
 * - drift guards over the compiled core: every cart item field core
 *   registers is classified as amount / non-amount, and every core API route
 *   that returns `item.export()` is covered by an extension middleware;
 * - wiring: the extension middleware is sorted by the core middleware sorter
 *   between the core handler and `apiResponse` on every covered route (a
 *   middleware whose dependency is missing is silently dropped by core);
 * - behavior: the compiled middleware masks a `response.$body` shaped like
 *   the core handlers' for an approved customer read from the database, and
 *   leaves it untouched for B2C and anonymous viewers.
 */
import fs from 'fs';
import path from 'path';
import { pathToFileURL } from 'url';
import type { EvershopRequest } from '@evershop/evershop/types/request';
import type { EvershopResponse } from '@evershop/evershop/types/response';
import {
  CART_ITEM_AMOUNT_KEYS,
  CART_REST_ROUTES,
  isCartItemAmountKey,
  maskWholesaleCartResponse
} from '../../../services/pricing/maskCartRestResponse.js';
import { describeDb, openFixtures, type Fixtures } from '../graphql/storefrontSchema.js';
import { CORE_MODULES, EXTENSION_API, sortedRouteMiddlewareIds } from './coreMiddleware.js';

const MIDDLEWARE_ID = 'maskWholesaleCartAmounts';

/** Cart item fields that carry an amount (core `item.export()` keys). */
const EXPECTED_AMOUNT_KEYS = [
  'discount_amount',
  'final_price',
  'final_price_incl_tax',
  'line_total',
  'line_total_incl_tax',
  'line_total_with_discount',
  'line_total_with_discount_incl_tax',
  'product_price',
  'product_price_incl_tax',
  'tax_amount',
  'tax_amount_before_discount'
];

/** Every other cart item field core registers today. */
const NON_AMOUNT_KEYS = [
  'cart_id',
  'cart_item_id',
  'category_id',
  'group_id',
  'no_shipping_required',
  'package_height',
  'package_length',
  'package_weight',
  'package_width',
  'productUrl',
  'product_id',
  'product_name',
  'product_sku',
  'product_uuid',
  'product_weight',
  'qty',
  'removeUrl',
  'tax_class_id',
  'tax_percent',
  'thumbnail',
  'uuid',
  'variant_group_id',
  'variant_options'
];

type FieldRegistrar = (fields: { key: string }[]) => { key: string }[];

/**
 * The keys of every `cartItemFields` processor registered by a core module
 * bootstrap. A registration that is not a named import fails the guard.
 */
async function registeredCartItemKeys(): Promise<string[]> {
  const keys: string[] = [];
  for (const module of fs.readdirSync(CORE_MODULES)) {
    const bootstrap = path.join(CORE_MODULES, module, 'bootstrap.js');
    if (!fs.existsSync(bootstrap)) continue;
    const source = fs.readFileSync(bootstrap, 'utf8');
    const registrations = [...source.matchAll(/addProcessor\(\s*['"]cartItemFields['"]\s*,\s*([^,\s]+)/g)];
    for (const [, name] of registrations) {
      const imported = new RegExp(`import\\s*\\{[^}]*\\b${name}\\b[^}]*\\}\\s*from\\s*['"]([^'"]+)['"]`).exec(
        source
      );
      if (!imported) {
        throw new Error(`Unrecognized cartItemFields registration "${name}" in ${module}/bootstrap.js`);
      }
      const file = pathToFileURL(path.resolve(path.dirname(bootstrap), imported[1])).href;
      const registrar = (await import(file))[name] as FieldRegistrar;
      keys.push(...registrar([]).map((f) => f.key));
    }
  }
  return keys;
}

/** Core API route folders whose handlers put `.export()` data into the response. */
function coreRoutesExportingItems(): string[] {
  const routes: string[] = [];
  for (const module of fs.readdirSync(CORE_MODULES)) {
    const api = path.join(CORE_MODULES, module, 'api');
    if (!fs.existsSync(api)) continue;
    for (const route of fs.readdirSync(api)) {
      const dir = path.join(api, route);
      if (route === 'global' || !fs.statSync(dir).isDirectory()) continue;
      const exportsItems = fs
        .readdirSync(dir)
        .some((f) => f.endsWith('.js') && /\.export\(\)/.test(fs.readFileSync(path.join(dir, f), 'utf8')));
      if (exportsItems) routes.push(route);
    }
  }
  return routes;
}

describe('REST cart masking drift guards (T-2.31)', () => {
  it('classifies every cart item field core registers (fails when core adds one)', async () => {
    const keys = await registeredCartItemKeys();
    expect(keys.length).toBeGreaterThan(0);
    const unclassified = keys.filter(
      (k) => !EXPECTED_AMOUNT_KEYS.includes(k) && !NON_AMOUNT_KEYS.includes(k)
    );
    expect(unclassified).toEqual([]);
    expect([...CART_ITEM_AMOUNT_KEYS].sort()).toEqual(EXPECTED_AMOUNT_KEYS);
    expect(keys.filter(isCartItemAmountKey).sort()).toEqual(EXPECTED_AMOUNT_KEYS);
  });

  it('covers every core API route that returns exported cart items', () => {
    expect(coreRoutesExportingItems().sort()).toEqual(Object.keys(CART_REST_ROUTES).sort());
  });

  it.each(Object.entries(CART_REST_ROUTES))(
    'runs the masking middleware after the core handler and before apiResponse on %s',
    async (routeId, handlerId) => {
      expect(
        fs.existsSync(path.join(EXTENSION_API, routeId, `[${handlerId}]${MIDDLEWARE_ID}.js`))
      ).toBe(true);
      const ids = await sortedRouteMiddlewareIds(routeId);
      const handler = ids.indexOf(handlerId);
      const mask = ids.indexOf(MIDDLEWARE_ID);
      const send = ids.indexOf('apiResponse');
      expect(handler).toBeGreaterThanOrEqual(0);
      expect(mask).toBeGreaterThan(handler);
      expect(send).toBeGreaterThan(mask);
    }
  );
});

/** A cart item shaped like core `item.export()`, with distinct amounts. */
function exportedItem(n: number): Record<string, unknown> {
  const item: Record<string, unknown> = {};
  EXPECTED_AMOUNT_KEYS.forEach((key, i) => {
    item[key] = n * 100 + i + 0.25;
  });
  NON_AMOUNT_KEYS.forEach((key) => {
    item[key] = `${key}-${n}`;
  });
  item.qty = n + 1;
  item.tax_percent = 10;
  item.errors = {};
  return item;
}

/** `response.$body` of addCartItem / addMineCartItem / updateQty. */
const singleItemBody = () => ({ data: { item: exportedItem(1), count: 2, cartId: 'cart-uuid' } });
/** `response.$body` of createCart. */
const multiItemBody = () => ({ data: { items: [exportedItem(1), exportedItem(2)], count: 2, cartId: 'cart-uuid' } });

type Viewer = { customer?: Record<string, unknown> | null; pool?: unknown; appPool?: unknown };

async function runMiddleware(body: Record<string, unknown>, viewer: Viewer): Promise<Record<string, unknown>> {
  const request = {
    locals: { customer: viewer.customer ?? null, context: viewer.pool ? { pool: viewer.pool } : {} },
    app: { locals: { context: viewer.appPool ? { pool: viewer.appPool } : {} } }
  } as unknown as EvershopRequest;
  const response = { $body: body } as unknown as EvershopResponse;
  const middleware = (await import(
    pathToFileURL(path.join(EXTENSION_API, 'addCartItem', `[addItemToCart]${MIDDLEWARE_ID}.js`)).href
  )).default as typeof maskWholesaleCartResponse;
  expect(middleware.length).toBe(2); // passive: core calls next() itself
  await middleware(request, response);
  return response.$body;
}

function expectMasked(item: Record<string, unknown>, original: Record<string, unknown>): void {
  for (const key of EXPECTED_AMOUNT_KEYS) {
    expect([key, item[key]]).toEqual([key, null]);
  }
  expect(item.is_masked).toBe(true);
  for (const key of [...NON_AMOUNT_KEYS, 'errors']) {
    expect([key, item[key]]).toEqual([key, original[key]]);
  }
}

describeDb('REST cart amounts for wholesale viewers (T-2.31)', () => {
  let fixtures: Fixtures;
  let approvedCustomer: Record<string, unknown>;
  let b2cCustomer: Record<string, unknown>;

  beforeAll(async () => {
    fixtures = await openFixtures();
    approvedCustomer = await fixtures.insertCustomer(true);
    b2cCustomer = await fixtures.insertCustomer(false);
  });

  afterAll(async () => {
    await fixtures?.close();
  });

  it('masks every item amount for an approved wholesale customer', async () => {
    const original = singleItemBody();
    const body = await runMiddleware(singleItemBody(), { customer: approvedCustomer, pool: fixtures.client });
    const data = body.data as { item: Record<string, unknown>; count: number; cartId: string };
    expectMasked(data.item, original.data.item);
    expect(data.count).toBe(2);
    expect(data.cartId).toBe('cart-uuid');
  });

  it('masks every item of a created cart, reading the app-level pool', async () => {
    const original = multiItemBody();
    const body = await runMiddleware(multiItemBody(), { customer: approvedCustomer, appPool: fixtures.client });
    const items = (body.data as { items: Record<string, unknown>[] }).items;
    expect(items).toHaveLength(2);
    items.forEach((item, i) => expectMasked(item, original.data.items[i]));
  });

  it('does not trust an approval flag carried by the session customer', async () => {
    const original = singleItemBody();
    const body = await runMiddleware(singleItemBody(), {
      customer: { ...b2cCustomer, is_wholesale_approved: true },
      pool: fixtures.client
    });
    expect(JSON.stringify(body)).toBe(JSON.stringify(original));
  });

  it('leaves the response of a B2C customer unchanged', async () => {
    for (const make of [singleItemBody, multiItemBody]) {
      const body = await runMiddleware(make(), { customer: b2cCustomer, pool: fixtures.client });
      expect(JSON.stringify(body)).toBe(JSON.stringify(make()));
    }
  });

  it('leaves the response of an anonymous visitor unchanged without querying', async () => {
    for (const make of [singleItemBody, multiItemBody]) {
      const body = await runMiddleware(make(), { customer: null });
      expect(JSON.stringify(body)).toBe(JSON.stringify(make()));
    }
  });

  it('fails closed when the approval of a logged-in customer cannot be read', async () => {
    await expect(runMiddleware(singleItemBody(), { customer: approvedCustomer })).rejects.toThrow(
      /no database pool/
    );
  });
});
