/**
 * Type declarations for the core `@evershop/evershop` entry points used by the
 * extension services. The core `dist` is compiled with SWC and ships no `.d.ts`,
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

declare module '@evershop/evershop/lib/util/registry' {
  /** `packages/evershop/src/lib/util/registry.ts` (must be called from `bootstrap.ts`). */
  export function addProcessor<T>(
    name: string,
    callback: (this: unknown, value: T) => T | Promise<T>,
    priority?: number
  ): void;
}

declare module '@evershop/evershop/types/request' {
  /** Subset of `packages/evershop/src/types/request.ts` read by the extension. */
  import type { Request } from 'express';

  export interface CurrentCustomer {
    customer_id: number;
    [key: string]: unknown;
  }

  /** Admin user row set by the core admin auth middlewares (`types/request.ts`). */
  export interface CurrentUser {
    admin_user_id: number;
    uuid: string;
    email: string;
    [key: string]: unknown;
  }

  export interface EvershopRequest extends Request {
    /** Logged-in admin user, `null` on storefront requests. */
    getCurrentUser(): CurrentUser | null;
    locals: {
      customer: CurrentCustomer | null;
      context: Record<string, unknown>;
      [key: string]: unknown;
    };
  }
}

declare module '@evershop/evershop/types/response' {
  /** `packages/evershop/src/types/response.ts` */
  import type { Response } from 'express';

  export interface EvershopResponse extends Response {
    debugMiddlewares: { id: string; time: number }[];
    $body: Record<string, unknown>;
  }
}
