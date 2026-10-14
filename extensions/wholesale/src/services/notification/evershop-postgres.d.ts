/**
 * Type declaration for the core shared pool. The core `dist` ships no `.d.ts`
 * for it; this mirrors `packages/evershop/src/lib/postgres/connection.ts`.
 */
declare module '@evershop/evershop/lib/postgres' {
  import type { Pool } from 'pg';

  export const pool: Pool;
}
