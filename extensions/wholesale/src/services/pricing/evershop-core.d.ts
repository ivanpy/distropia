/**
 * Type declarations for the core `@evershop/evershop` entry points used by the
 * pricing services. The core `dist` is compiled with SWC and ships no `.d.ts`,
 * so these mirror the signatures in `packages/evershop/src`.
 */
declare module '@evershop/evershop/lib/locale/localeContext' {
  /** `packages/evershop/src/lib/locale/localeContext.ts` */
  export function getActiveLocale(): string;
}

declare module '@evershop/evershop/setting/services' {
  /** `packages/evershop/src/modules/setting/services/setting.ts` */
  export function getStoreCurrency(): string;
}
