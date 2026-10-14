/**
 * T-2.33: the v2.1 defaults of the `wholesale` config section are registered
 * by `bootstrap.ts` (`setModuleDefaults`) and readable through the core
 * `getConfig`, the same path services use at runtime.
 */
import { getConfig } from '@evershop/evershop/lib/util/getConfig';
import bootstrap from '../../../bootstrap.js';
import {
  isSpecialFreightAlways,
  WHOLESALE_CONFIG_DEFAULTS
} from '../../../config/defaults.js';

describe('wholesale config defaults (v2.1)', () => {
  beforeAll(() => {
    bootstrap();
  });

  it.each<[string, unknown]>([
    ['wholesale.quote.minimumNetTotal', 5_000_000],
    ['wholesale.quote.mixMinShare', 0.15],
    ['wholesale.order.paymentWindowHours', 48],
    ['wholesale.order.expireSchedule', '*/15 * * * *'],
    ['wholesale.order.paymentMethods', ['credit', 'cash', 'bank_transfer', 'cheque']],
    ['wholesale.credit.defaultLimit', 0],
    ['wholesale.credit.defaultTermDays', 30],
    ['wholesale.credit.alertThreshold', 0.85],
    ['wholesale.invoicing.freightServiceCode', 'FLETE_LOGISTICA'],
    ['wholesale.invoicing.freightDescription', 'Servicio de flete y logística'],
    ['wholesale.invoicing.freightVatRate', '10'],
    ['wholesale.cartForcing.processorPriority', 20],
    ['wholesale.dashboard.defaultChannel', 'b2c']
  ])('getConfig(%s) returns the default', (path, expected) => {
    expect(getConfig(path)).toEqual(expected);
  });

  it('accepts cheque as a payment method (G-7)', () => {
    expect(getConfig<string[]>('wholesale.order.paymentMethods')).toContain('cheque');
  });

  it('keeps freeShippingMaxWeightKg null: every quote takes special freight (G-6)', () => {
    // `has` must be true: a null default is a decision, not a missing key.
    expect(getConfig('wholesale.quote.freeShippingMaxWeightKg', 999)).toBeNull();
    expect(isSpecialFreightAlways(null)).toBe(true);
    expect(isSpecialFreightAlways(WHOLESALE_CONFIG_DEFAULTS.quote.freeShippingMaxWeightKg)).toBe(
      true
    );
    expect(isSpecialFreightAlways(500)).toBe(false);
  });

  it('keeps the phase 1 defaults', () => {
    expect(getConfig('wholesale.quote.expirationHours')).toBe(72);
    expect(getConfig('wholesale.rateLimit.perIpHour')).toBe(15);
  });
});
