/**
 * POST /api/wholesale/products/:id/rule (private, T-2.13, CU-01b step 3).
 *
 * `:id` is the product uuid. Body = schema v2.0 (`payloadSchema.json`,
 * validated by the core `payloadValidate` middleware): `isEnabled`,
 * `productLineUuid`, `basePrice`, `vatRate`, `isCriticalConsumable`,
 * `minQty`, `stepQty`, `maxQty`. A body with `tiers` is a 400: tiers are
 * edited on the product line. Saved with `saveRule` in one transaction;
 * answers `200 { data: rule }` (the `getRule` shape).
 *
 * Errors: `404 PRODUCT_NOT_FOUND` (also a non-uuid id, before any database
 * work), `422 PRODUCT_LINE_NOT_FOUND`, `422 INVALID_RULE` (field in
 * `details`). Not audited (not marked (A) in the SDD).
 */
import type { EvershopRequest } from '@evershop/evershop/types/request';
import {
  type AcquireConnection,
  createAdminTransactionHandler
} from '../../services/admin/adminTransactionHandler.js';
import { UUID_PATTERN } from '../../services/customer/setCustomerApproval.js';
import type { WholesaleRule } from '../../services/rule/getRule.js';
import { isRuleError, RuleError, saveRule, type SaveRuleInput } from '../../services/rule/saveRule.js';

const OK = 200;

const productUuidOf = (request: EvershopRequest): string => String(request.params?.id ?? '');

export const createSaveProductRuleHandler = (acquire?: AcquireConnection) =>
  createAdminTransactionHandler<WholesaleRule>(
    {
      successStatus: OK,
      precheck: (request) =>
        UUID_PATTERN.test(productUuidOf(request)) ? null : new RuleError('PRODUCT_NOT_FOUND', 404, 'Product not found'),
      run: (connection, request) => saveRule(connection, productUuidOf(request), request.body as SaveRuleInput),
      isDomainError: isRuleError
    },
    acquire
  );

export default createSaveProductRuleHandler();
