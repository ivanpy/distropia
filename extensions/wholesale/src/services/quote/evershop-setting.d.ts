/**
 * Core setting services read by the quote calculation. Merges with the
 * declaration of the same module in `services/pricing/evershop-core.d.ts`.
 */
declare module '@evershop/evershop/setting/services' {
  /**
   * `packages/evershop/src/modules/setting/services/setting.ts` — store weight
   * unit (kg | g | lb | oz); `product.weight` is stored unit-less in it.
   */
  export function getWeightUnit(): string;
}

declare module '@evershop/evershop/setting/services' {
  /**
   * `packages/evershop/src/modules/setting/services/setting.ts` — store
   * display time zone (IANA name); the year of a quote number is taken in it.
   */
  export function getStoreTimezone(): string;
}

declare module '@evershop/evershop/lib/log' {
  /** `packages/evershop/src/lib/log/logger.js` — logs an error (no `.d.ts` shipped). */
  export function error(e: unknown): void;
}
