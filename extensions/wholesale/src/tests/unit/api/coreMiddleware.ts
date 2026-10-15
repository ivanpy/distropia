/**
 * Test harness: the API middleware chain core builds for a route, computed
 * with the compiled core scanner and sorter (as `Handler.getMiddlewareByRoute`
 * does at boot), plus this extension's compiled `dist/api/<routeId>`.
 *
 * Core `sortMiddlewares` silently drops a middleware whose `[after]` /
 * `[before]` dependency is missing, so a renamed core handler would turn an
 * extension guard into a no-op without any error. Drift guards assert the
 * extension middleware is present in the sorted chain and in the right place.
 */
import fs from 'fs';
import path from 'path';
import { pathToFileURL } from 'url';

export const CORE_MODULES = path.resolve(process.cwd(), 'packages/evershop/dist/modules');
export const EXTENSION_API = path.resolve(process.cwd(), 'extensions/wholesale/dist/api');
const CORE_MIDDLEWARE_LIB = path.resolve(process.cwd(), 'packages/evershop/dist/lib/middleware');

type Middleware = { id: string; routeId: string | null; scope: string };
type CoreMiddlewareLib = {
  scanForMiddlewareFunctions: (dir: string) => Middleware[];
  sortMiddlewares: (middlewares: Middleware[]) => Middleware[];
};

async function loadCoreMiddlewareLib(): Promise<CoreMiddlewareLib> {
  const scan = await import(pathToFileURL(path.join(CORE_MIDDLEWARE_LIB, 'scanForMiddlewareFunctions.js')).href);
  const sort = await import(pathToFileURL(path.join(CORE_MIDDLEWARE_LIB, 'sort.js')).href);
  return { ...scan, ...sort } as CoreMiddlewareLib;
}

/** The middleware ids core runs for an API route, in order. */
export async function sortedRouteMiddlewareIds(routeId: string): Promise<string[]> {
  const lib = await loadCoreMiddlewareLib();
  const all: Middleware[] = [];
  for (const module of fs.readdirSync(CORE_MODULES)) {
    for (const dir of [path.join(CORE_MODULES, module, 'api', 'global'), path.join(CORE_MODULES, module, 'api', routeId)]) {
      if (fs.existsSync(dir)) all.push(...lib.scanForMiddlewareFunctions(dir));
    }
  }
  const extensionDir = path.join(EXTENSION_API, routeId);
  if (fs.existsSync(extensionDir)) all.push(...lib.scanForMiddlewareFunctions(extensionDir));
  return lib
    .sortMiddlewares(all.filter((m) => m.routeId === routeId || m.scope === 'app'))
    .map((m) => m.id);
}
