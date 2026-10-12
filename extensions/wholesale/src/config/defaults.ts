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
    expireSchedule: '*/15 * * * *'
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
