import { addProcessor } from '@evershop/evershop/lib/util/registry';
import config from 'config';
import { WHOLESALE_CONFIG_DEFAULTS } from './config/defaults.js';
import {
  GUARD_PRICE_FILTERS_PRIORITY,
  guardPriceFilters
} from './services/catalog/guardPriceFilters.js';

/**
 * Runs once at boot, before the core locks hooks and the registry.
 * Every hook, processor, job or provider of this extension must be
 * registered here (later phases).
 */
export default () => {
  // Register versioned defaults; values in config/*.json override them.
  config.util.setModuleDefaults('wholesale', WHOLESALE_CONFIG_DEFAULTS);

  // ADR-06 item 5: price range filters and price sorting are inert for
  // approved wholesale viewers (decided per request, see priceFilterScope).
  addProcessor('productCollectionFilters', guardPriceFilters, GUARD_PRICE_FILTERS_PRIORITY);
};
