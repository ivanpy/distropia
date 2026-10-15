import {
  hookAfterInsertCustomerData,
  hookBeforeInsertCustomerData,
  hookBeforeUpdateCustomerData
} from '@evershop/evershop/customer/services';
import { addProcessor } from '@evershop/evershop/lib/util/registry';
import config from 'config';
import { WHOLESALE_CONFIG_DEFAULTS } from './config/defaults.js';
import {
  GUARD_PRICE_FILTERS_PRIORITY,
  guardPriceFilters
} from './services/catalog/guardPriceFilters.js';
import {
  sanitizeWholesaleOnCreate,
  sanitizeWholesaleOnUpdate,
  WHOLESALE_CUSTOMER_GUARD_PRIORITY
} from './services/customer/sanitizeWholesaleFields.js';
import {
  insertRegistrationAddress,
  takeRegistrationAddress
} from './services/customer/registrationAddress.js';
import { revokeApprovalOnContactChange } from './services/customer/revokeOnContactChange.js';
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

  // A9 / RF-20: no self-approval through registration or profile edition;
  // B2B registrations repeat the RUC check (CU-00 step 3).
  addProcessor('customerDataBeforeCreate', sanitizeWholesaleOnCreate, WHOLESALE_CUSTOMER_GUARD_PRIORITY);
  addProcessor('customerDataBeforeUpdate', sanitizeWholesaleOnUpdate, WHOLESALE_CUSTOMER_GUARD_PRIORITY);

  // RF-19 / D-P2-6: a B2B registration stores its commercial/fiscal address as
  // the default address inside the core registration transaction. `address`
  // is removed from the customer data before the insert in every registration.
  hookBeforeInsertCustomerData(takeRegistrationAddress);
  hookAfterInsertCustomerData(insertRegistrationAddress);

  // RF-22 / A7: a phone or tax_id change on an approved customer revokes the
  // approval (audited) inside the core update transaction; a changed tax_id
  // is validated again.
  hookBeforeUpdateCustomerData(revokeApprovalOnContactChange);

  // ADR-06 item 5: price range filters and price sorting are inert for
  // approved wholesale viewers (decided per request, see priceFilterScope).
  addProcessor('productCollectionFilters', guardPriceFilters, GUARD_PRICE_FILTERS_PRIORITY);
};
