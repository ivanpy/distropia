/**
 * Test harness: builds the storefront GraphQL schema in-process exactly as
 * core does (`buildTypeDefs(false)` + `buildResolvers(false)` from the
 * compiled core, which also load this extension's compiled
 * `dist/graphql/types/**`), plus a rolled-back fixture transaction whose
 * client is handed to resolvers as `context.pool`.
 *
 * Shared by the GraphQL integration tests of the extension.
 */
import 'dotenv/config';
import { randomUUID } from 'crypto';
import fs from 'fs';
import path from 'path';
import { pathToFileURL } from 'url';
import { makeExecutableSchema } from '@graphql-tools/schema';
import type { IResolvers } from '@graphql-tools/utils';
import { graphql } from 'graphql';
import type { GraphQLSchema } from 'graphql';
import pg from 'pg';
import migrate from '../../../migration/Version-1.0.0.js';
import { withApprovalWrite } from '../../../services/customer/approvalWriteFlag.js';

/** `describe` when a database is configured, `describe.skip` otherwise. */
export const describeDb = process.env.DB_NAME ? describe : describe.skip;

const CORE_GRAPHQL_SERVICES = path.resolve(
  process.cwd(),
  'packages/evershop/dist/modules/graphql/services'
);

type CoreBuilders = {
  buildTypeDefs: (isAdmin?: boolean) => unknown;
  buildResolvers: (isAdmin?: boolean) => Promise<IResolvers>;
};

/** Recursively list storefront resolver files (same filter as core). */
function listResolverFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) {
    return [];
  }
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      return listResolverFiles(full);
    }
    return entry.name.endsWith('.resolvers.js') &&
      !entry.name.endsWith('.admin.resolvers.js')
      ? [full]
      : [];
  });
}

/**
 * Jest's ESM runtime fails to link a module that several concurrent dynamic
 * imports reach at once (core's buildResolvers imports every resolver file
 * in parallel). Importing them sequentially first fills the module registry,
 * so the parallel pass only hits the cache. Test-harness only.
 */
async function prewarmResolverModules(): Promise<void> {
  const modulesDir = path.resolve(CORE_GRAPHQL_SERVICES, '..', '..');
  const files = [
    ...fs
      .readdirSync(modulesDir)
      .flatMap((m) => listResolverFiles(path.join(modulesDir, m, 'graphql', 'types'))),
    ...listResolverFiles(path.resolve(process.cwd(), 'extensions/wholesale/dist/graphql/types'))
  ];
  for (const file of files) {
    await import(pathToFileURL(file).href);
  }
}

/** Load the untyped compiled core schema builders (not part of the public exports). */
async function loadCoreBuilders(): Promise<CoreBuilders> {
  await prewarmResolverModules();
  const types = (await import(
    path.join(CORE_GRAPHQL_SERVICES, 'buildTypes.js')
  )) as Pick<CoreBuilders, 'buildTypeDefs'>;
  const resolvers = (await import(
    path.join(CORE_GRAPHQL_SERVICES, 'buildResolvers.js')
  )) as Pick<CoreBuilders, 'buildResolvers'>;
  return { ...types, ...resolvers };
}

type ResolverMap = Record<string, Record<string, unknown>>;

/**
 * The merged storefront schema (core + extension). `stub` may replace
 * resolvers that need data outside the fixture transaction (core services
 * that read through the module-level pool); it must never replace a field
 * the extension overrides, or the test would not exercise it.
 */
export async function buildStorefrontSchema(
  stub?: (resolvers: ResolverMap) => void
): Promise<GraphQLSchema> {
  const { buildTypeDefs, buildResolvers } = await loadCoreBuilders();
  const resolvers = (await buildResolvers(false)) as ResolverMap;
  stub?.(resolvers);
  return makeExecutableSchema({
    typeDefs: buildTypeDefs(false) as string,
    resolvers: resolvers as IResolvers
  });
}

export type Fixtures = {
  client: pg.PoolClient;
  insertCustomer(approved: boolean): Promise<Record<string, unknown>>;
  close(): Promise<void>;
};

/**
 * Opens a transaction (rolled back by `close`) with the extension migration
 * applied. The client is flagged `INTRANSACTION`: the core query builder
 * releases a PoolClient after each query otherwise.
 */
export async function openFixtures(): Promise<Fixtures> {
  const pool = new pg.Pool({
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT ?? 5432),
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    max: 1
  });
  const client = await pool.connect();
  await client.query('BEGIN');
  (client as pg.PoolClient & { INTRANSACTION?: boolean }).INTRANSACTION = true;
  await migrate(client);

  return {
    client,
    async insertCustomer(approved: boolean) {
      // Migration 1.1.1 (approval trigger): an approved row needs the approval write flag.
      const { rows } = await withApprovalWrite(client, () =>
        client.query(
          `INSERT INTO "customer" ("email", "password", "full_name", "is_wholesale_approved")
           VALUES ($1, 'x', 'Wholesale Masking Test', $2) RETURNING *`,
          [`wholesale-test-${randomUUID()}@example.com`, approved]
        )
      );
      const customer = rows[0] as Record<string, unknown>;
      delete customer.password;
      return customer;
    },
    async close() {
      await client.query('ROLLBACK');
      client.release();
      await pool.end();
    }
  };
}

/** Run a query; the first GraphQL error is thrown. */
export async function run<T>(
  schema: GraphQLSchema,
  source: string,
  contextValue: Record<string, unknown>,
  variableValues?: Record<string, unknown>
): Promise<T> {
  const result = await graphql({ schema, source, contextValue, variableValues });
  if (result.errors?.length) {
    throw result.errors[0];
  }
  return result.data as unknown as T;
}
