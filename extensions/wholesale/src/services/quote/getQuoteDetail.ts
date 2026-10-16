/**
 * Admin detail of a quote (T-2.51, `WholesaleQuote.admin.graphql`): the
 * stored snapshot with canonical status (ADR-14), the SIFEN breakdown, the
 * product lines and, once quoted, the `FLETE_LOGISTICA` service line.
 *
 * Admin/internal only: it carries base prices and the full phone. Only
 * uuids leave this module; numeric columns are returned as numbers.
 */
import type { TaxBreakdown } from '../money/computeTaxBreakdown.js';
import { UUID_PATTERN } from '../customer/setCustomerApproval.js';
import type { Queryable } from '../rule/ruleRow.js';
import type { FreightLabel } from './calculateQuote.js';
import { fromQuoteStatusCode, type QuoteStatus } from './statuses.js';

export interface QuoteDetailVatLine {
  rate: '10' | '5' | 'exempt';
  taxableBase: number;
  vat: number;
}

export interface QuoteDetailItem {
  uuid: string;
  lineType: 'product' | 'service';
  serviceCode: string | null;
  productSku: string;
  productName: string;
  productLineName: string | null;
  tierLabel: string | null;
  qty: number;
  /** Base net price of a product line; the freight net of the service line. */
  unitPrice: number;
  discountPercent: number;
  mixRuleApplied: boolean;
  vatRate: string;
  vatAmount: number;
  lineTotal: number;
  unitWeight: number | null;
}

/** Core `Customer` root (camelCase, as core's `camelCase(row)`), without the password. */
export interface QuoteDetailCustomer {
  customerId: number;
  uuid: string;
  status: number;
  email: string;
  fullName: string | null;
  createdAt: Date;
}

export interface QuoteDetail {
  uuid: string;
  quoteNumber: string;
  status: QuoteStatus;
  customer: QuoteDetailCustomer | null;
  currency: string;
  subTotal: number;
  discountTotal: number;
  netTotal: number;
  freightAmount: number;
  vatTotal: number;
  grandTotal: number;
  vatBreakdown: QuoteDetailVatLine[];
  taxBreakdown: TaxBreakdown;
  totalWeight: number | null;
  freightLabel: FreightLabel;
  freightSetAt: string | null;
  mixRuleApplied: boolean;
  items: QuoteDetailItem[];
  orderUuid: string | null;
  lastError: string | null;
  expiresAt: string | null;
  createdAt: string;
}

type Row = Record<string, unknown>;

const num = (value: unknown): number => Number(value);
const numOrNull = (value: unknown): number | null => (value === null || value === undefined ? null : Number(value));
const iso = (value: unknown): string | null => (value instanceof Date ? value.toISOString() : null);

/** VAT per rate for the UI, derived from the SIFEN breakdown; rates without a base are left out. */
export function vatBreakdownOf(tax: TaxBreakdown): QuoteDetailVatLine[] {
  const lines: QuoteDetailVatLine[] = [
    { rate: '10', taxableBase: tax.dBaseGrav10, vat: tax.dIVA10 },
    { rate: '5', taxableBase: tax.dBaseGrav5, vat: tax.dIVA5 },
    { rate: 'exempt', taxableBase: tax.dSubExe, vat: 0 }
  ];
  return lines.filter((l) => l.taxableBase !== 0);
}

const toItem = (row: Row): QuoteDetailItem => ({
  uuid: row.uuid as string,
  lineType: row.line_type as QuoteDetailItem['lineType'],
  serviceCode: (row.service_code as string | null) ?? null,
  productSku: row.product_sku as string,
  productName: row.product_name as string,
  productLineName: (row.product_line_name as string | null) ?? null,
  tierLabel: (row.tier_label as string | null) ?? null,
  qty: num(row.qty),
  unitPrice: num(row.unit_price),
  discountPercent: num(row.discount_percent),
  mixRuleApplied: row.mix_rule_applied === true,
  vatRate: row.vat_rate as string,
  vatAmount: num(row.vat_amount),
  lineTotal: num(row.line_total),
  unitWeight: numOrNull(row.unit_weight)
});

/** The quote with that public uuid, or `null` (unknown or malformed uuid). */
export async function getQuoteDetail(db: Queryable, uuid: string): Promise<QuoteDetail | null> {
  if (typeof uuid !== 'string' || !UUID_PATTERN.test(uuid)) {
    return null;
  }
  const { rows } = await db.query<Row>(
    `SELECT q.*, o."uuid" AS "order_uuid",
            c."uuid" AS "customer_uuid", c."status" AS "customer_status", c."email" AS "customer_email",
            c."full_name" AS "customer_full_name", c."created_at" AS "customer_created_at"
       FROM "wholesale_quote" q
       LEFT JOIN "order" o ON o."order_id" = q."order_id"
       LEFT JOIN "customer" c ON c."customer_id" = q."customer_id"
      WHERE q."uuid" = $1`,
    [uuid]
  );
  const quote = rows[0];
  if (!quote) {
    return null;
  }
  const { rows: items } = await db.query<Row>(
    `SELECT * FROM "wholesale_quote_item" WHERE "wholesale_quote_id" = $1
      ORDER BY ("line_type" = 'service'), "wholesale_quote_item_id"`,
    [quote.wholesale_quote_id]
  );
  const taxBreakdown: TaxBreakdown = {
    dSubExe: num(quote.d_sub_exe),
    dSub5: num(quote.d_sub_5),
    dSub10: num(quote.d_sub_10),
    dBaseGrav5: num(quote.d_base_grav_5),
    dBaseGrav10: num(quote.d_base_grav_10),
    dIVA5: num(quote.d_iva_5),
    dIVA10: num(quote.d_iva_10),
    dTotOpe: num(quote.d_tot_ope)
  };
  return {
    uuid: quote.uuid as string,
    quoteNumber: quote.quote_number as string,
    status: fromQuoteStatusCode(quote.status as string),
    customer:
      quote.customer_uuid === null
        ? null
        : {
            customerId: num(quote.customer_id),
            uuid: quote.customer_uuid as string,
            status: num(quote.customer_status),
            email: quote.customer_email as string,
            fullName: (quote.customer_full_name as string | null) ?? null,
            createdAt: quote.customer_created_at as Date
          },
    currency: quote.currency as string,
    subTotal: num(quote.sub_total),
    discountTotal: num(quote.discount_total),
    netTotal: num(quote.net_total),
    freightAmount: num(quote.freight_amount),
    vatTotal: num(quote.vat_total),
    grandTotal: num(quote.grand_total),
    vatBreakdown: vatBreakdownOf(taxBreakdown),
    taxBreakdown,
    totalWeight: numOrNull(quote.total_weight),
    freightLabel: quote.freight_label as FreightLabel,
    freightSetAt: iso(quote.freight_set_at),
    mixRuleApplied: quote.mix_rule_applied === true,
    items: items.map(toItem),
    orderUuid: (quote.order_uuid as string | null) ?? null,
    lastError: (quote.last_error as string | null) ?? null,
    expiresAt: iso(quote.expires_at),
    createdAt: iso(quote.created_at) as string
  };
}
