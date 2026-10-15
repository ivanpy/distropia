/**
 * Type declarations for the core `@evershop/evershop/customer/services` entry
 * point (the core `dist` ships no `.d.ts`). Mirrors
 * `packages/evershop/src/modules/customer/services/customer/createCustomer.ts`
 * and `.../customer/address/addressValidators.ts`.
 */
declare module '@evershop/evershop/customer/services' {
  import type { PoolClient } from 'pg';

  export type CustomerRow = Record<string, unknown> & { customer_id: number; uuid: string };

  /** Validates the fields core requires on a customer address (`addressValidator` registry value). */
  export function validateAddress(address: Record<string, unknown>): { valid: boolean; errors: string[] };

  /** Runs before `insertCustomerData(data, connection)` inside the registration transaction. */
  export function hookBeforeInsertCustomerData(
    callback: (
      this: Record<string, unknown>,
      data: Record<string, unknown>,
      connection: PoolClient
    ) => void | Promise<void>,
    priority?: number
  ): void;

  /**
   * Runs before `updateCustomerData(uuid, data, connection)` inside the core
   * `updateCustomer` transaction, after the `customerDataBeforeUpdate`
   * processors; mutations of `data` are written by core.
   */
  export function hookBeforeUpdateCustomerData(
    callback: (
      this: Record<string, unknown>,
      uuid: string,
      data: Record<string, unknown>,
      connection: PoolClient
    ) => void | Promise<void>,
    priority?: number
  ): void;

  /**
   * Runs after `insertCustomerData` inside the registration transaction. Core
   * calls it with the inserted row first (`lib/util/hookable.ts`), although
   * the core helper type omits it.
   */
  export function hookAfterInsertCustomerData(
    callback: (
      this: Record<string, unknown>,
      customer: CustomerRow,
      data: Record<string, unknown>,
      connection: PoolClient
    ) => void | Promise<void>,
    priority?: number
  ): void;
}
