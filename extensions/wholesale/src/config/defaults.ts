/**
 * Versioned defaults for the `wholesale` configuration section.
 *
 * `config/` at the project root is local to each installation (git-ignored),
 * so the defaults live here and are registered with node-config from
 * `bootstrap.ts` via `config.util.setModuleDefaults('wholesale', ...)` — the
 * same mechanism core modules use (catalog, oms, tax). Any value set under
 * `wholesale` in `config/default.json` (or an environment-specific file)
 * overrides the matching default.
 *
 * Secrets never go here: they are read from environment variables
 * (see `.env.example` at the project root).
 */
export const WHOLESALE_CONFIG_DEFAULTS = {
  quote: {
    expirationHours: 72,
    currency: 'PYG',
    expireSchedule: '*/15 * * * *',
    // RF-28 / G-11: minimum net products total after the mix rule (freight excluded).
    minimumNetTotal: 5_000_000,
    // RF-27: minimum share of a line in the mix.
    mixMinShare: 0.15,
    // RF-30 / G-6: maximum total weight (kg) that ships free. `null` means
    // "special freight" for every quote: the seller always quotes the freight
    // (`awaiting_freight`) before the quote is sent. See isSpecialFreightAlways.
    freeShippingMaxWeightKg: null as number | null
  },
  order: {
    // RF-37: hours the customer has to pay or get credit approved.
    paymentWindowHours: 48,
    expireSchedule: '*/15 * * * *',
    // G-7: cheque is a payment method.
    paymentMethods: ['credit', 'cash', 'bank_transfer', 'cheque']
  },
  credit: {
    // RF-36: values given to wholesale_customer_credit on approval.
    defaultLimit: 0,
    defaultTermDays: 30,
    // RF-46: account in "alert" at debt >= 85 % of the limit.
    alertThreshold: 0.85
  },
  invoicing: {
    // ADR-13: freight travels as a service line on quote, order and invoice.
    freightServiceCode: 'FLETE_LOGISTICA',
    freightDescription: 'Servicio de flete y logística',
    // G-3: freight is taxed at 10 %.
    freightVatRate: '10'
  },
  cartForcing: {
    // ADR-13: quote-born cart processors run after promotions (priority 11).
    processorPriority: 20
  },
  dashboard: {
    // ADR-13: channel preselected on the admin dashboards.
    defaultChannel: 'b2c'
  },
  rateLimit: {
    perCustomerHour: 3,
    perCustomerDay: 10,
    perTaxIdHour: 3,
    perTaxIdDay: 10,
    perIpHour: 15
  },
  botProtection: {
    provider: 'turnstile',
    enabled: true,
    recaptchaMinScore: 0.5
  },
  whatsapp: {
    templateName: 'presupuesto_mayorista_v1',
    templateLanguage: 'es',
    graphApiVersion: 'v21.0'
  }
};

export type WholesaleConfig = typeof WHOLESALE_CONFIG_DEFAULTS;

/**
 * `quote.freeShippingMaxWeightKg = null` is the "special freight" setting:
 * no quote ships free, whatever its weight (G-6).
 */
export const isSpecialFreightAlways = (
  freeShippingMaxWeightKg: number | null | undefined
): boolean => freeShippingMaxWeightKg === null || freeShippingMaxWeightKg === undefined;
