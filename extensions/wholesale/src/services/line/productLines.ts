/**
 * Product lines and their tier tables (T-2.41, RF-24, CU-01a, ADR-10).
 *
 * Lines belong to the extension (`wholesale_product_line`), not to core
 * categories. They are never deleted: deactivating one makes its products
 * non-quotable, while issued quotes keep their snapshot. The tier table is
 * always replaced as a whole (`DELETE` + `INSERT`) on the caller's
 * transaction, after `validateLineTiers` accepted it.
 *
 * Only `uuid` leaves this module; the serial ids stay internal.
 */
import type { Pool, PoolClient } from 'pg';
import { UUID_PATTERN } from '../customer/setCustomerApproval.js';
import { type LineTier, type TierError, validateLineTiers } from './validateLineTiers.js';

/** `wholesale_product_line.name` is `varchar(255)`. */
export const MAX_LINE_NAME_LENGTH = 255;

/** Unique index on `lower(name)` (migration 1.1.0). */
const NAME_UNIQUE_INDEX = 'WHOLESALE_PRODUCT_LINE_NAME_UNIQUE';

export type ProductLineErrorCode =
  | 'PRODUCT_LINE_NOT_FOUND'
  | 'PRODUCT_LINE_NAME_TAKEN'
  | 'INVALID_TIERS'
  | 'INVALID_PAYLOAD';

export type ProductLineErrorDetails = { field: string } | { errors: TierError[] };

export class ProductLineError extends Error {
  readonly code: ProductLineErrorCode;

  readonly status: number;

  readonly details?: ProductLineErrorDetails;

