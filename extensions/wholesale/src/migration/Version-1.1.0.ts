import { execute } from '@evershop/postgres-query-builder';
import type { PoolClient } from '@evershop/postgres-query-builder';

/**
 * Wholesale schema 1.1.0 (SDD v2.1, data model section 7): product lines and
 * tiers, per-product wholesale data, service lines and the SIFEN breakdown on
 * quotes, customer credit, managers and the immutable audit log, the channel
 * columns on the core cart/order (ADR-13), the wholesale order with
 * orthogonal payment status (ADR-14), fiscal issuer/sequences/SIFEN
 * documents, invoices, voidable payments and allocations (ADR-16), dispatch
 * with vehicles, drivers and remission notes (ADR-15), notifications and the
 * demo inbox/settings.
 *
 * Additive and idempotent: ADD COLUMN IF NOT EXISTS, CREATE TABLE/INDEX IF
 * NOT EXISTS, constraints on existing tables guarded by DO $$ blocks keyed on
 * conname + conrelid, CREATE OR REPLACE FUNCTION/VIEW, DROP TRIGGER IF EXISTS
 * + CREATE TRIGGER. The only non-additive statement relaxes
 * WHOLESALE_QUOTE_STATUS_CHECK to accept `awaiting_freight`, and it only runs
 * while the constraint does not accept that code yet, so a second run leaves
 * the schema untouched.
 *
 * The core runner wraps this function in a transaction and records the
 * version; do not open BEGIN/COMMIT here. Never edit this file once applied.
 */

/** Adds a constraint to an existing table unless it already exists. */
async function addConstraint(
  connection: PoolClient,
  table: string,
  name: string,
  definition: string
): Promise<void> {
  await execute(
    connection,
    `DO $$
     BEGIN
       IF NOT EXISTS (
         SELECT 1 FROM pg_constraint
         WHERE conname = '${name}' AND conrelid = '"${table}"'::regclass
       ) THEN
         ALTER TABLE "${table}" ADD CONSTRAINT "${name}" ${definition};
       END IF;
     END $$`
  );
}

/** Rejects every UPDATE and DELETE on the table (append-only). */
async function appendOnly(
  connection: PoolClient,
  table: string,
  functionName: string
): Promise<void> {
  await execute(
    connection,
    `CREATE OR REPLACE FUNCTION ${functionName}() RETURNS TRIGGER AS $$
     BEGIN
       RAISE EXCEPTION '${table} is append-only';
     END;
     $$ LANGUAGE plpgsql`
  );
  await execute(
    connection,
    `DROP TRIGGER IF EXISTS "${functionName}" ON "${table}";
     CREATE TRIGGER "${functionName}"
       BEFORE UPDATE OR DELETE ON "${table}"
       FOR EACH ROW EXECUTE FUNCTION ${functionName}()`
  );
}

/** SIFEN breakdown columns shared by quote (added), order and invoice. */
const SIFEN_BREAKDOWN_COLUMNS = [
  'd_sub_exe',
  'd_sub_5',
  'd_sub_10',
  'd_base_grav_5',
  'd_base_grav_10',
  'd_iva_5',
  'd_iva_10'
];

const TOTALS_CHECK = `CHECK (
  "d_tot_ope" = "d_sub_exe" + "d_sub_5" + "d_sub_10"
  AND "grand_total" = "d_tot_ope"
  AND "vat_total" = "d_iva_5" + "d_iva_10"
)`;

const VAT_RATES = `('10', '5', 'exempt')`;

