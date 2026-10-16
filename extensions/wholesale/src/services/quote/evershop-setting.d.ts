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
