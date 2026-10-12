/**
 * Guards the coupling of `services/catalog/coreCatalogResolvers.ts` to the
 * installed core: every wrapped core resolver must still exist where the
 * extension imports it from.
 */
import path from 'path';
import {
  coreDistDir,
  loadCoreCatalogResolvers
} from '../../../services/catalog/coreCatalogResolvers.js';

describe('loadCoreCatalogResolvers', () => {
  it('resolves the installed core package dist', () => {
    expect(coreDistDir()).toBe(path.resolve(process.cwd(), 'packages/evershop/dist'));
  });

  it('finds every wrapped core resolver', async () => {
    const resolvers = await loadCoreCatalogResolvers();
    expect(Object.keys(resolvers).sort()).toEqual(
      [
        'categoryPriceRange',
        'categoryProducts',
        'collectionProducts',
        'productListingPriceRange',
        'productListingProducts',
        'queryProductSearch',
        'queryProducts'
      ].sort()
    );
    for (const resolver of Object.values(resolvers)) {
      expect(typeof resolver).toBe('function');
    }
  });
});
