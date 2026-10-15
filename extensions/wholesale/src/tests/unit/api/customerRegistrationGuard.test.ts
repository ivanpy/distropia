/**
 * W4b (c): the core `POST /api/customers` (`createCustomer`) is a public
 * route — it is the storefront registration — and the core
 * `createCustomer` service writes `group_id` and `status` from the body when
 * present. A non-admin caller must not choose its customer group or its
 * status (`status: 0` also skips `customer_registered`, the event that
 * notifies the pending wholesale approval). An admin keeps both.
 */
import fs from 'fs';
import path from 'path';
import { pathToFileURL } from 'url';
import type { EvershopRequest } from '@evershop/evershop/types/request';
import type { EvershopResponse } from '@evershop/evershop/types/response';
import { CORE_MODULES, EXTENSION_API, sortedRouteMiddlewareIds } from './coreMiddleware.js';

const ROUTE_ID = 'createCustomer';
const MIDDLEWARE_FILE = '[bodyParser,getCurrentUser]stripRegistrationPrivileges[createCustomer].js';
const MIDDLEWARE_ID = 'stripRegistrationPrivileges';

type Middleware = (request: EvershopRequest, response: EvershopResponse, next: (err?: unknown) => void) => unknown;

async function run(body: unknown, admin?: Record<string, unknown>): Promise<{ body: unknown; next: unknown[] }> {
  const middleware = (await import(pathToFileURL(path.join(EXTENSION_API, ROUTE_ID, MIDDLEWARE_FILE)).href))
    .default as Middleware;
  const calls: unknown[] = [];
  const request = { body, getCurrentUser: () => admin };
  await middleware(request as unknown as EvershopRequest, {} as EvershopResponse, (err?: unknown) => {
    calls.push(err);
  });
  return { body: request.body, next: calls };
}

describe('registration mass-assignment guard (W4b c)', () => {
  it('the core registration route is public (reachable by anonymous storefront callers)', () => {
    const route = JSON.parse(fs.readFileSync(path.join(CORE_MODULES, 'customer', 'api', ROUTE_ID, 'route.json'), 'utf8'));
    expect(route).toEqual({ methods: ['POST'], path: '/customers', access: 'public' });
  });

  it('runs after the body parser and the admin session lookup, before the core handler', async () => {
    expect(fs.existsSync(path.join(EXTENSION_API, ROUTE_ID, MIDDLEWARE_FILE))).toBe(true);
    const ids = await sortedRouteMiddlewareIds(ROUTE_ID);
    const guard = ids.indexOf(MIDDLEWARE_ID);
    expect(guard).toBeGreaterThanOrEqual(0); // dropped by core when a dependency is missing
    expect(ids.indexOf('bodyParser')).toBeLessThan(guard);
    expect(ids.indexOf('getCurrentUser')).toBeLessThan(guard);
    expect(ids.indexOf('createCustomer')).toBeGreaterThan(guard);
  });

  it('strips group_id and status sent by a non-admin caller', async () => {
    const outcome = await run({ email: 'a@example.com', full_name: 'A', password: 'x', group_id: 2, status: 0 });
    expect(outcome.next).toEqual([undefined]);
    expect(outcome.body).toEqual({ email: 'a@example.com', full_name: 'A', password: 'x' });
  });

  it('keeps group_id and status sent by an authenticated admin', async () => {
    const outcome = await run({ email: 'a@example.com', group_id: 2, status: 0 }, { uuid: 'admin-uuid' });
    expect(outcome.next).toEqual([undefined]);
    expect(outcome.body).toEqual({ email: 'a@example.com', group_id: 2, status: 0 });
  });

  it('leaves other bodies untouched', async () => {
    expect((await run({ email: 'a@example.com' })).body).toEqual({ email: 'a@example.com' });
    expect((await run(undefined)).next).toEqual([undefined]);
  });
});
