/**
 * Test harness for real concurrency (several sessions, committed rows): a
 * throw-away PostgreSQL database created next to the configured one, with
 * the minimal core tables the wholesale migrations and the quote services
 * touch, then migrations 1.0.0 … 1.1.2 applied. It is dropped (`WITH
 * (FORCE)`) by `close`, so nothing is ever committed to the configured
 * database.
 *
 * A separate database (not a schema) keeps `information_schema` clean: the
 * core query builder looks columns up by table name without a schema, so
 * same-named tables in another schema of the configured database would
 * break other suites running at the same time.
 *
 * Needs the CREATEDB privilege on the configured role.
 */
import 'dotenv/config';
import { randomBytes } from 'crypto';
import pg from 'pg';
import migrate100 from '../../../migration/Version-1.0.0.js';
import migrate110 from '../../../migration/Version-1.1.0.js';
import migrate111 from '../../../migration/Version-1.1.1.js';
import migrate112 from '../../../migration/Version-1.1.2.js';

/** `describe` when a database is configured, `describe.skip` otherwise. */
export const describeDb = process.env.DB_NAME ? describe : describe.skip;

const connectionConfig = (database: string | undefined) => ({
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT ?? 5432),
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database
});

/** Core tables (only the columns the wholesale migrations and quote services use). */
const CORE_DDL = [
  `CREATE TABLE "admin_user" (
     "admin_user_id" INT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
     "uuid" UUID NOT NULL DEFAULT gen_random_uuid(),
     "email" varchar NOT NULL
   )`,
  `CREATE TABLE "customer" (
     "customer_id" INT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
     "uuid" UUID NOT NULL DEFAULT gen_random_uuid() UNIQUE,
     "status" smallint NOT NULL DEFAULT 1,
     "group_id" INT DEFAULT 1,
     "email" varchar NOT NULL,
     "password" varchar NOT NULL,
     "full_name" varchar DEFAULT NULL,
     "created_at" timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
     "updated_at" timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP
   )`,
  `CREATE TABLE "product" (
     "product_id" INT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
     "uuid" UUID NOT NULL DEFAULT gen_random_uuid() UNIQUE,
     "sku" varchar NOT NULL UNIQUE,
     "price" numeric(12,4) NOT NULL DEFAULT 0,
     "weight" numeric(12,4) DEFAULT NULL,
     "status" boolean NOT NULL DEFAULT true
   )`,
  `CREATE TABLE "product_description" (
     "product_description_id" INT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
     "product_description_product_id" INT NOT NULL REFERENCES "product" ("product_id") ON DELETE CASCADE,
     "name" varchar NOT NULL,
     "url_key" varchar NOT NULL
   )`,
  `CREATE TABLE "cart" (
     "cart_id" INT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
     "uuid" UUID NOT NULL DEFAULT gen_random_uuid() UNIQUE,
     "customer_id" INT DEFAULT NULL,
     "status" boolean NOT NULL DEFAULT false
   )`,
  `CREATE TABLE "cart_item" (
     "cart_item_id" INT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
     "uuid" UUID NOT NULL DEFAULT gen_random_uuid() UNIQUE,
     "cart_id" INT NOT NULL REFERENCES "cart" ("cart_id") ON DELETE CASCADE,
     "product_id" INT NOT NULL REFERENCES "product" ("product_id") ON DELETE CASCADE,
     "product_sku" varchar NOT NULL,
     "qty" INT NOT NULL
   )`,
  `CREATE TABLE "order" (
     "order_id" INT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
     "uuid" UUID NOT NULL DEFAULT gen_random_uuid(),
     "created_at" timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP
   )`,
  `CREATE TABLE "order_item" (
     "order_item_id" INT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
     "order_item_order_id" INT DEFAULT NULL
   )`
];

export interface ScratchDatabase {
  /** Pool over the scratch database (`max` connections). */
  pool: pg.Pool;
  name: string;
  close(): Promise<void>;
}

export async function openScratchDatabase(max = 8): Promise<ScratchDatabase> {
  const name = `wholesale_test_${randomBytes(6).toString('hex')}`;
  const admin = new pg.Client(connectionConfig(process.env.DB_NAME));
  await admin.connect();
  try {
    await admin.query(`CREATE DATABASE "${name}"`);
  } finally {
    await admin.end();
  }

  const pool = new pg.Pool({ ...connectionConfig(name), max });
  const setup = await pool.connect();
  try {
    await setup.query('BEGIN');
    for (const ddl of CORE_DDL) {
      await setup.query(ddl);
    }
    for (const migrate of [migrate100, migrate110, migrate111, migrate112]) {
      await migrate(setup);
    }
    await setup.query('COMMIT');
  } catch (e) {
    await setup.query('ROLLBACK');
    throw e;
  } finally {
    setup.release();
  }

  return {
    pool,
    name,
    async close() {
      await pool.end();
      const dropper = new pg.Client(connectionConfig(process.env.DB_NAME));
      await dropper.connect();
      try {
        await dropper.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
      } finally {
        await dropper.end();
      }
    }
  };
}
