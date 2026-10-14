import { addProcessor } from '@evershop/evershop/lib/util/registry';
import config from 'config';
import { WHOLESALE_CONFIG_DEFAULTS } from './config/defaults.js';
import {
  GUARD_PRICE_FILTERS_PRIORITY,
  guardPriceFilters
} from './services/catalog/guardPriceFilters.js';
import { assertRuntimeConfig } from './services/runtime/assertRuntimeConfig.js';

/** Subset of the core `BootstrapContext` (`bin/lib/bootstrap/bootstrap.ts`). */
export interface BootstrapContext {
  command?: string;
  env?: string;
  process?: string;
}

/**
 * Runs once at boot, before the core locks hooks and the registry.
 * Every hook, processor, job or provider of this extension must be
 * registered here (later phases).
 */
export default (context: BootstrapContext = {}) => {
  // Register versioned defaults; values in config/*.json override them.
  config.util.setModuleDefaults('wholesale', WHOLESALE_CONFIG_DEFAULTS);

  // ADR-08: fail fast on the runtime mode (demo + real credentials, or
  // production without real WhatsApp/SIFEN). Runs in the web, cron and event
  // processes. The asset build (`evershop build` forces NODE_ENV=production)
  // sends nothing and is skipped, so credentials stay a runtime concern.
  if (context.command !== 'build') {
    assertRuntimeConfig();
  }

  // ADR-06 item 5: price range filters and price sorting are inert for
  // approved wholesale viewers (decided per request, see priceFilterScope).
  addProcessor('productCollectionFilters', guardPriceFilters, GUARD_PRICE_FILTERS_PRIORITY);
};
