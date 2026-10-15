/**
 * Type declarations for the core hook API used by the cart rules. The core
 * `dist` ships no `.d.ts`; this mirrors `packages/evershop/src/lib/util/hookable.ts`.
 */
declare module '@evershop/evershop/lib/util/hookable' {
  /**
   * After-hook of a `hookable` core function, keyed by the function name.
   * The callback receives the function's result first, then its arguments.
   * Must be called from `bootstrap.ts` (hooks lock after bootstrap).
   */
  export function hookAfter(
    funcName: string,
    callback: (this: unknown, result: any, ...args: any[]) => void | Promise<void>,
    priority?: number
  ): void;
}