export default async (connection: PoolClient): Promise<void> => {
  // ---------------------------------------------------------------
  // 1. Product lines and tiers (7.1, ADR-10)
  // ---------------------------------------------------------------
  await execute(
    connection,
    `CREATE TABLE IF NOT EXISTS "wholesale_product_line" (
       "wholesale_product_line_id" INT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
       "uuid" UUID NOT NULL DEFAULT gen_random_uuid(),
       "name" varchar(255) NOT NULL,
       "is_active" boolean NOT NULL DEFAULT true,
       "counts_toward_mix" boolean NOT NULL DEFAULT false,
       "created_at" timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
       "updated_at" timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
       CONSTRAINT "WHOLESALE_PRODUCT_LINE_UUID_UNIQUE" UNIQUE ("uuid")
     )`
  );
  await execute(
    connection,
    `CREATE UNIQUE INDEX IF NOT EXISTS "WHOLESALE_PRODUCT_LINE_NAME_UNIQUE"
       ON "wholesale_product_line" (lower("name"))`
  );
  await execute(
    connection,
    `CREATE TABLE IF NOT EXISTS "wholesale_product_line_tier" (
       "wholesale_product_line_tier_id" INT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
       "wholesale_product_line_id" INT NOT NULL,
       "from_qty" INT NOT NULL,
       "discount_percent" numeric(5,2) NOT NULL,
       "label" varchar(64) DEFAULT NULL,
       CONSTRAINT "WHOLESALE_LINE_TIER_UNIQUE" UNIQUE ("wholesale_product_line_id", "from_qty"),
       CONSTRAINT "FK_WHOLESALE_LINE_TIER_LINE" FOREIGN KEY ("wholesale_product_line_id")
         REFERENCES "wholesale_product_line" ("wholesale_product_line_id") ON DELETE CASCADE,
       CONSTRAINT "WHOLESALE_LINE_TIER_CHECK"
         CHECK ("from_qty" >= 1 AND "discount_percent" BETWEEN 0 AND 100)
     )`
  );

  // ---------------------------------------------------------------
  // 2. Per-product wholesale data (7.2)
  // ---------------------------------------------------------------
  await execute(
    connection,
    `ALTER TABLE "wholesale_product_rule"
       ADD COLUMN IF NOT EXISTS "wholesale_product_line_id" INT DEFAULT NULL,
       ADD COLUMN IF NOT EXISTS "base_price" numeric(14,2) DEFAULT NULL,
       ADD COLUMN IF NOT EXISTS "vat_rate" varchar(8) NOT NULL DEFAULT '10',
       ADD COLUMN IF NOT EXISTS "is_critical_consumable" boolean NOT NULL DEFAULT false`
  );
  await addConstraint(
    connection,
    'wholesale_product_rule',
    'FK_WHOLESALE_RULE_LINE',
    `FOREIGN KEY ("wholesale_product_line_id")
       REFERENCES "wholesale_product_line" ("wholesale_product_line_id") ON DELETE RESTRICT`
  );
  await addConstraint(
    connection,
    'wholesale_product_rule',
    'WHOLESALE_RULE_VAT_RATE_CHECK',
    `CHECK ("vat_rate" IN ${VAT_RATES})`
  );
  await addConstraint(
    connection,
    'wholesale_product_rule',
    'WHOLESALE_RULE_BASE_PRICE_CHECK',
    `CHECK ("base_price" IS NULL OR "base_price" > 0)`
  );
  await execute(
    connection,
    `CREATE INDEX IF NOT EXISTS "WHOLESALE_RULE_LINE"
       ON "wholesale_product_rule" ("wholesale_product_line_id")`
  );
  await execute(
    connection,
    `COMMENT ON COLUMN "wholesale_product_rule"."tiers"
       IS 'Deprecated since 1.1.0: tiers live in wholesale_product_line_tier'`
  );

  // ---------------------------------------------------------------
  // 3. Quote: service lines, VAT, SIFEN breakdown, weight, mix (7.3)
  // ---------------------------------------------------------------
  await execute(
    connection,
    `ALTER TABLE "wholesale_quote"
       ADD COLUMN IF NOT EXISTS "net_total" numeric(14,2) NOT NULL DEFAULT 0,
       ADD COLUMN IF NOT EXISTS "freight_amount" numeric(14,2) NOT NULL DEFAULT 0,
       ADD COLUMN IF NOT EXISTS "vat_total" numeric(14,2) NOT NULL DEFAULT 0,
       ${SIFEN_BREAKDOWN_COLUMNS.map(
         (c) => `ADD COLUMN IF NOT EXISTS "${c}" numeric(14,2) NOT NULL DEFAULT 0`
       ).join(',\n       ')},
       ADD COLUMN IF NOT EXISTS "d_tot_ope" numeric(14,2) NOT NULL DEFAULT 0,
       ADD COLUMN IF NOT EXISTS "total_weight" numeric(14,4) DEFAULT NULL,
       ADD COLUMN IF NOT EXISTS "freight_label" varchar(16) NOT NULL DEFAULT 'special',
       ADD COLUMN IF NOT EXISTS "freight_set_by" INT DEFAULT NULL,
       ADD COLUMN IF NOT EXISTS "freight_set_at" timestamp with time zone DEFAULT NULL,
       ADD COLUMN IF NOT EXISTS "mix_rule_applied" boolean NOT NULL DEFAULT false`
  );
  await addConstraint(
    connection,
    'wholesale_quote',
    'WHOLESALE_QUOTE_FREIGHT_LABEL_CHECK',
    `CHECK ("freight_label" IN ('free', 'special'))`
  );
  // A 1.0.0 quote with grand_total but no breakdown would violate the check
  // on its next UPDATE (status change), so the migration refuses to run
  // instead of adding a NOT VALID check: such rows must be fixed or deleted
  // by hand first. Skipped once the check exists (every row satisfies it).
  await execute(
    connection,
    `DO $$
     DECLARE
       legacy integer;
     BEGIN
       IF NOT EXISTS (
         SELECT 1 FROM pg_constraint
         WHERE conname = 'WHOLESALE_QUOTE_TOTALS_CHECK'
           AND conrelid = '"wholesale_quote"'::regclass
       ) THEN
         SELECT count(*) INTO legacy FROM "wholesale_quote"
         WHERE NOT (
           "d_tot_ope" = "d_sub_exe" + "d_sub_5" + "d_sub_10"
           AND "grand_total" = "d_tot_ope"
           AND "vat_total" = "d_iva_5" + "d_iva_10"
         );
         IF legacy > 0 THEN
           RAISE EXCEPTION 'wholesale 1.1.0: % quote(s) carry totals without the SIFEN breakdown; fix or delete them before migrating', legacy;
         END IF;
       END IF;
     END $$`
  );
  await addConstraint(connection, 'wholesale_quote', 'WHOLESALE_QUOTE_TOTALS_CHECK', TOTALS_CHECK);
  // The single relaxation (ADR-14): accept `awaiting_freight` (16 chars, fits
  // varchar(16)). Skipped once the constraint already accepts it.
  await execute(
    connection,
    `DO $$
     BEGIN
       IF NOT EXISTS (
         SELECT 1 FROM pg_constraint
         WHERE conname = 'WHOLESALE_QUOTE_STATUS_CHECK'
           AND conrelid = '"wholesale_quote"'::regclass
           AND pg_get_constraintdef(oid) LIKE '%awaiting_freight%'
       ) THEN
         ALTER TABLE "wholesale_quote" DROP CONSTRAINT IF EXISTS "WHOLESALE_QUOTE_STATUS_CHECK";
         ALTER TABLE "wholesale_quote" ADD CONSTRAINT "WHOLESALE_QUOTE_STATUS_CHECK"
           CHECK ("status" IN ('pending', 'awaiting_freight', 'sent', 'accepted',
                               'rejected', 'expired', 'failed'));
       END IF;
     END $$`
  );

  await execute(
    connection,
    `ALTER TABLE "wholesale_quote_item"
       ADD COLUMN IF NOT EXISTS "line_type" varchar(8) NOT NULL DEFAULT 'product',
       ADD COLUMN IF NOT EXISTS "service_code" varchar(32) DEFAULT NULL,
       ADD COLUMN IF NOT EXISTS "wholesale_product_line_id" INT DEFAULT NULL,
       ADD COLUMN IF NOT EXISTS "product_line_name" varchar(255) DEFAULT NULL,
       ADD COLUMN IF NOT EXISTS "tier_label" varchar(64) DEFAULT NULL,
       ADD COLUMN IF NOT EXISTS "is_critical_consumable" boolean NOT NULL DEFAULT false,
       ADD COLUMN IF NOT EXISTS "mix_rule_applied" boolean NOT NULL DEFAULT false,
       ADD COLUMN IF NOT EXISTS "vat_rate" varchar(8) NOT NULL DEFAULT '10',
       ADD COLUMN IF NOT EXISTS "vat_amount" numeric(14,2) NOT NULL DEFAULT 0,
       ADD COLUMN IF NOT EXISTS "unit_weight" numeric(14,4) DEFAULT NULL`
  );
  await addConstraint(
    connection,
    'wholesale_quote_item',
    'WHOLESALE_QUOTE_ITEM_LINE_TYPE_CHECK',
    `CHECK ("line_type" IN ('product', 'service'))`
  );
  await addConstraint(
    connection,
    'wholesale_quote_item',
    'WHOLESALE_QUOTE_ITEM_SERVICE_CODE_CHECK',
    `CHECK (("line_type" = 'service') = ("service_code" IS NOT NULL))`
  );
  await addConstraint(
    connection,
    'wholesale_quote_item',
    'WHOLESALE_QUOTE_ITEM_VAT_RATE_CHECK',
    `CHECK ("vat_rate" IN ${VAT_RATES})`
  );
  await addConstraint(
    connection,
    'wholesale_quote_item',
    'FK_WHOLESALE_QUOTE_ITEM_LINE',
    `FOREIGN KEY ("wholesale_product_line_id")
       REFERENCES "wholesale_product_line" ("wholesale_product_line_id") ON DELETE SET NULL`
  );
  await execute(
    connection,
    `CREATE UNIQUE INDEX IF NOT EXISTS "WHOLESALE_QUOTE_ITEM_ONE_FREIGHT"
       ON "wholesale_quote_item" ("wholesale_quote_id")
       WHERE "service_code" = 'FLETE_LOGISTICA'`
  );

  // ---------------------------------------------------------------
  // 4. Customer credit (7.4) + backfill of customers approved under 1.0.0
  // ---------------------------------------------------------------
  await execute(
    connection,
    `CREATE TABLE IF NOT EXISTS "wholesale_customer_credit" (
       "customer_id" INT PRIMARY KEY,
       "credit_limit" numeric(14,2) NOT NULL DEFAULT 0,
       "payment_term_days" INT NOT NULL DEFAULT 30,
       "manual_block" boolean NOT NULL DEFAULT false,
       "manual_block_reason" text DEFAULT NULL,
       "updated_by" INT DEFAULT NULL,
       "created_at" timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
       "updated_at" timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
       CONSTRAINT "FK_WHOLESALE_CREDIT_CUSTOMER" FOREIGN KEY ("customer_id")
         REFERENCES "customer" ("customer_id") ON DELETE RESTRICT,
       CONSTRAINT "WHOLESALE_CREDIT_CHECK"
         CHECK ("credit_limit" >= 0 AND "payment_term_days" BETWEEN 0 AND 365)
     )`
  );
  await execute(
    connection,
    `INSERT INTO "wholesale_customer_credit" ("customer_id")
     SELECT "customer_id" FROM "customer" WHERE "is_wholesale_approved" = true
     ON CONFLICT ("customer_id") DO NOTHING`
  );

  // ---------------------------------------------------------------
  // 5. Managers and immutable audit log (7.5, ADR-11)
  // ---------------------------------------------------------------
  await execute(
    connection,
    `CREATE TABLE IF NOT EXISTS "wholesale_admin_profile" (
       "admin_user_id" INT PRIMARY KEY,
       "is_manager" boolean NOT NULL DEFAULT false,
       "updated_by" INT DEFAULT NULL,
       "updated_at" timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
       CONSTRAINT "FK_WHOLESALE_ADMIN_PROFILE_USER" FOREIGN KEY ("admin_user_id")
         REFERENCES "admin_user" ("admin_user_id") ON DELETE CASCADE
     )`
  );
  await execute(
    connection,
    `CREATE TABLE IF NOT EXISTS "wholesale_audit_log" (
       "wholesale_audit_log_id" BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
       "uuid" UUID NOT NULL DEFAULT gen_random_uuid(),
       "actor_type" varchar(16) NOT NULL,
       "admin_user_id" INT DEFAULT NULL,
       "admin_email" varchar DEFAULT NULL,
       "action" varchar(64) NOT NULL,
       "entity_type" varchar(32) NOT NULL,
       "entity_uuid" UUID DEFAULT NULL,
       "before" jsonb DEFAULT NULL,
       "after" jsonb DEFAULT NULL,
       "reason" text DEFAULT NULL,
       "created_at" timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
       CONSTRAINT "WHOLESALE_AUDIT_LOG_UUID_UNIQUE" UNIQUE ("uuid"),
       CONSTRAINT "WHOLESALE_AUDIT_ACTOR_TYPE_CHECK"
         CHECK ("actor_type" IN ('admin', 'system', 'customer'))
     )`
  );
  await execute(
    connection,
    `CREATE INDEX IF NOT EXISTS "WHOLESALE_AUDIT_ENTITY"
       ON "wholesale_audit_log" ("entity_type", "entity_uuid", "created_at" DESC)`
  );
  await appendOnly(connection, 'wholesale_audit_log', 'wholesale_audit_log_immutable');

  // ---------------------------------------------------------------
  // 6. Channel on the core cart and order (7.10, ADR-13)
  // ---------------------------------------------------------------
  for (const table of ['cart', 'order']) {
    await execute(
      connection,
      `ALTER TABLE "${table}"
         ADD COLUMN IF NOT EXISTS "channel" varchar(8) NOT NULL DEFAULT 'b2c',
         ADD COLUMN IF NOT EXISTS "wholesale_quote_id" INT DEFAULT NULL`
    );
    await addConstraint(
      connection,
      table,
      `${table.toUpperCase()}_CHANNEL_CHECK`,
      `CHECK ("channel" IN ('b2c', 'b2b'))`
    );
  }
  await addConstraint(
    connection,
    'order',
    'FK_ORDER_WHOLESALE_QUOTE',
    `FOREIGN KEY ("wholesale_quote_id")
       REFERENCES "wholesale_quote" ("wholesale_quote_id") ON DELETE RESTRICT`
  );
  await execute(
    connection,
    `CREATE INDEX IF NOT EXISTS "ORDER_CHANNEL_CREATED" ON "order" ("channel", "created_at")`
  );

  // ---------------------------------------------------------------
  // 7. Wholesale order (7.6, ADR-13, ADR-14)
  // ---------------------------------------------------------------
  await execute(
    connection,
    `CREATE TABLE IF NOT EXISTS "wholesale_order" (
       "wholesale_order_id" INT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
       "uuid" UUID NOT NULL DEFAULT gen_random_uuid(),
       "order_id" INT NOT NULL,
       "wholesale_quote_id" INT NOT NULL,
       "customer_id" INT NOT NULL,
       "status" varchar(24) NOT NULL DEFAULT 'order_confirmed',
       "payment_status" varchar(16) NOT NULL DEFAULT 'pending',
       "payment_method" varchar(16) DEFAULT NULL,
       "net_total" numeric(14,2) NOT NULL,
       "freight_amount" numeric(14,2) NOT NULL DEFAULT 0,
       "vat_total" numeric(14,2) NOT NULL,
       ${SIFEN_BREAKDOWN_COLUMNS.map((c) => `"${c}" numeric(14,2) NOT NULL DEFAULT 0`).join(
         ',\n       '
       )},
       "d_tot_ope" numeric(14,2) NOT NULL,
       "grand_total" numeric(14,2) NOT NULL,
       "payment_due_at" timestamp with time zone NOT NULL,
       "extension_count" smallint NOT NULL DEFAULT 0,
       "credit_check" jsonb DEFAULT NULL,
       "overdue_bypass_by" INT DEFAULT NULL,
       "overdue_bypass_at" timestamp with time zone DEFAULT NULL,
       "executed_by" INT DEFAULT NULL,
       "executed_at" timestamp with time zone DEFAULT NULL,
       "cancelled_by" INT DEFAULT NULL,
       "cancelled_at" timestamp with time zone DEFAULT NULL,
       "cancel_reason" text DEFAULT NULL,
       "last_error" text DEFAULT NULL,
       "created_at" timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
       "updated_at" timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
       CONSTRAINT "WHOLESALE_ORDER_UUID_UNIQUE" UNIQUE ("uuid"),
       CONSTRAINT "WHOLESALE_ORDER_ORDER_UNIQUE" UNIQUE ("order_id"),
       CONSTRAINT "WHOLESALE_ORDER_QUOTE_UNIQUE" UNIQUE ("wholesale_quote_id"),
       CONSTRAINT "FK_WHOLESALE_ORDER_ORDER" FOREIGN KEY ("order_id")
         REFERENCES "order" ("order_id") ON DELETE RESTRICT,
       CONSTRAINT "FK_WHOLESALE_ORDER_QUOTE" FOREIGN KEY ("wholesale_quote_id")
         REFERENCES "wholesale_quote" ("wholesale_quote_id") ON DELETE RESTRICT,
       CONSTRAINT "FK_WHOLESALE_ORDER_CUSTOMER" FOREIGN KEY ("customer_id")
         REFERENCES "customer" ("customer_id") ON DELETE RESTRICT,
       CONSTRAINT "WHOLESALE_ORDER_STATUS_CHECK" CHECK ("status" IN
         ('order_confirmed', 'expired', 'cancelled', 'pending_invoicing', 'sifen_invoiced',
          'partially_dispatched', 'dispatched')),
       CONSTRAINT "WHOLESALE_ORDER_PAYMENT_STATUS_CHECK" CHECK ("payment_status" IN
         ('pending', 'unpaid', 'partially_paid', 'paid')),
       CONSTRAINT "WHOLESALE_ORDER_PAYMENT_METHOD_CHECK" CHECK ("payment_method" IS NULL
         OR "payment_method" IN ('credit', 'cash', 'bank_transfer', 'cheque')),
       CONSTRAINT "WHOLESALE_ORDER_FREIGHT_CHECK" CHECK ("freight_amount" >= 0),
       CONSTRAINT "WHOLESALE_ORDER_TOTALS_CHECK" ${TOTALS_CHECK}
     )`
  );
  await execute(
    connection,
    `CREATE INDEX IF NOT EXISTS "WHOLESALE_ORDER_DUE"
       ON "wholesale_order" ("payment_due_at") WHERE "status" = 'order_confirmed'`
  );
  await execute(
    connection,
    `CREATE INDEX IF NOT EXISTS "WHOLESALE_ORDER_CUSTOMER_STATUS"
       ON "wholesale_order" ("customer_id", "status")`
  );

  // ---------------------------------------------------------------
  // 8. Fiscal issuer, numbering and SIFEN documents (7.7)
  // ---------------------------------------------------------------
  await execute(
    connection,
    `CREATE TABLE IF NOT EXISTS "wholesale_fiscal_issuer" (
       "wholesale_fiscal_issuer_id" INT PRIMARY KEY DEFAULT 1,
       "ruc" varchar(16) NOT NULL,
       "ruc_dv" varchar(1) NOT NULL,
       "business_name" varchar(255) NOT NULL,
       "timbrado_number" varchar(16) NOT NULL,
       "timbrado_valid_from" date NOT NULL,
       "establishment" char(3) NOT NULL,
       "expedition_point" char(3) NOT NULL,
       "address" text NOT NULL,
       "activity_code" varchar(16) NOT NULL,
       "dispatch_origin_address" text DEFAULT NULL,
       "updated_by" INT DEFAULT NULL,
       "updated_at" timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
       CONSTRAINT "WHOLESALE_FISCAL_ISSUER_SINGLE_ROW" CHECK ("wholesale_fiscal_issuer_id" = 1)
     )`
  );
  await execute(
    connection,
    `CREATE TABLE IF NOT EXISTS "wholesale_fiscal_sequence" (
       "establishment" char(3) NOT NULL,
       "expedition_point" char(3) NOT NULL,
       "document_type" varchar(16) NOT NULL,
       "next_number" INT NOT NULL DEFAULT 1,
       PRIMARY KEY ("establishment", "expedition_point", "document_type"),
       CONSTRAINT "WHOLESALE_FISCAL_SEQUENCE_TYPE_CHECK"
         CHECK ("document_type" IN ('invoice', 'remission_note')),
       CONSTRAINT "WHOLESALE_FISCAL_SEQUENCE_NUMBER_CHECK" CHECK ("next_number" >= 1)
     )`
  );
  // FK to wholesale_remission_note is added in block 10, once that table exists.
  await execute(
    connection,
    `CREATE TABLE IF NOT EXISTS "wholesale_sifen_document" (
       "wholesale_sifen_document_id" INT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
       "uuid" UUID NOT NULL DEFAULT gen_random_uuid(),
       "document_type" varchar(16) NOT NULL,
       "wholesale_order_id" INT NOT NULL,
       "wholesale_remission_note_id" INT DEFAULT NULL,
       "attempt_no" smallint NOT NULL,
       "document_number" varchar(32) NOT NULL,
       "cdc" varchar(44) NOT NULL,
       "environment" varchar(16) NOT NULL,
       "request_xml" text DEFAULT NULL,
       "response_code" varchar(8) DEFAULT NULL,
       "response_message" text DEFAULT NULL,
       "protocol" varchar(32) DEFAULT NULL,
       "status" varchar(16) NOT NULL,
       "created_at" timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
       CONSTRAINT "WHOLESALE_SIFEN_DOCUMENT_UUID_UNIQUE" UNIQUE ("uuid"),
       CONSTRAINT "FK_WHOLESALE_SIFEN_DOCUMENT_ORDER" FOREIGN KEY ("wholesale_order_id")
         REFERENCES "wholesale_order" ("wholesale_order_id") ON DELETE RESTRICT,
       CONSTRAINT "WHOLESALE_SIFEN_DOCUMENT_TYPE_CHECK"
         CHECK ("document_type" IN ('invoice', 'remission_note')),
       CONSTRAINT "WHOLESALE_SIFEN_DOCUMENT_REMISSION_CHECK"
         CHECK (("document_type" = 'remission_note') = ("wholesale_remission_note_id" IS NOT NULL)),
       CONSTRAINT "WHOLESALE_SIFEN_DOCUMENT_ENVIRONMENT_CHECK"
         CHECK ("environment" IN ('mock', 'test', 'production')),
       CONSTRAINT "WHOLESALE_SIFEN_DOCUMENT_STATUS_CHECK"
         CHECK ("status" IN ('approved', 'rejected', 'error'))
     )`
  );
  await execute(
    connection,
    `CREATE UNIQUE INDEX IF NOT EXISTS "WHOLESALE_SIFEN_ONE_APPROVED_INVOICE"
       ON "wholesale_sifen_document" ("wholesale_order_id")
       WHERE "document_type" = 'invoice' AND "status" = 'approved'`
  );
  await execute(
    connection,
    `CREATE UNIQUE INDEX IF NOT EXISTS "WHOLESALE_SIFEN_ONE_APPROVED_REMISSION"
       ON "wholesale_sifen_document" ("wholesale_remission_note_id")
       WHERE "document_type" = 'remission_note' AND "status" = 'approved'`
  );
  await execute(
    connection,
    `CREATE INDEX IF NOT EXISTS "WHOLESALE_SIFEN_DOCUMENT_ORDER"
       ON "wholesale_sifen_document" ("wholesale_order_id")`
  );

  // ---------------------------------------------------------------
  // 9. Invoices, payments and allocations (7.8, ADR-09, ADR-16)
  // ---------------------------------------------------------------
  await execute(
    connection,
    `CREATE TABLE IF NOT EXISTS "wholesale_invoice" (
       "wholesale_invoice_id" INT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
       "uuid" UUID NOT NULL DEFAULT gen_random_uuid(),
       "customer_id" INT NOT NULL,
       "wholesale_order_id" INT DEFAULT NULL,
       "wholesale_sifen_document_id" INT DEFAULT NULL,
       "source" varchar(16) NOT NULL,
       "condition" varchar(8) NOT NULL,
       "invoice_number" varchar(32) NOT NULL,
       "issue_date" date NOT NULL,
       "due_date" date DEFAULT NULL,
       "payment_term_days" INT DEFAULT NULL,
       "currency" varchar(3) NOT NULL,
       "net_total" numeric(14,2) NOT NULL,
       "vat_total" numeric(14,2) NOT NULL DEFAULT 0,
       "grand_total" numeric(14,2) NOT NULL,
       ${SIFEN_BREAKDOWN_COLUMNS.map((c) => `"${c}" numeric(14,2) NOT NULL DEFAULT 0`).join(
         ',\n       '
       )},
       "d_tot_ope" numeric(14,2) NOT NULL,
       "created_by" INT DEFAULT NULL,
       "created_at" timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
       CONSTRAINT "WHOLESALE_INVOICE_UUID_UNIQUE" UNIQUE ("uuid"),
       CONSTRAINT "WHOLESALE_INVOICE_NUMBER_UNIQUE" UNIQUE ("customer_id", "source", "invoice_number"),
       CONSTRAINT "WHOLESALE_INVOICE_ORDER_UNIQUE" UNIQUE ("wholesale_order_id"),
       CONSTRAINT "FK_WHOLESALE_INVOICE_CUSTOMER" FOREIGN KEY ("customer_id")
         REFERENCES "customer" ("customer_id") ON DELETE RESTRICT,
       CONSTRAINT "FK_WHOLESALE_INVOICE_ORDER" FOREIGN KEY ("wholesale_order_id")
         REFERENCES "wholesale_order" ("wholesale_order_id") ON DELETE RESTRICT,
       CONSTRAINT "WHOLESALE_INVOICE_SOURCE_CHECK" CHECK ("source" IN ('sifen', 'opening')),
       CONSTRAINT "WHOLESALE_INVOICE_CONDITION_CHECK" CHECK ("condition" IN ('cash', 'credit')),
       CONSTRAINT "WHOLESALE_INVOICE_CREDIT_DUE" CHECK ("condition" <> 'credit' OR "due_date" IS NOT NULL),
       CONSTRAINT "WHOLESALE_INVOICE_DUE_AFTER_ISSUE" CHECK ("due_date" IS NULL OR "due_date" >= "issue_date"),
       CONSTRAINT "WHOLESALE_INVOICE_TOTAL_CHECK" CHECK ("grand_total" > 0),
       CONSTRAINT "WHOLESALE_INVOICE_TOTALS_CHECK" ${TOTALS_CHECK}
     )`
  );
  await execute(
    connection,
    `CREATE INDEX IF NOT EXISTS "WHOLESALE_INVOICE_CUSTOMER_DUE"
       ON "wholesale_invoice" ("customer_id", "due_date") WHERE "condition" = 'credit'`
  );
  await execute(
    connection,
    `CREATE TABLE IF NOT EXISTS "wholesale_invoice_item" (
       "wholesale_invoice_item_id" INT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
       "wholesale_invoice_id" INT NOT NULL,
       "line_no" smallint NOT NULL,
       "line_type" varchar(8) NOT NULL DEFAULT 'product',
       "service_code" varchar(32) DEFAULT NULL,
       "product_sku" varchar NOT NULL,
       "description" varchar NOT NULL,
       "qty" numeric(14,4) NOT NULL,
       "unit_price" numeric(14,2) NOT NULL,
       "discount_percent" numeric(5,2) NOT NULL DEFAULT 0,
       "vat_rate" varchar(8) NOT NULL DEFAULT '10',
       "taxable_base" numeric(14,2) NOT NULL,
       "vat_amount" numeric(14,2) NOT NULL DEFAULT 0,
       "line_total" numeric(14,2) NOT NULL,
       CONSTRAINT "WHOLESALE_INVOICE_ITEM_LINE_UNIQUE" UNIQUE ("wholesale_invoice_id", "line_no"),
       CONSTRAINT "FK_WHOLESALE_INVOICE_ITEM_INVOICE" FOREIGN KEY ("wholesale_invoice_id")
         REFERENCES "wholesale_invoice" ("wholesale_invoice_id") ON DELETE CASCADE,
       CONSTRAINT "WHOLESALE_INVOICE_ITEM_LINE_TYPE_CHECK" CHECK ("line_type" IN ('product', 'service')),
       CONSTRAINT "WHOLESALE_INVOICE_ITEM_SERVICE_CODE_CHECK"
         CHECK (("line_type" = 'service') = ("service_code" IS NOT NULL)),
       CONSTRAINT "WHOLESALE_INVOICE_ITEM_VAT_RATE_CHECK" CHECK ("vat_rate" IN ${VAT_RATES}),
       CONSTRAINT "WHOLESALE_INVOICE_ITEM_QTY_CHECK" CHECK ("qty" > 0)
     )`
  );

  await execute(
    connection,
    `CREATE TABLE IF NOT EXISTS "wholesale_payment" (
       "wholesale_payment_id" INT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
       "uuid" UUID NOT NULL DEFAULT gen_random_uuid(),
       "customer_id" INT NOT NULL,
       "amount" numeric(14,2) NOT NULL,
       "method" varchar(16) NOT NULL,
       "reference" varchar(255) DEFAULT NULL,
       "received_at" date NOT NULL,
       "note" text DEFAULT NULL,
       "wholesale_order_id" INT DEFAULT NULL,
       "recorded_by" INT DEFAULT NULL,
       "created_at" timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
       "voided_at" timestamp with time zone DEFAULT NULL,
       "voided_by" INT DEFAULT NULL,
       "void_reason" text DEFAULT NULL,
       CONSTRAINT "WHOLESALE_PAYMENT_UUID_UNIQUE" UNIQUE ("uuid"),
       CONSTRAINT "FK_WHOLESALE_PAYMENT_CUSTOMER" FOREIGN KEY ("customer_id")
         REFERENCES "customer" ("customer_id") ON DELETE RESTRICT,
       CONSTRAINT "FK_WHOLESALE_PAYMENT_ORDER" FOREIGN KEY ("wholesale_order_id")
         REFERENCES "wholesale_order" ("wholesale_order_id") ON DELETE RESTRICT,
       CONSTRAINT "WHOLESALE_PAYMENT_AMOUNT_CHECK" CHECK ("amount" > 0),
       CONSTRAINT "WHOLESALE_PAYMENT_METHOD_CHECK" CHECK ("method" IN ('cash', 'bank_transfer', 'cheque')),
       CONSTRAINT "WHOLESALE_PAYMENT_VOID_CHECK" CHECK (
         ("voided_at" IS NULL AND "voided_by" IS NULL AND "void_reason" IS NULL)
         OR ("voided_at" IS NOT NULL AND "voided_by" IS NOT NULL
             AND "void_reason" IS NOT NULL AND btrim("void_reason") <> '')
       )
     )`
  );
  await execute(
    connection,
    `CREATE INDEX IF NOT EXISTS "WHOLESALE_PAYMENT_CUSTOMER"
       ON "wholesale_payment" ("customer_id", "received_at")`
  );
  // ADR-16: payments are never edited nor deleted; the only UPDATE allowed
  // sets voided_at, voided_by and a non-empty void_reason together, once.
  await execute(
    connection,
    `CREATE OR REPLACE FUNCTION wholesale_payment_void_only() RETURNS TRIGGER AS $$
     BEGIN
       IF TG_OP = 'DELETE' THEN
         RAISE EXCEPTION 'wholesale_payment rows cannot be deleted; void them instead';
       END IF;
       IF OLD.voided_at IS NOT NULL THEN
         RAISE EXCEPTION 'wholesale_payment % is already voided', OLD.uuid;
       END IF;
       IF NEW.voided_at IS NULL OR NEW.voided_by IS NULL
          OR NEW.void_reason IS NULL OR btrim(NEW.void_reason) = '' THEN
         RAISE EXCEPTION 'wholesale_payment can only be updated to void it (voided_at, voided_by and a non-empty void_reason together)';
       END IF;
       IF (to_jsonb(NEW) - 'voided_at' - 'voided_by' - 'void_reason')
          IS DISTINCT FROM (to_jsonb(OLD) - 'voided_at' - 'voided_by' - 'void_reason') THEN
         RAISE EXCEPTION 'wholesale_payment fields other than the void fields are immutable';
       END IF;
       RETURN NEW;
     END;
     $$ LANGUAGE plpgsql`
  );
  await execute(
    connection,
    `DROP TRIGGER IF EXISTS "wholesale_payment_void_only" ON "wholesale_payment";
     CREATE TRIGGER "wholesale_payment_void_only"
       BEFORE UPDATE OR DELETE ON "wholesale_payment"
       FOR EACH ROW EXECUTE FUNCTION wholesale_payment_void_only()`
  );

  await execute(
    connection,
    `CREATE TABLE IF NOT EXISTS "wholesale_payment_allocation" (
       "wholesale_payment_allocation_id" INT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
       "wholesale_payment_id" INT NOT NULL,
       "wholesale_invoice_id" INT NOT NULL,
       "amount" numeric(14,2) NOT NULL,
       "created_at" timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
       CONSTRAINT "WHOLESALE_PAYMENT_ALLOCATION_UNIQUE"
         UNIQUE ("wholesale_payment_id", "wholesale_invoice_id"),
       CONSTRAINT "FK_WHOLESALE_ALLOCATION_PAYMENT" FOREIGN KEY ("wholesale_payment_id")
         REFERENCES "wholesale_payment" ("wholesale_payment_id") ON DELETE RESTRICT,
       CONSTRAINT "FK_WHOLESALE_ALLOCATION_INVOICE" FOREIGN KEY ("wholesale_invoice_id")
         REFERENCES "wholesale_invoice" ("wholesale_invoice_id") ON DELETE RESTRICT,
       CONSTRAINT "WHOLESALE_PAYMENT_ALLOCATION_AMOUNT_CHECK" CHECK ("amount" > 0)
     )`
  );
  await execute(
    connection,
    `CREATE INDEX IF NOT EXISTS "WHOLESALE_ALLOCATION_INVOICE"
       ON "wholesale_payment_allocation" ("wholesale_invoice_id")`
  );
  await appendOnly(
    connection,
    'wholesale_payment_allocation',
    'wholesale_payment_allocation_append_only'
  );

  // Derived balances (ADR-09): allocations of voided payments never count.
  await execute(
    connection,
    `CREATE OR REPLACE VIEW "wholesale_active_allocation" AS
     SELECT a.*
     FROM "wholesale_payment_allocation" a
     JOIN "wholesale_payment" p ON p."wholesale_payment_id" = a."wholesale_payment_id"
     WHERE p."voided_at" IS NULL`
  );
  await execute(
    connection,
    `CREATE OR REPLACE VIEW "wholesale_invoice_balance" AS
     SELECT i."wholesale_invoice_id", i."customer_id", i."wholesale_order_id", i."condition",
            i."due_date", i."grand_total",
            i."grand_total" - COALESCE(SUM(a."amount"), 0) AS "outstanding"
     FROM "wholesale_invoice" i
     LEFT JOIN "wholesale_active_allocation" a ON a."wholesale_invoice_id" = i."wholesale_invoice_id"
     GROUP BY i."wholesale_invoice_id"`
  );

  // ---------------------------------------------------------------
  // 10. Dispatch: vehicles, drivers, remission notes (7.11, ADR-15)
  // ---------------------------------------------------------------
  await execute(
    connection,
    `CREATE TABLE IF NOT EXISTS "wholesale_vehicle" (
       "wholesale_vehicle_id" INT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
       "uuid" UUID NOT NULL DEFAULT gen_random_uuid(),
       "owner_type" varchar(16) NOT NULL,
       "customer_id" INT DEFAULT NULL,
       "carrier_ruc" varchar(32) DEFAULT NULL,
       "carrier_name" varchar(255) DEFAULT NULL,
       "plate" varchar(16) NOT NULL,
       "vehicle_type" varchar(32) NOT NULL,
       "brand" varchar(64) DEFAULT NULL,
       "is_active" boolean NOT NULL DEFAULT true,
       "created_at" timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
       "updated_at" timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
       CONSTRAINT "WHOLESALE_VEHICLE_UUID_UNIQUE" UNIQUE ("uuid"),
       CONSTRAINT "WHOLESALE_VEHICLE_PLATE_UNIQUE" UNIQUE ("plate"),
       CONSTRAINT "FK_WHOLESALE_VEHICLE_CUSTOMER" FOREIGN KEY ("customer_id")
         REFERENCES "customer" ("customer_id") ON DELETE RESTRICT,
       CONSTRAINT "WHOLESALE_VEHICLE_OWNER_CHECK"
         CHECK ("owner_type" IN ('own_fleet', 'carrier', 'customer'))
     )`
  );
  await execute(
    connection,
    `CREATE TABLE IF NOT EXISTS "wholesale_driver" (
       "wholesale_driver_id" INT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
       "uuid" UUID NOT NULL DEFAULT gen_random_uuid(),
       "full_name" varchar(255) NOT NULL,
       "document_type" varchar(16) NOT NULL DEFAULT 'ci',
       "document_number" varchar(32) NOT NULL,
       "customer_id" INT DEFAULT NULL,
       "carrier_ruc" varchar(32) DEFAULT NULL,
       "is_active" boolean NOT NULL DEFAULT true,
       "created_at" timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
       "updated_at" timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
       CONSTRAINT "WHOLESALE_DRIVER_UUID_UNIQUE" UNIQUE ("uuid"),
       CONSTRAINT "WHOLESALE_DRIVER_DOCUMENT_UNIQUE" UNIQUE ("document_type", "document_number"),
       CONSTRAINT "FK_WHOLESALE_DRIVER_CUSTOMER" FOREIGN KEY ("customer_id")
         REFERENCES "customer" ("customer_id") ON DELETE RESTRICT
     )`
  );
  await execute(
    connection,
    `CREATE TABLE IF NOT EXISTS "wholesale_remission_note" (
       "wholesale_remission_note_id" INT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
       "uuid" UUID NOT NULL DEFAULT gen_random_uuid(),
       "wholesale_order_id" INT NOT NULL,
       "wholesale_invoice_id" INT NOT NULL,
       "trip_no" smallint NOT NULL,
       "status" varchar(16) NOT NULL DEFAULT 'pending',
       "transport_type" varchar(16) NOT NULL,
       "wholesale_vehicle_id" INT NOT NULL,
       "wholesale_driver_id" INT NOT NULL,
       "vehicle_snapshot" jsonb NOT NULL,
       "driver_snapshot" jsonb NOT NULL,
       "carrier_ruc" varchar(32) DEFAULT NULL,
       "carrier_name" varchar(255) DEFAULT NULL,
       "origin_address" text NOT NULL,
       "destination_address" text NOT NULL,
       "route_note" text DEFAULT NULL,
       "departure_at" timestamp with time zone NOT NULL,
       "document_number" varchar(32) DEFAULT NULL,
       "cdc" varchar(44) DEFAULT NULL,
       "protocol" varchar(32) DEFAULT NULL,
       "last_error" text DEFAULT NULL,
       "shipment_id" INT DEFAULT NULL,
       "created_by" INT NOT NULL,
       "created_at" timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
       "updated_at" timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
       CONSTRAINT "WHOLESALE_REMISSION_UUID_UNIQUE" UNIQUE ("uuid"),
       CONSTRAINT "WHOLESALE_REMISSION_TRIP_UNIQUE" UNIQUE ("wholesale_order_id", "trip_no"),
       CONSTRAINT "WHOLESALE_REMISSION_SHIPMENT_UNIQUE" UNIQUE ("shipment_id"),
       CONSTRAINT "FK_WHOLESALE_REMISSION_ORDER" FOREIGN KEY ("wholesale_order_id")
         REFERENCES "wholesale_order" ("wholesale_order_id") ON DELETE RESTRICT,
       CONSTRAINT "FK_WHOLESALE_REMISSION_INVOICE" FOREIGN KEY ("wholesale_invoice_id")
         REFERENCES "wholesale_invoice" ("wholesale_invoice_id") ON DELETE RESTRICT,
       CONSTRAINT "FK_WHOLESALE_REMISSION_VEHICLE" FOREIGN KEY ("wholesale_vehicle_id")
         REFERENCES "wholesale_vehicle" ("wholesale_vehicle_id") ON DELETE RESTRICT,
       CONSTRAINT "FK_WHOLESALE_REMISSION_DRIVER" FOREIGN KEY ("wholesale_driver_id")
         REFERENCES "wholesale_driver" ("wholesale_driver_id") ON DELETE RESTRICT,
       CONSTRAINT "WHOLESALE_REMISSION_STATUS_CHECK"
         CHECK ("status" IN ('pending', 'approved', 'rejected', 'cancelled')),
       CONSTRAINT "WHOLESALE_REMISSION_TRANSPORT_CHECK"
         CHECK ("transport_type" IN ('own_fleet', 'carrier', 'customer_pickup')),
       CONSTRAINT "WHOLESALE_REMISSION_CARRIER_CHECK"
         CHECK ("transport_type" <> 'carrier' OR "carrier_ruc" IS NOT NULL),
       CONSTRAINT "WHOLESALE_REMISSION_APPROVED_CHECK"
         CHECK ("status" <> 'approved' OR ("cdc" IS NOT NULL AND "protocol" IS NOT NULL))
     )`
  );
  await execute(
    connection,
    `CREATE INDEX IF NOT EXISTS "WHOLESALE_REMISSION_ORDER_STATUS"
       ON "wholesale_remission_note" ("wholesale_order_id", "status")`
  );
  await execute(
    connection,
    `CREATE TABLE IF NOT EXISTS "wholesale_remission_note_item" (
       "wholesale_remission_note_item_id" INT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
       "wholesale_remission_note_id" INT NOT NULL,
       "order_item_id" INT NOT NULL,
       "product_sku" varchar NOT NULL,
       "description" varchar NOT NULL,
       "qty" INT NOT NULL,
       CONSTRAINT "WHOLESALE_REMISSION_ITEM_UNIQUE" UNIQUE ("wholesale_remission_note_id", "order_item_id"),
       CONSTRAINT "FK_WHOLESALE_REMISSION_ITEM_NOTE" FOREIGN KEY ("wholesale_remission_note_id")
         REFERENCES "wholesale_remission_note" ("wholesale_remission_note_id") ON DELETE CASCADE,
       CONSTRAINT "FK_WHOLESALE_REMISSION_ITEM_ORDER_ITEM" FOREIGN KEY ("order_item_id")
         REFERENCES "order_item" ("order_item_id") ON DELETE RESTRICT,
       CONSTRAINT "WHOLESALE_REMISSION_ITEM_QTY_CHECK" CHECK ("qty" > 0)
     )`
  );
  await addConstraint(
    connection,
    'wholesale_sifen_document',
    'FK_WHOLESALE_SIFEN_DOCUMENT_REMISSION',
    `FOREIGN KEY ("wholesale_remission_note_id")
       REFERENCES "wholesale_remission_note" ("wholesale_remission_note_id") ON DELETE RESTRICT`
  );

  // ---------------------------------------------------------------
  // 11. Notifications, demo inbox and demo settings (7.9)
  // ---------------------------------------------------------------
  // `type` is open on purpose (new notification types arrive per phase);
  // the list lives in the notification service.
  await execute(
    connection,
    `CREATE TABLE IF NOT EXISTS "wholesale_notification" (
       "wholesale_notification_id" INT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
       "uuid" UUID NOT NULL DEFAULT gen_random_uuid(),
       "type" varchar(32) NOT NULL,
       "severity" varchar(16) NOT NULL DEFAULT 'info',
       "title" varchar(255) NOT NULL,
       "body" text DEFAULT NULL,
       "entity_type" varchar(32) DEFAULT NULL,
       "entity_uuid" UUID DEFAULT NULL,
       "read_at" timestamp with time zone DEFAULT NULL,
       "read_by" INT DEFAULT NULL,
       "created_at" timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
       CONSTRAINT "WHOLESALE_NOTIFICATION_UUID_UNIQUE" UNIQUE ("uuid"),
       CONSTRAINT "WHOLESALE_NOTIFICATION_SEVERITY_CHECK"
         CHECK ("severity" IN ('info', 'warning', 'critical'))
     )`
  );
  await execute(
    connection,
    `CREATE INDEX IF NOT EXISTS "WHOLESALE_NOTIFICATION_UNREAD"
       ON "wholesale_notification" ("created_at" DESC) WHERE "read_at" IS NULL`
  );
  await execute(
    connection,
    `CREATE TABLE IF NOT EXISTS "wholesale_demo_message" (
       "wholesale_demo_message_id" INT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
       "uuid" UUID NOT NULL DEFAULT gen_random_uuid(),
       "wholesale_quote_id" INT DEFAULT NULL,
       "direction" varchar(16) NOT NULL DEFAULT 'outbound',
       "kind" varchar(16) NOT NULL,
       "to_phone" varchar(20) NOT NULL,
       "body" text NOT NULL,
       "reply_nonce" varchar(32) DEFAULT NULL,
       "actions" jsonb DEFAULT NULL,
       "replied_action" varchar(32) DEFAULT NULL,
       "replied_at" timestamp with time zone DEFAULT NULL,
       "created_at" timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
       CONSTRAINT "WHOLESALE_DEMO_MESSAGE_UUID_UNIQUE" UNIQUE ("uuid"),
       CONSTRAINT "FK_WHOLESALE_DEMO_MESSAGE_QUOTE" FOREIGN KEY ("wholesale_quote_id")
         REFERENCES "wholesale_quote" ("wholesale_quote_id") ON DELETE SET NULL,
       CONSTRAINT "WHOLESALE_DEMO_MESSAGE_DIRECTION_CHECK" CHECK ("direction" IN ('outbound')),
       CONSTRAINT "WHOLESALE_DEMO_MESSAGE_KIND_CHECK" CHECK ("kind" IN ('template', 'text'))
     )`
  );
  await execute(
    connection,
    `CREATE INDEX IF NOT EXISTS "WHOLESALE_DEMO_MESSAGE_QUOTE"
       ON "wholesale_demo_message" ("wholesale_quote_id")`
  );
  await execute(
    connection,
    `CREATE TABLE IF NOT EXISTS "wholesale_demo_setting" (
       "key" varchar(64) PRIMARY KEY,
       "value" boolean NOT NULL DEFAULT false,
       "updated_by" INT DEFAULT NULL,
       "updated_at" timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
       CONSTRAINT "WHOLESALE_DEMO_SETTING_KEY_CHECK"
         CHECK ("key" IN ('force_sifen_reject_invoice', 'force_sifen_reject_remission_note'))
     )`
  );

  // ---------------------------------------------------------------
  // 12. updated_at triggers (function from Version-1.0.0)
  // ---------------------------------------------------------------
  for (const table of [
    'wholesale_product_line',
    'wholesale_customer_credit',
    'wholesale_admin_profile',
    'wholesale_order',
    'wholesale_fiscal_issuer',
    'wholesale_vehicle',
    'wholesale_driver',
    'wholesale_remission_note',
    'wholesale_demo_setting'
  ]) {
    await execute(
      connection,
      `DROP TRIGGER IF EXISTS "${table}_updated_at" ON "${table}";
       CREATE TRIGGER "${table}_updated_at"
         BEFORE UPDATE ON "${table}"
         FOR EACH ROW EXECUTE FUNCTION wholesale_set_updated_at()`
    );
  }
};
