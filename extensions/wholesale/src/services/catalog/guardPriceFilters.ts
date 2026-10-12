/**
 * `productCollectionFilters` processor (registered in `bootstrap.ts`) that
 * makes the core price filters inert for approved wholesale viewers
 * (ADR-06 item 5, T-2.10e):
 *
 * - `min_price` / `max_price` are ignored: no predicate is added and the
 *   filter is not echoed in `currentFilters`. A range filter would reveal
 *   the catalog minimum and maximum.
 * - `ob` (order by) with a price sort code falls back to the core default
 *   order: a price sort would reveal the relative price ranking.
 *
 * The guarded callbacks decide at call time from `arePriceFiltersHidden()`,
 * because the registry caches the processed filter list across requests.
 * Every other filter, and every viewer outside a wholesale scope, gets the
 * core callback unchanged.
 */
import { arePriceFiltersHidden } from './priceFilterScope.js';

/** Runs after core (priority 1: default filters, 2: pagination). */
export const GUARD_PRICE_FILTERS_PRIORITY = 100;

export const PRICE_RANGE_FILTER_KEYS = ['min_price', 'max_price'];

export const SORT_FILTER_KEY = 'ob';

type FilterCallback = (
  this: unknown,
  query: unknown,
  operation: unknown,
  value: unknown,
  currentFilters: unknown[]
) => unknown;

export interface CollectionFilter {
  key: string;
  operation: string[];
  callback: FilterCallback;
}

/**
 * Core registers a single `price` sort (`productCollectionSortBy`); other
 * extensions may add variants (`price_desc`, `final_price`, ...), so any sort
 * code mentioning "price" is treated as a price sort.
 */
export function isPriceSort(value: unknown): boolean {
  return typeof value === 'string' && value.toLowerCase().includes('price');
}

function guard(filter: CollectionFilter): CollectionFilter {
  const original = filter.callback;
  if (PRICE_RANGE_FILTER_KEYS.includes(filter.key)) {
    return {
      ...filter,
      callback: function guardedPriceRange(this: unknown, ...args) {
        return arePriceFiltersHidden() ? undefined : original.apply(this, args);
      }
    };
  }
  if (filter.key === SORT_FILTER_KEY) {
    return {
      ...filter,
      callback: function guardedSort(this: unknown, query, operation, value, currentFilters) {
        // Core falls back to `product_id DESC` for an unknown sort code and
        // leaves it out of `currentFilters`.
        const sort = arePriceFiltersHidden() && isPriceSort(value) ? undefined : value;
        return original.call(this, query, operation, sort, currentFilters);
      }
    };
  }
  return filter;
}

export function guardPriceFilters(filters: CollectionFilter[]): CollectionFilter[] {
  return filters.map(guard);
}
