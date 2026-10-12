import { execute } from '@evershop/postgres-query-builder';
import type { PoolClient } from '@evershop/postgres-query-builder';

/**
 * Wholesale (B2B) schema.
 *
 * Every statement is idempotent (IF NOT EXISTS, guarded constraints,
 * CREATE OR REPLACE) so a partially applied run can simply be re-run.
 * The core migration runner wraps this function in a transaction and records
 * the version in the `migration` table; do not open BEGIN/COMMIT here.
 * Future schema changes go to Version-1.0.1.ts, never into this file.
 */
export default async (connection: PoolClient): Promise<void> => {
  // ---------------------------------------------------------------
  // 1. Extend the native "customer" table
  // ---------------------------------------------------------------
  await execute(
    connection,
    `ALTER TABLE "customer"
       ADD COLUMN IF NOT EXISTS "business_name" varchar(255) DEFAULT NULL,
       ADD COLUMN IF NOT EXISTS "tax_id" varchar(32) DEFAULT NULL,
       ADD COLUMN IF NOT EXISTS "phone" varchar(20) DEFAULT NULL,
       ADD COLUMN IF NOT EXISTS "is_wholesale_approved" boolean NOT NULL DEFAULT false,
       ADD COLUMN IF NOT EXISTS "wholesale_requested_at" timestamp with time zone DEFAULT NULL,
       ADD COLUMN IF NOT EXISTS "wholesale_approved_at" timestamp with time zone DEFAULT NULL,
       ADD COLUMN IF NOT EXISTS "wholesale_approved_by" INT DEFAULT NULL`
  );

  // WhatsApp number in E.164 (`+` and 8-15 digits, no leading zero).
  await execute(
    connection,
    `DO $$
     BEGIN
       IF NOT EXISTS (
         SELECT 1 FROM pg_constraint
         WHERE conname = 'CUSTOMER_PHONE_E164'
           AND conrelid = '"customer"'::regclass
       ) THEN
         ALTER TABLE "customer"
           ADD CONSTRAINT "CUSTOMER_PHONE_E164"
           CHECK ("phone" IS NULL OR "phone" ~ '^\\+[1-9][0-9]{7,14}$');
       END IF;
     END $$`
  );

  // One wholesale account per tax id.
  await execute(
    connection,
    `CREATE UNIQUE INDEX IF NOT EXISTS "CUSTOMER_TAX_ID_WHOLESALE_UNIQUE"
       ON "customer" ("tax_id")
       WHERE "tax_id" IS NOT NULL AND "wholesale_requested_at" IS NOT NULL`
  );

  // Admin grid: "pending wholesale approvals".
  await execute(
    connection,
    `CREATE INDEX IF NOT EXISTS "CUSTOMER_WHOLESALE_PENDING"
       ON "customer" ("wholesale_requested_at")
       WHERE "wholesale_requested_at" IS NOT NULL AND "is_wholesale_approved" = false`
  );

  // ---------------------------------------------------------------
  // 2. wholesale_product_rule
  // ---------------------------------------------------------------
  await execute(
    connection,
    `CREATE TABLE IF NOT EXISTS "wholesale_product_rule" (
       "wholesale_product_rule_id" INT GENERATED ALWAYS AS IDENTITY (START WITH 1 INCREMENT BY 1) PRIMARY KEY,
       "uuid" UUID NOT NULL DEFAULT gen_random_uuid(),
       "product_id" INT NOT NULL,
       "is_enabled" boolean NOT NULL DEFAULT true,
       "min_qty" INT NOT NULL DEFAULT 1,
       "step_qty" INT NOT NULL DEFAULT 1,
       "max_qty" INT DEFAULT NULL,
       "tiers" jsonb NOT NULL DEFAULT '[]'::jsonb,
       "created_at" timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
       "updated_at" timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
       CONSTRAINT "WHOLESALE_PRODUCT_RULE_UUID_UNIQUE" UNIQUE ("uuid"),
       CONSTRAINT "WHOLESALE_PRODUCT_RULE_PRODUCT_UNIQUE" UNIQUE ("product_id"),
       CONSTRAINT "FK_WHOLESALE_RULE_PRODUCT" FOREIGN KEY ("product_id")
         REFERENCES "product" ("product_id") ON DELETE CASCADE,
       CONSTRAINT "WHOLESALE_RULE_QTY_CHECK" CHECK (
         "min_qty" >= 1 AND "step_qty" >= 1
         AND ("max_qty" IS NULL OR "max_qty" >= "min_qty")
       ),
       CONSTRAINT "WHOLESALE_RULE_TIERS_ARRAY" CHECK (jsonb_typeof("tiers") = 'array')
     )`
  );

  await execute(
    connection,
    `CREATE INDEX IF NOT EXISTS "WHOLESALE_RULE_ENABLED"
       ON "wholesale_product_rule" ("product_id") WHERE "is_enabled" = true`
  );

  // ---------------------------------------------------------------
  // 3. wholesale_quote
  // ---------------------------------------------------------------
  await execute(
    connection,
    `CREATE TABLE IF NOT EXISTS "wholesale_quote" (
       "wholesale_quote_id" INT GENERATED ALWAYS AS IDENTITY (START WITH 1 INCREMENT BY 1) PRIMARY KEY,
       "uuid" UUID NOT NULL DEFAULT gen_random_uuid(),
       "quote_number" varchar(32) NOT NULL,
       "customer_id" INT NOT NULL,
       "tax_id" varchar(32) NOT NULL,
       "phone" varchar(20) NOT NULL,
       "request_ip" inet DEFAULT NULL,
       "idempotency_key" UUID NOT NULL,
       "reply_nonce" varchar(32) NOT NULL,
       "status" varchar(16) NOT NULL DEFAULT 'pending',
       "currency" varchar(3) NOT NULL,
       "sub_total" numeric(14,2) NOT NULL DEFAULT 0,
       "discount_total" numeric(14,2) NOT NULL DEFAULT 0,
       "grand_total" numeric(14,2) NOT NULL DEFAULT 0,
       "source_cart_id" INT DEFAULT NULL,
       "wa_message_id" varchar(128) DEFAULT NULL,
       "send_attempts" smallint NOT NULL DEFAULT 0,
       "last_error" text DEFAULT NULL,
       "order_id" INT DEFAULT NULL,
       "expires_at" timestamp with time zone NOT NULL,
       "sent_at" timestamp with time zone DEFAULT NULL,
       "replied_at" timestamp with time zone DEFAULT NULL,
       "created_at" timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
       "updated_at" timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
       CONSTRAINT "WHOLESALE_QUOTE_UUID_UNIQUE" UNIQUE ("uuid"),
       CONSTRAINT "WHOLESALE_QUOTE_NUMBER_UNIQUE" UNIQUE ("quote_number"),
       CONSTRAINT "WHOLESALE_QUOTE_IDEMPOTENCY_UNIQUE" UNIQUE ("customer_id", "idempotency_key"),
       CONSTRAINT "WHOLESALE_QUOTE_ORDER_UNIQUE" UNIQUE ("order_id"),
       CONSTRAINT "FK_WHOLESALE_QUOTE_CUSTOMER" FOREIGN KEY ("customer_id")
         REFERENCES "customer" ("customer_id") ON DELETE RESTRICT,
       CONSTRAINT "FK_WHOLESALE_QUOTE_ORDER" FOREIGN KEY ("order_id")
         REFERENCES "order" ("order_id") ON DELETE SET NULL,
       CONSTRAINT "WHOLESALE_QUOTE_STATUS_CHECK" CHECK (
         "status" IN ('pending', 'sent', 'accepted', 'rejected', 'expired', 'failed')
       )
     )`
  );

  // Rate limit windows (see security doc): customer, tax id, ip.
  await execute(
    connection,
    `CREATE INDEX IF NOT EXISTS "WHOLESALE_QUOTE_CUSTOMER_CREATED"
       ON "wholesale_quote" ("customer_id", "created_at" DESC)`
  );
  await execute(
    connection,
    `CREATE INDEX IF NOT EXISTS "WHOLESALE_QUOTE_TAX_ID_CREATED"
       ON "wholesale_quote" ("tax_id", "created_at" DESC)`
  );
  await execute(
    connection,
    `CREATE INDEX IF NOT EXISTS "WHOLESALE_QUOTE_IP_CREATED"
       ON "wholesale_quote" ("request_ip", "created_at" DESC)`
  );
  // Expiration cron.
  await execute(
    connection,
    `CREATE INDEX IF NOT EXISTS "WHOLESALE_QUOTE_OPEN_EXPIRES"
       ON "wholesale_quote" ("expires_at") WHERE "status" IN ('pending', 'sent')`
  );
  // Webhook lookup by outbound message id.
  await execute(
    connection,
    `CREATE INDEX IF NOT EXISTS "WHOLESALE_QUOTE_WA_MESSAGE"
       ON "wholesale_quote" ("wa_message_id") WHERE "wa_message_id" IS NOT NULL`
  );

  // ---------------------------------------------------------------
  // 4. wholesale_quote_item (price snapshot)
  // ---------------------------------------------------------------
  await execute(
    connection,
    `CREATE TABLE IF NOT EXISTS "wholesale_quote_item" (
       "wholesale_quote_item_id" INT GENERATED ALWAYS AS IDENTITY (START WITH 1 INCREMENT BY 1) PRIMARY KEY,
       "uuid" UUID NOT NULL DEFAULT gen_random_uuid(),
       "wholesale_quote_id" INT NOT NULL,
       "product_id" INT DEFAULT NULL,
       "product_sku" varchar NOT NULL,
       "product_name" varchar NOT NULL,
       "qty" INT NOT NULL,
       "unit_price" numeric(14,2) NOT NULL,
       "discount_percent" numeric(5,2) NOT NULL DEFAULT 0,
       "line_total" numeric(14,2) NOT NULL,
       "created_at" timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
       CONSTRAINT "WHOLESALE_QUOTE_ITEM_UUID_UNIQUE" UNIQUE ("uuid"),
       CONSTRAINT "FK_WHOLESALE_QUOTE_ITEM_QUOTE" FOREIGN KEY ("wholesale_quote_id")
         REFERENCES "wholesale_quote" ("wholesale_quote_id") ON DELETE CASCADE,
       CONSTRAINT "FK_WHOLESALE_QUOTE_ITEM_PRODUCT" FOREIGN KEY ("product_id")
         REFERENCES "product" ("product_id") ON DELETE SET NULL,
       CONSTRAINT "WHOLESALE_QUOTE_ITEM_QTY_CHECK" CHECK ("qty" > 0),
       CONSTRAINT "WHOLESALE_QUOTE_ITEM_DISCOUNT_CHECK" CHECK ("discount_percent" BETWEEN 0 AND 100)
     )`
  );
  await execute(
    connection,
    `CREATE INDEX IF NOT EXISTS "FK_WHOLESALE_QUOTE_ITEM_QUOTE"
       ON "wholesale_quote_item" ("wholesale_quote_id")`
  );

  // ---------------------------------------------------------------
  // 5. wholesale_webhook_event (dedup + audit of inbound Meta events)
  // ---------------------------------------------------------------
  await execute(
    connection,
    `CREATE TABLE IF NOT EXISTS "wholesale_webhook_event" (
       "wholesale_webhook_event_id" INT GENERATED ALWAYS AS IDENTITY (START WITH 1 INCREMENT BY 1) PRIMARY KEY,
       "uuid" UUID NOT NULL DEFAULT gen_random_uuid(),
       "external_id" varchar(128) NOT NULL,
       "event_type" varchar(32) NOT NULL,
       "wholesale_quote_id" INT DEFAULT NULL,
       "payload" jsonb NOT NULL,
       "processing_status" varchar(16) NOT NULL DEFAULT 'received',
       "error" text DEFAULT NULL,
       "created_at" timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
       "processed_at" timestamp with time zone DEFAULT NULL,
       CONSTRAINT "WHOLESALE_WEBHOOK_EVENT_EXTERNAL_UNIQUE" UNIQUE ("external_id"),
       CONSTRAINT "FK_WHOLESALE_WEBHOOK_QUOTE" FOREIGN KEY ("wholesale_quote_id")
         REFERENCES "wholesale_quote" ("wholesale_quote_id") ON DELETE SET NULL,
       CONSTRAINT "WHOLESALE_WEBHOOK_STATUS_CHECK" CHECK (
         "processing_status" IN ('received', 'processed', 'ignored', 'failed')
       )
     )`
  );

  // ---------------------------------------------------------------
  // 6. updated_at triggers
  // ---------------------------------------------------------------
  await execute(
    connection,
    `CREATE OR REPLACE FUNCTION wholesale_set_updated_at() RETURNS TRIGGER AS $$
     BEGIN
       NEW.updated_at = CURRENT_TIMESTAMP;
       RETURN NEW;
     END;
     $$ LANGUAGE plpgsql`
  );
  for (const table of ['wholesale_product_rule', 'wholesale_quote']) {
    await execute(
      connection,
      `DROP TRIGGER IF EXISTS "${table}_updated_at" ON "${table}";
       CREATE TRIGGER "${table}_updated_at"
         BEFORE UPDATE ON "${table}"
         FOR EACH ROW EXECUTE FUNCTION wholesale_set_updated_at()`
    );
  }
};
