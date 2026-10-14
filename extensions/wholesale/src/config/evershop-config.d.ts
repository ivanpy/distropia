/**
 * Type declaration for the core `getConfig` helper. The core `dist` ships no
 * `.d.ts`, and the core signature is typed against the core config structure
 * only, so `wholesale.*` paths are declared here as plain strings.
 */
declare module '@evershop/evershop/lib/util/getConfig' {
  /** `packages/evershop/src/lib/util/getConfig.ts` */
  export function getConfig<T = unknown>(path: string, defaultValue?: T): T;
}
