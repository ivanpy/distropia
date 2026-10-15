/**
 * W4b (b) drift guard: every place in the compiled core that writes the
 * `customer` table, and every core API route that reaches one, with what
 * keeps it from setting the approval columns or changing phone/tax_id
 * outside the wholesale rules (approval only through the audited
 * `POST /api/wholesale/customers/:id/approval`, D-P2-7).
 *
 * A new core writer or a new core route that reaches a writer fails this
 * suite until it is classified (and, when it can bypass the rules, guarded).
 */
import fs from 'fs';
import path from 'path';
import { CORE_MODULES, EXTENSION_API } from './coreMiddleware.js';

const CORE_DIST = path.resolve(process.cwd(), 'packages/evershop/dist');
const EXTENSION_DIST = path.resolve(process.cwd(), 'extensions/wholesale/dist');

/**
 * Query-builder or raw SQL write of the `customer` table (not
 * `customer_address` & co.). Case-sensitive: SQL keywords are uppercase in
 * core, and prose such as "Update customer address" must not match.
 */
const CUSTOMER_WRITE =
  /\b(?:update|insert|insertOnUpdate|del)\(\s*['"]customer['"]|\b(?:UPDATE|INSERT\s+INTO|DELETE\s+FROM)\s+\\?"?customer\\?"?[\s(]/;

/**
 * Every core file writing `customer` (path relative to `packages/evershop/dist`),
 * with a pattern pinning the shape the classification relies on.
 */
const CORE_CUSTOMER_WRITERS: Record<string, { coveredBy: string; shape: RegExp }> = {
  'modules/customer/api/updateCustomer/updateCustomer.js': {
    coveredBy: 'writes request.body directly: extension middleware guardWholesaleCustomerUpdate (W4b a)',
    shape: /update\('customer'\)\.given\(\{\s*\.\.\.request\.body/
  },
  'modules/customer/services/customer/createCustomer.js': {
    coveredBy: 'customerDataBeforeCreate processor sanitizeWholesaleOnCreate (+ stripRegistrationPrivileges on the public route)',
    shape: /getValue\('customerDataBeforeCreate'/
  },
  'modules/customer/services/customer/updateCustomer.js': {
    coveredBy: 'customerDataBeforeUpdate processor sanitizeWholesaleOnUpdate + updateCustomerData hook revokeApprovalOnContactChange',
    shape: /getValue\('customerDataBeforeUpdate'[\s\S]*hookable\(updateCustomerData/
  },
  'modules/customer/services/customer/updatePassword.js': {
    coveredBy: 'writes only the password column',
    shape: /update\('customer'\)\.given\(\{\s*password: hash\s*\}\)/
  },
  'modules/customer/services/customer/customerMetafield.js': {
    coveredBy: 'writes only meta_data (validated metafields)',
    shape: /update\('customer'\)\.given\(\{\s*meta_data: metaData\s*\}\)/
  },
  'modules/customer/services/customer/deleteCustomer.js': {
    coveredBy: 'deletes the row (approved customers keep a credit row: FK RESTRICT)',
    shape: /del\('customer'\)\.where\('uuid'/
  },
  'modules/customer/subscribers/metafield_definition_deleted/pruneCustomer.js': {
    coveredBy: 'writes only meta_data',
    shape: /UPDATE "customer" SET meta_data = meta_data #-/
  }
};

/** Every core API route reaching a customer writer, with its access and coverage. */
const CORE_CUSTOMER_WRITE_ROUTES: Record<string, { access: string; coveredBy: string }> = {
  createCustomer: { access: 'public', coveredBy: 'createCustomer service + stripRegistrationPrivileges middleware' },
  updateCustomer: { access: 'private', coveredBy: 'guardWholesaleCustomerUpdate middleware' },
  updateCustomerProfile: { access: 'public', coveredBy: 'updateCustomer service (processor + hook)' },
  updatePassword: { access: 'public', coveredBy: 'updatePassword service (password only)' },
  updateCustomerMetafields: { access: 'private', coveredBy: 'customerMetafield service (meta_data only)' },
  deleteCustomer: { access: 'private', coveredBy: 'deleteCustomer service (row delete)' }
};

/** Extension middlewares guarding core routes that reach a direct writer. */
const ROUTE_GUARDS: Record<string, string> = {
  updateCustomer: '[escapeHtml]guardWholesaleCustomerUpdate[updateCustomer].js',
  createCustomer: '[bodyParser,getCurrentUser]stripRegistrationPrivileges[createCustomer].js'
};

const posix = (p: string) => p.split(path.sep).join('/');

function listJs(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      return ['migration', 'tests', '__tests__', 'node_modules'].includes(entry.name) ? [] : listJs(full);
    }
    return entry.name.endsWith('.js') ? [full] : [];
  });
}

function coreCustomerWriters(): string[] {
  return listJs(CORE_DIST)
    .filter((file) => CUSTOMER_WRITE.test(fs.readFileSync(file, 'utf8')))
    .map((file) => posix(path.relative(CORE_DIST, file)));
}

/** Core API route folders whose files write `customer` or import a writer module. */
function coreCustomerWriteRoutes(writers: string[]): string[] {
  const writerModules = writers.map((w) => path.posix.basename(w));
  const routes: string[] = [];
  for (const module of fs.readdirSync(CORE_MODULES)) {
    const api = path.join(CORE_MODULES, module, 'api');
    if (!fs.existsSync(api)) continue;
    for (const route of fs.readdirSync(api)) {
      const dir = path.join(api, route);
      if (route === 'global' || !fs.statSync(dir).isDirectory()) continue;
      const reaches = listJs(dir).some((file) => {
        const source = fs.readFileSync(file, 'utf8');
        if (CUSTOMER_WRITE.test(source)) return true;
        return [...source.matchAll(/from\s+['"]([^'"]+)['"]/g)].some(
          ([, spec]) => spec.includes('/services/customer/') && writerModules.includes(path.posix.basename(spec))
        );
      });
      if (reaches) routes.push(route);
    }
  }
  return routes;
}

describe('core customer writes inventory (W4b b)', () => {
  it('lists every core file that writes the customer table', () => {
    expect(coreCustomerWriters().sort()).toEqual(Object.keys(CORE_CUSTOMER_WRITERS).sort());
  });

  it.each(Object.entries(CORE_CUSTOMER_WRITERS))('%s keeps the shape its classification relies on', (file, { shape }) => {
    expect(fs.readFileSync(path.join(CORE_DIST, file), 'utf8')).toMatch(shape);
  });

  it('lists every core API route that reaches a customer writer', () => {
    const writers = Object.keys(CORE_CUSTOMER_WRITERS);
    expect(coreCustomerWriteRoutes(writers).sort()).toEqual(Object.keys(CORE_CUSTOMER_WRITE_ROUTES).sort());
  });

  it.each(Object.entries(CORE_CUSTOMER_WRITE_ROUTES))('%s keeps its access level', (route, { access }) => {
    const json = JSON.parse(fs.readFileSync(path.join(CORE_MODULES, 'customer', 'api', route, 'route.json'), 'utf8'));
    expect(json.access).toBe(access);
  });

  it.each(Object.entries(ROUTE_GUARDS))('%s ships its extension guard', (route, file) => {
    expect(fs.existsSync(path.join(EXTENSION_API, route, file))).toBe(true);
  });

  it('registers the customer processors and the contact-change hook at bootstrap', () => {
    const bootstrap = fs.readFileSync(path.join(EXTENSION_DIST, 'bootstrap.js'), 'utf8');
    expect(bootstrap).toMatch(/addProcessor\('customerDataBeforeCreate', sanitizeWholesaleOnCreate/);
    expect(bootstrap).toMatch(/addProcessor\('customerDataBeforeUpdate', sanitizeWholesaleOnUpdate/);
    expect(bootstrap).toMatch(/hookBeforeUpdateCustomerData\(revokeApprovalOnContactChange\)/);
  });
});
