/**
 * Free-shipping weight threshold in the store weight unit (T-2.47, RF-30).
 *
 * `wholesale.quote.freeShippingMaxWeightKg` is configured in kg, while
 * `product.weight` is stored unit-less in the store unit returned by core
 * `getWeightUnit()` (kg, g, lb, oz). The threshold is converted to that unit
 * before the quote compares it with the total weight.
 *
 * A `null` threshold stays `null` (special freight for every quote, G-6). An
 * unknown store unit also yields `null`: special freight is the fail-safe
 * outcome of RF-30, never a free shipment computed in the wrong unit.
 */
import { getWeightUnit } from '@evershop/evershop/setting/services';

export type WeightUnit = 'kg' | 'g' | 'lb' | 'oz';

/** Kilograms in one unit (international avoirdupois pound and ounce, exact). */
const KG_PER_UNIT: Readonly<Record<WeightUnit, number>> = Object.freeze({
  kg: 1,
  g: 0.001,
  lb: 0.45359237,
  oz: 0.028349523125
});

/**
 * Store unit as core `createShipment` reads it: case-insensitive, trimmed,
 * one trailing plural `s` dropped (`kgs`, `lbs`). `null` when unknown.
 */
export function normalizeWeightUnit(raw: string): WeightUnit | null {
  const unit = String(raw).trim().toLowerCase().replace(/s$/, '');
  return Object.prototype.hasOwnProperty.call(KG_PER_UNIT, unit) ? (unit as WeightUnit) : null;
}

/** `kg` expressed in `unit`; `null` for a null threshold or an unknown unit. */
export function kgToWeightUnit(kg: number | null, unit: string): number | null {
  if (kg === null) {
    return null;
  }
  if (!Number.isFinite(kg) || kg < 0) {
    throw new Error(`wholesale.quote.freeShippingMaxWeightKg must be null or a finite number >= 0, got ${kg}`);
  }
  const normalized = normalizeWeightUnit(unit);
  if (normalized === null) {
    return null;
  }
  return normalized === 'g' ? kg * 1000 : kg / KG_PER_UNIT[normalized];
}

/** The configured kg threshold in the store weight unit (core `getWeightUnit()` by default). */
export function freeShippingMaxWeightInStoreUnit(maxKg: number | null, unit: string = getWeightUnit()): number | null {
  return kgToWeightUnit(maxKg, unit);
}
