import { execute } from '@evershop/postgres-query-builder';
import type { PoolClient } from '@evershop/postgres-query-builder';

/**
 * Wholesale schema 1.1.1 (W4c, closes R3-guard-read-write-race): the
 * approval rules move into the database, so a write that bypasses the
 * extension (core admin `PATCH /api/customers/:id` racing an approval, a
 * future core writer, a manual SQL statement) cannot break them.
 *
 * `wholesale_customer_approval_guard`, BEFORE INSERT OR UPDATE on "customer":
 *
 * 1. UPDATE of an approved customer that keeps it approved and changes
 *    `phone` or `tax_id` -> SQLSTATE WH001 `WHOLESALE_REVOKE_REQUIRED` (RF-22:
 *    the change must revoke in the same statement, as the W4 hook does).
 *    Differences in surrounding whitespace or blank vs NULL are not changes
 *    (`wholesale_contact_value`, same comparison as the hook and the W4b guard). The flag below does not lift this rule.
 * 2. Changes of `is_wholesale_approved`, `wholesale_approved_at`,
 *    `wholesale_approved_by` and `wholesale_requested_at` -> SQLSTATE WH002
 *    `WHOLESALE_APPROVAL_PROTECTED`, unless the transaction-local setting
 *    `wholesale.approval_write` is `on` (armed by the audited approval paths,
 *    see `services/customer/approvalWriteFlag.ts`). On INSERT only an
 *    approval (`is_wholesale_approved` true or approved_at/by set) needs the
 *    flag: registration sets `wholesale_requested_at` after its RUC check.
 *
 * Idempotent: CREATE OR REPLACE FUNCTION and a trigger created only when it
 * does not exist. The core runner wraps this function in a transaction and
 * records the version; do not open BEGIN/COMMIT here. Never edit this file
 * once applied.
 */
export default async (connection: PoolClient): Promise<void> => {
  // Comparable form of a contact value, as `comparable()` in the hook and the
  // guard: surrounding whitespace (spaces, tabs, line breaks) trimmed, blank = NULL.
  await execute(
    connection,
    `CREATE OR REPLACE FUNCTION wholesale_contact_value(value text) RETURNS text AS $$
       SELECT NULLIF(regexp_replace(value, '^\\s+|\\s+$', '', 'g'), '')
     $$ LANGUAGE sql IMMUTABLE`
  );
  await execute(
    connection,
    `CREATE OR REPLACE FUNCTION wholesale_customer_approval_guard() RETURNS TRIGGER AS $$
     DECLARE
       approval_write boolean := COALESCE(current_setting('wholesale.approval_write', true), '') = 'on';
     BEGIN
       IF TG_OP = 'INSERT' THEN
         IF NOT approval_write AND (
              NEW."is_wholesale_approved" IS TRUE
              OR NEW."wholesale_approved_at" IS NOT NULL
              OR NEW."wholesale_approved_by" IS NOT NULL) THEN
           RAISE EXCEPTION USING
             ERRCODE = 'WH002',
             MESSAGE = 'WHOLESALE_APPROVAL_PROTECTED: a customer can only be approved through the wholesale approval endpoint';
         END IF;
         RETURN NEW;
       END IF;

       IF OLD."is_wholesale_approved" IS TRUE AND NEW."is_wholesale_approved" IS TRUE AND (
            wholesale_contact_value(NEW."phone") IS DISTINCT FROM wholesale_contact_value(OLD."phone")
            OR wholesale_contact_value(NEW."tax_id") IS DISTINCT FROM wholesale_contact_value(OLD."tax_id")) THEN
         RAISE EXCEPTION USING
           ERRCODE = 'WH001',
           MESSAGE = format('WHOLESALE_REVOKE_REQUIRED: changing the phone or tax_id of approved wholesale customer %s requires revoking the approval in the same write', OLD."uuid");
       END IF;

       IF NOT approval_write AND (
            NEW."is_wholesale_approved" IS DISTINCT FROM OLD."is_wholesale_approved"
            OR NEW."wholesale_approved_at" IS DISTINCT FROM OLD."wholesale_approved_at"
            OR NEW."wholesale_approved_by" IS DISTINCT FROM OLD."wholesale_approved_by"
            OR NEW."wholesale_requested_at" IS DISTINCT FROM OLD."wholesale_requested_at") THEN
         RAISE EXCEPTION USING
           ERRCODE = 'WH002',
           MESSAGE = format('WHOLESALE_APPROVAL_PROTECTED: the approval of customer %s can only change through the wholesale approval endpoint', OLD."uuid");
       END IF;
       RETURN NEW;
     END;
     $$ LANGUAGE plpgsql`
  );
  await execute(
    connection,
    `DO $$
     BEGIN
       IF NOT EXISTS (
         SELECT 1 FROM pg_trigger
         WHERE tgname = 'wholesale_customer_approval_guard' AND tgrelid = '"customer"'::regclass
       ) THEN
         CREATE TRIGGER "wholesale_customer_approval_guard"
           BEFORE INSERT OR UPDATE ON "customer"
           FOR EACH ROW EXECUTE FUNCTION wholesale_customer_approval_guard();
       END IF;
     END $$`
  );
};
