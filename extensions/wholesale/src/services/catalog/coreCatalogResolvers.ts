/**
 * Loads the compiled core catalog resolvers that the wholesale extension
 * wraps (ADR-06 item 5). Wrapping delegates to the core implementation
 * instead of replicating it: the extension only adds the price filter scope
 * around the call, or hides `priceRange`.
 *
 * Core does not export its resolver modules, so they are imported from the
 * installed `@evershop/evershop` package by path. Coupled to the installed
 * version; `tests/unit/catalog/coreCatalogResolvers.test.ts` fails when a
 * wrapped resolver moves or disappears.
 */
import { createRequire } from 'module';
import path from 'path';
import { pathToFileURL } from 'url';

// The extension compiles to ESM; Node and Jest both provide import.meta.url.
const require = createRequire(import.meta.url);

export type CoreResolver = (
  parent: unknown,
  args: Record<string, unknown>,
  context: Record<string, unknown>,
  info: unknown
) => unknown;

type ResolverModule = Record<string, Record<string, CoreResolver | undefined>>;

/** `dist` directory of the installed core package. */
export function coreDistDir(): string {
  return path.join(path.dirname(require.resolve('@evershop/evershop/package.json')), 'dist');
}

async function loadResolverModule(relativePath: string): Promise<ResolverModule> {
  const file = path.join(coreDistDir(), 'modules/catalog/graphql/types', relativePath);
  const module = (await import(pathToFileURL(file).href)) as { default: ResolverModule };
  return module.default;
}

function pick(module: ResolverModule, type: string, field: string): CoreResolver {
  const resolver = module[type]?.[field];
  if (typeof resolver !== 'function') {
    throw new Error(`wholesale: core resolver ${type}.${field} not found`);
  }
  return resolver;
}

export interface CoreCatalogResolvers {
  queryProducts: CoreResolver;
  queryProductSearch: CoreResolver;
  categoryProducts: CoreResolver;
  categoryPriceRange: CoreResolver;
  collectionProducts: CoreResolver;
  productListingProducts: CoreResolver;
  productListingPriceRange: CoreResolver;
}

export async function loadCoreCatalogResolvers(): Promise<CoreCatalogResolvers> {
  // Sequential: Jest's ESM runtime fails to link a module graph reached by
  // concurrent dynamic imports; the cost at boot is negligible.
  const product = await loadResolverModule('Product/Product.resolvers.js');
  const category = await loadResolverModule('Category/Category.resolvers.js');
  const collection = await loadResolverModule('Collection/Collection.resolvers.js');
  const listing = await loadResolverModule('ProductListing/ProductListing.resolvers.js');
  return {
    queryProducts: pick(product, 'Query', 'products'),
    queryProductSearch: pick(product, 'Query', 'productSearch'),
    categoryProducts: pick(category, 'Category', 'products'),
    categoryPriceRange: pick(category, 'Category', 'priceRange'),
    collectionProducts: pick(collection, 'Collection', 'products'),
    productListingProducts: pick(listing, 'ProductListing', 'products'),
    productListingPriceRange: pick(listing, 'ProductListing', 'priceRange')
  };
}
