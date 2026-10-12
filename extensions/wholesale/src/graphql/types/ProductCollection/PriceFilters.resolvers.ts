/**
 * ADR-06 item 5 (T-2.10e): approved wholesale viewers can neither filter
 * nor sort the storefront product collections by price, and are not offered
 * the catalog price range.
 *
 * Every storefront field that builds a `ProductCollection` from shopper
 * input (GraphQL `filters` or URL query string) is wrapped: core runs
 * unchanged inside `runWithPriceFilterScope`, where the guarded
 * `min_price` / `max_price` / `ob` filters (`guardPriceFilters.ts`,
 * registered in `bootstrap.ts`) become inert for wholesale viewers.
 * `Query.currentCategory` hands its URL filters to `Category.products`, so
 * wrapping `Category.products` covers category pages too.
 *
 * `priceRange` (the bounds of the price filter UI) resolves to null for
 * wholesale viewers; the field is nullable and the core UI hides the price
 * filter when it is missing.
 */
import {
  loadCoreCatalogResolvers,
  type CoreResolver
} from '../../../services/catalog/coreCatalogResolvers.js';
import { runWithPriceFilterScope } from '../../../services/catalog/priceFilterScope.js';
import { isWholesaleViewer } from '../../../services/pricing/isWholesaleViewer.js';

const core = await loadCoreCatalogResolvers();

/** Run the core resolver inside the viewer's price filter scope. */
function scoped(resolver: CoreResolver): CoreResolver {
  return (parent, args, context, info) =>
    runWithPriceFilterScope(context, () => resolver(parent, args, context, info));
}

/** Resolve to null for wholesale viewers, else to the core value. */
function hiddenForWholesale(resolver: CoreResolver): CoreResolver {
  return async (parent, args, context, info) =>
    (await isWholesaleViewer(context)) ? null : resolver(parent, args, context, info);
}

export default {
  Query: {
    products: scoped(core.queryProducts),
    productSearch: scoped(core.queryProductSearch)
  },
  Category: {
    products: scoped(core.categoryProducts),
    priceRange: hiddenForWholesale(core.categoryPriceRange)
  },
  Collection: {
    products: scoped(core.collectionProducts)
  },
  ProductListing: {
    products: scoped(core.productListingProducts),
    priceRange: hiddenForWholesale(core.productListingPriceRange)
  }
};