  constructor(code: ProductLineErrorCode, status: number, message: string, details?: ProductLineErrorDetails) {
    super(message);
    this.name = 'ProductLineError';
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

export const isProductLineError = (e: unknown): e is ProductLineError => e instanceof ProductLineError;

export interface ProductLine {
  uuid: string;
  name: string;
  isActive: boolean;
  countsTowardMix: boolean;
  /** Ordered by `fromQty` ascending. */
  tiers: LineTier[];
}

export interface CreateProductLineInput {
  name: string;
  /** Default `false` (table default). */
  countsTowardMix?: boolean;
  /** Default `true` (table default). */
  isActive?: boolean;
}

export interface UpdateProductLineInput {
  name?: string;
  countsTowardMix?: boolean;
  isActive?: boolean;
}

type Queryable = Pick<Pool | PoolClient, 'query'>;

interface LineRow {
  wholesale_product_line_id: number;
  uuid: string;
  name: string;
  is_active: boolean;
  counts_toward_mix: boolean;
}

interface TierRow {
  wholesale_product_line_id: number;
  from_qty: number;
  discount_percent: string;
  label: string | null;
}

const LINE_COLUMNS = `"wholesale_product_line_id", "uuid", "name", "is_active", "counts_toward_mix"`;

const notFound = () => new ProductLineError('PRODUCT_LINE_NOT_FOUND', 404, 'Product line not found');
const nameTaken = () =>
  new ProductLineError('PRODUCT_LINE_NAME_TAKEN', 409, 'Another product line already uses this name', {
    field: 'name'
  });

function assertTransaction(connection: PoolClient, operation: string): void {
  if ((connection as PoolClient & { INTRANSACTION?: boolean }).INTRANSACTION !== true) {
    throw new Error(`${operation} must run on the connection of an open transaction`);
  }
}

/** Trimmed, non-blank, at most 255 characters (counted as PostgreSQL does). */
function normalizeName(name: unknown): string {
  const trimmed = typeof name === 'string' ? name.trim() : '';
  if (trimmed === '' || Array.from(trimmed).length > MAX_LINE_NAME_LENGTH) {
    throw new ProductLineError(
      'INVALID_PAYLOAD',
      400,
      `name must be between 1 and ${MAX_LINE_NAME_LENGTH} characters`,
      { field: 'name' }
    );
  }
  return trimmed;
}

/**
 * Case-insensitive uniqueness, checked first so the common case answers 409
 * without aborting the transaction. A concurrent insert that commits after
 * the check still trips the unique index; `mapUniqueViolation` maps it.
 */
async function assertNameFree(connection: PoolClient, name: string, exceptLineId: number | null): Promise<void> {
  const { rows } = await connection.query(
    `SELECT 1 FROM "wholesale_product_line"
      WHERE lower("name") = lower($1) AND ($2::int IS NULL OR "wholesale_product_line_id" <> $2)
      LIMIT 1`,
    [name, exceptLineId]
  );
  if (rows.length > 0) {
    throw nameTaken();
  }
}

function mapUniqueViolation(e: unknown): unknown {
  const pgError = e as { code?: unknown; constraint?: unknown };
  return pgError?.code === '23505' && pgError.constraint === NAME_UNIQUE_INDEX ? nameTaken() : e;
}

const toTier = (row: TierRow): LineTier => ({
  fromQty: row.from_qty,
  discountPercent: Number(row.discount_percent),
  label: row.label
});

/** Attaches the ordered tiers of every line with one query. */
async function withTiers(db: Queryable, lines: LineRow[]): Promise<ProductLine[]> {
  const ids = lines.map((line) => line.wholesale_product_line_id);
  const byLine = new Map<number, LineTier[]>(ids.map((id) => [id, []]));
  if (ids.length > 0) {
    const { rows } = await db.query<TierRow>(
      `SELECT "wholesale_product_line_id", "from_qty", "discount_percent", "label"
         FROM "wholesale_product_line_tier"
        WHERE "wholesale_product_line_id" = ANY($1::int[])
        ORDER BY "wholesale_product_line_id", "from_qty"`,
      [ids]
    );
    for (const row of rows) {
      byLine.get(row.wholesale_product_line_id)?.push(toTier(row));
    }
  }
  return lines.map((line) => ({
    uuid: line.uuid,
    name: line.name,
    isActive: line.is_active === true,
    countsTowardMix: line.counts_toward_mix === true,
    tiers: byLine.get(line.wholesale_product_line_id) ?? []
  }));
}

/** Locks the line row so concurrent edits of the same line serialize. */
async function lockLine(connection: PoolClient, uuid: string): Promise<LineRow> {
  if (!UUID_PATTERN.test(uuid)) {
    throw notFound();
  }
  const { rows } = await connection.query<LineRow>(
    `SELECT ${LINE_COLUMNS} FROM "wholesale_product_line" WHERE "uuid" = $1 FOR UPDATE`,
    [uuid]
  );
  if (!rows[0]) {
    throw notFound();
  }
  return rows[0];
}

export async function createProductLine(connection: PoolClient, input: CreateProductLineInput): Promise<ProductLine> {
  assertTransaction(connection, 'createProductLine');
  const name = normalizeName(input.name);
  await assertNameFree(connection, name, null);
  try {
    const { rows } = await connection.query<LineRow>(
      `INSERT INTO "wholesale_product_line" ("name", "counts_toward_mix", "is_active")
       VALUES ($1, $2, $3) RETURNING ${LINE_COLUMNS}`,
      [name, input.countsTowardMix === true, input.isActive !== false]
    );
    return (await withTiers(connection, rows))[0];
  } catch (e) {
    throw mapUniqueViolation(e);
  }
}

/** Rename, activate/deactivate or change the mix flag; omitted fields are kept. */
export async function updateProductLine(
  connection: PoolClient,
  uuid: string,
  input: UpdateProductLineInput
): Promise<ProductLine> {
  assertTransaction(connection, 'updateProductLine');
  const line = await lockLine(connection, uuid);

  const assignments: string[] = [];
  const values: unknown[] = [];
  const set = (column: string, value: unknown) => {
    values.push(value);
    assignments.push(`"${column}" = $${values.length}`);
  };
  if (input.name !== undefined) {
    const name = normalizeName(input.name);
    await assertNameFree(connection, name, line.wholesale_product_line_id);
    set('name', name);
  }
  if (input.isActive !== undefined) {
    set('is_active', input.isActive === true);
  }
  if (input.countsTowardMix !== undefined) {
    set('counts_toward_mix', input.countsTowardMix === true);
  }
  if (assignments.length === 0) {
    return (await withTiers(connection, [line]))[0];
  }

  values.push(line.wholesale_product_line_id);
  try {
    const { rows } = await connection.query<LineRow>(
      `UPDATE "wholesale_product_line" SET ${assignments.join(', ')}
        WHERE "wholesale_product_line_id" = $${values.length}
        RETURNING ${LINE_COLUMNS}`,
      values
    );
    return (await withTiers(connection, rows))[0];
  } catch (e) {
    throw mapUniqueViolation(e);
  }
}

/**
 * Replaces the whole tier table of a line. Invalid tiers throw `INVALID_TIERS`
 * with the per-row errors before anything is written, so the previous table
 * stays intact.
 */
export async function replaceProductLineTiers(
  connection: PoolClient,
  uuid: string,
  tiers: unknown
): Promise<ProductLine> {
  assertTransaction(connection, 'replaceProductLineTiers');
  const line = await lockLine(connection, uuid);

  const validation = validateLineTiers(tiers);
  if (!validation.valid) {
    throw new ProductLineError('INVALID_TIERS', 422, 'The tier table is invalid', { errors: validation.errors });
  }

  await connection.query(`DELETE FROM "wholesale_product_line_tier" WHERE "wholesale_product_line_id" = $1`, [
    line.wholesale_product_line_id
  ]);
  if (validation.tiers.length > 0) {
    await connection.query(
      `INSERT INTO "wholesale_product_line_tier" ("wholesale_product_line_id", "from_qty", "discount_percent", "label")
       SELECT $1, t.from_qty, t.discount_percent, t.label
         FROM unnest($2::int[], $3::numeric[], $4::varchar[]) AS t(from_qty, discount_percent, label)`,
      [
        line.wholesale_product_line_id,
        validation.tiers.map((t) => t.fromQty),
        validation.tiers.map((t) => t.discountPercent),
        validation.tiers.map((t) => t.label)
      ]
    );
  }
  return (await withTiers(connection, [line]))[0];
}

/** One line by uuid, `null` when unknown or not a uuid. */
export async function getProductLine(db: Queryable, uuid: string): Promise<ProductLine | null> {
  if (!UUID_PATTERN.test(uuid)) {
    return null;
  }
  const { rows } = await db.query<LineRow>(`SELECT ${LINE_COLUMNS} FROM "wholesale_product_line" WHERE "uuid" = $1`, [
    uuid
  ]);
  return rows.length > 0 ? (await withTiers(db, rows))[0] : null;
}

/** Lines ordered by name (case-insensitive); inactive ones only on request. */
export async function listProductLines(
  db: Queryable,
  options: { includeInactive?: boolean } = {}
): Promise<ProductLine[]> {
  const { rows } = await db.query<LineRow>(
    `SELECT ${LINE_COLUMNS} FROM "wholesale_product_line"
      WHERE $1::boolean OR "is_active"
      ORDER BY lower("name"), "uuid"`,
    [options.includeInactive === true]
  );
  return withTiers(db, rows);
}

/**
 * Lines by internal id (any state), keyed by that id, tiers ordered. Internal
 * use only (quote data loading): the ids never leave the extension.
 */
export async function loadProductLinesById(db: Queryable, ids: number[]): Promise<Map<number, ProductLine>> {
  const unique = [...new Set(ids)];
  if (unique.length === 0) {
    return new Map();
  }
  const { rows } = await db.query<LineRow>(
    `SELECT ${LINE_COLUMNS} FROM "wholesale_product_line" WHERE "wholesale_product_line_id" = ANY($1::int[])`,
    [unique]
  );
  const lines = await withTiers(db, rows);
  return new Map(rows.map((row, index) => [row.wholesale_product_line_id, lines[index]]));
}
