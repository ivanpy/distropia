/**
 * Request-scoped flag telling the product collection filters whether the
 * current viewer must not filter or sort by price (ADR-06 item 5).
 *
 * Core builds a product collection (`ProductCollection.init`) from inside
 * GraphQL resolvers, and runs the `productCollectionFilters` processors with
 * only `{ isAdmin, filterableAttributes }` as context: the filters never see
 * the viewer. The registry also caches the processed filter list across
 * requests, so the decision cannot be taken when the processor runs.
 *
 * Instead, the wholesale resolvers that build collections run core inside
 * `runWithPriceFilterScope`, and the guarded filter callbacks
 * (`guardPriceFilters.ts`) read `arePriceFiltersHidden()` when they are
 * called. Outside any scope (admin grids, widgets, jobs) prices stay
 * filterable, exactly as in core.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import {
  isWholesaleViewer,
  type ViewerContext
} from '../pricing/isWholesaleViewer.js';

interface PriceFilterScope {
  hidden: boolean;
}

const store = new AsyncLocalStorage<PriceFilterScope>();

/** True inside a scope opened for an approved wholesale viewer. */
export function arePriceFiltersHidden(): boolean {
  return store.getStore()?.hidden === true;
}

/** Run `fn` with price filters hidden when `context` is a wholesale viewer. */
export async function runWithPriceFilterScope<T>(
  context: ViewerContext,
  fn: () => T | Promise<T>
): Promise<T> {
  const hidden = await isWholesaleViewer(context);
  return store.run({ hidden }, fn);
}
