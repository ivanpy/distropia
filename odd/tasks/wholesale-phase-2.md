# Wholesale B2B — Phase 2 (Logic and security)

Locator: `odd/tasks/wholesale-phase-2.md` · Engram mirror: `odd/wholesale-phase-2/tasks`

## Objective

The whole quote domain works at service and API level, without real WhatsApp (SDD v2.1, amended 2026-10-13): masked prices on every surface (GraphQL and REST cart), runtime modes, schema 1.1.0, B2B registration with validated RUC, audited approval, product lines with tiers, per-product wholesale data, quote calculation (incl. SIFEN tax breakdown and canonical states), and anti-bot protections on `POST /api/wholesale/request-quote`.

## Problem / why

Phase 2 of the SDD (`docs/sdd-wholesale/04_planificacion_y_tareas/`). ADR-06 (price masking) is on the critical path: everything B2B-facing depends on approved customers never receiving prices.

## Scope

- In: SDD v2.1 Phase 2 tasks (`docs/sdd-wholesale/04_planificacion_y_tareas/02_checklist_tareas.md` § Fase 2): T-2.3 … T-2.52 minus replaced ones (T-2.5 → T-2.35, T-2.9 → T-2.40, T-2.10f → T-2.44, T-2.18 → T-2.45). T-2.1/T-2.2 spikes resolved as ADR-06/ADR-07 (ADR-07 amended by ADR-12).
- Out: WhatsApp sending, webhook, order creation (Phase 3); UI (Phase 4). No changes under `packages/evershop/src`.

## Constraints

- Design sources: `docs/sdd-wholesale/02_diseno_tecnico/*` (ADR-06 in `04_decisiones_spikes.md`), `03_integraciones_y_seguridad/01_seguridad_y_antibot.md`.
- Wholesale viewer = `customer.is_wholesale_approved === true` read from the DB (boolean; `=== 1` fails open).
- TypeScript strict, ESM; tests compiled to `dist` (`npm run build --prefix extensions/wholesale`) then Jest scoped to `extensions/wholesale`.
- Commits: Conventional Commits, no AI attribution.

## Open decisions

- **D-P2-1** `wholesale_quote` → `customer` FK is `ON DELETE RESTRICT` (deferred from Phase 1 review). Keep quote history vs allow customer deletion. Any change needs a new `Version-1.0.1.ts`.
- **D-P2-7 (G-a)** — decided 2026-10-15 by the user: close it (W4b), approval only through the audited endpoint. Core admin `PATCH /api/customers/:id` bypasses approval revocation, RUC check and audit, and can write the approval columns directly (see W4 evidence).

## Decisions

- **D-P2-3 (2026-10-12, user):** W2b = extension API middleware that masks amounts in core REST cart responses for approved wholesale customers (T-2.31).
- **D-P2-4 (2026-10-13, user):** SDD replanned to v2.1 — Alt A (ADR-13), canonical states (ADR-14), NRE (ADR-15), payment void only (ADR-16); G-1 … G-11 confirmed. Phase 2 gains W2b and W2c; open minor points P-1 … P-11 live in `01_plan_de_fases.md` (P-5 still unconfirmed, not Phase 2).
- **D-P2-5 (2026-10-14, user):** migration 1.1.0 refuses to run while any `wholesale_quote` row has totals without the SIFEN breakdown (rows must be fixed or deleted by hand); `WHOLESALE_QUOTE_TOTALS_CHECK` is added validated, not `NOT VALID`. Dev DB had 0 quotes when decided.
- **D-P2-6 (2026-10-14, user):** T-2.4c — a B2B registration through native `POST /api/customers` carries an `address` object; it is validated with core `validateAddress` and inserted as the default `customer_address` in the same transaction (`hookBefore`/`hookAfter` `insertCustomerData`). Codes `WHOLESALE_ADDRESS_REQUIRED` / `WHOLESALE_ADDRESS_INVALID`.
- **D-P2-2 (2026-10-12, user):** keep the global `Price.text` override — masked amounts print `Subject to quote` from the API itself; real amounts format identically to core (parity-tested). W2 reuses `MASKED_AMOUNT` for cart prices.

## Tasks (work units)

- [x] **W1** Price masking core: T-2.10 (RED), T-2.10a `isWholesaleViewer`, T-2.10b `resolveCorePrice` + parity test, T-2.10c `ProductPrice.isMasked` + `Product.price` override — route: delegated direct (writer + preparation trigger) — commit `50f3477c`
- [x] **W2** Cart masking + no price filters/sort for wholesale: T-2.10d, T-2.10e — route: delegated direct — commits `7dd425f0`, `f2b45738`, `4636a922`
- [x] **W2b** REST cart masking: T-2.31 — route: delegated direct (writer + preparation trigger) — commit `8bbec4af` (+503) — review approved

- [x] **W2c** Runtime modes + config + migration 1.1.0: T-2.32, T-2.33, T-2.34, T-2.52 — route: delegated direct (writer) + inline review correction — commits `5bf707c7`, `24ada00a`, `86f0378c`, `44147714` — review approved
- [x] **W3** Registration + RUC: T-2.3 (RED), T-2.4, T-2.4c, T-2.4b, T-2.35 … T-2.38 — route: delegated direct (2 writers) — commits `c044f0e4`, `1f03eb94`, `3f34c04a`, `c5c9f8df`, `d13a20ff` — reviews approved
- [x] **W4** Approval + audit: T-2.39, T-2.6, T-2.7, T-2.8 (+ tax_id revalidation on update, R3-update-taxid-unvalidated) — route: delegated direct (writer + preparation trigger: SDD design + migrations + W3 services) — commits `1cc2081e`, `d1b9b042`, `e767fc7a`, `eadb3a72` (+1330) — review approved
- [ ] **W4b** Close customer-write bypasses (D-P2-7, user 2026-10-15: "security is crucial, fix before proceeding"): (a) middleware on core admin `PATCH /api/customers/:id` strips approval columns and refuses (422) phone/`tax_id` changes on an approved wholesale customer; (b) sweep every other core route/service that writes `customer` for the same bypass; (c) storefront registration must not set `group_id`/`status` from the body; (d) test the approval handler's transaction path (R3-handler-txn-path-untested) — route: delegated direct (writer + mapping) — commits `ee668e30`, `71089952`, `350d4a59`, `b9a79941` (+978/-66) — review approved
- [ ] **W4c** Close the admin-PATCH read/write race (`R3-guard-read-write-race`): core admin PATCH is not transactional — decided 2026-10-15 by the user: DB trigger on `customer` (new migration) rejecting phone/`tax_id` changes on an approved customer unless the same statement revokes, and approval-column changes unless flagged by the audited approval path (transaction-local setting) — route: delegated direct (writer) — commit `41329a82` (+737/-50) — review approved
- [x] **W5** Product lines + per-product data: T-2.40 … T-2.44, T-2.11 … T-2.17 — route: delegated direct, two sequential writers (W5a lines: T-2.40 … T-2.43; W5b per-product rule: T-2.44, T-2.11 … T-2.17), review per slice — W5a `cb84abdb`, `95a99e8c`, `2f3b2d6a`, `55bfd622`, `41adcdfe`; W5b `fc35b8ad`, `e1873fa9`, `a6683858`, `8091077d`, `e6f486c6`, `d5103ac6`, `1c1c2b60`, `733c9882` — reviews approved
- [ ] **W6** Quote calculation: T-2.45, T-2.46, T-2.49, T-2.50, T-2.51, T-2.47, T-2.48, T-2.19 … T-2.22 — ~800 lines — split into two sequential slices, review per slice
  - [x] **W6a** Pure money + calculation: T-2.46, T-2.49, T-2.47, T-2.50, T-2.45 — route: delegated direct (writer + preparation trigger: SDD §8 + W5 services) — commits `06b5f8b2`, `a32921e3`, `7f096c96`, `dcafa5c5`, `0cc6a57b` (+1476) — review `review-a22c3eb892488ca2` approved (medium, reliability lens); advisory: R3-payment-partial-self-transition (no `partially_paid → partially_paid`; fix in W6b or before payments), R3-default-weight-unit-test-tautological
  - [ ] **W6b** Quote persistence: T-2.19, T-2.20, T-2.21, T-2.22, T-2.48, T-2.51 — route: delegated direct (writer)
- [ ] **W7** Anti-bot: T-2.23 … T-2.28 — ~450 lines
- [ ] **W8** `POST /api/wholesale/request-quote` + trust proxy: T-2.29, T-2.30 — ~250 lines

## Acceptance criteria (phase exit)

- Unit tests: `validateQuantity`, tier calculation, rule validation (edge cases).
- Integration tests of `request-quote`: every error code in the contracts table reproduces.
- Concurrency: 5 parallel requests with the same `Idempotency-Key` → 1 quote.
- Rate limit: 4th request in one hour → 429.
- An approved B2B customer gets no amounts from storefront GraphQL **nor** REST cart responses.
- `getRuntimeMode` / `assertRuntimeConfig` covered by matrix tests; `Version-1.1.0.ts` re-runnable; audit log rejects `UPDATE`/`DELETE`.
- RUC format + check digit in every mode; DNIT mock even/odd in dev.
- `calculateQuote`: CIRCUITO §3.B example, mix, minimum, per-item VAT, null weight; `computeTaxBreakdown` spec example (`dTotOpe = 11.550.000`).
- Special freight → `AWAITING_SHIPPING_QUOTE` without WhatsApp; `CLAUDE.md` §3 amended for demo mode (T-2.52).
- `git diff --stat -- packages/evershop/src` empty.

## Delivery

- Branch: `feat/wholesale-phase-2`, stacked on `feat/wholesale-phase-1`.
- Strategy `ask-on-risk`: Phase 1 + Phase 2 exceed 400 lines → chain-PR strategy to be asked before any PR.

## Progress / evidence

### W1 (`50f3477c`)

- RED: 4/4 failed (`Cannot query field "isMasked" on type "ProductPrice"`); GREEN 4/4 (approved, B2C, anonymous, DB-not-context).
- Full extension suite 51/51 (writer); parent spot check after rebuild 51/51.
- In-process GraphQL test: core compiled `buildTypeDefs(false)` + `buildResolvers(false)` include extension `dist/graphql/types`; context `{ pool: txClient, customer }`.
- `isWholesaleViewer`: re-reads `is_wholesale_approved` (and `status = 1`) by `customer_id` from `context.pool`, `=== true`, memoized per context (WeakMap of promise); throws if `context.pool` missing (fail closed).
- Replicated core resolvers: `catalog/.../ProductPrice.resolvers.js` (`parseFloat(product.price)`) and `checkout/.../Price.resolvers.js` `text` (Intl format, store currency); parity tests 20.
- Deviations from ADR-06 (accepted): masked price returns a `MaskedAmount` sentinel read as 0 by core `Price.value/currency` (ADR sketch would yield NaN); `Price.text` overridden globally to print `Subject to quote` for the sentinel and core-identical text otherwise; currency follows core (`getStoreCurrency()`), not a context key.
- Build now copies `.graphql` to dist (`copyfiles`); ambient `evershop-core.d.ts` for untyped core imports.
- Parent live check after dev restart: `/`, category, product, `/cart` → 200; anonymous GraphQL prices real with `isMasked: false`.
- Incident: dev watcher again removed core `dist` (Windows rename bug); writer recovered with `npm run compile`.
- Follow-up: pin `@evershop/evershop` version (ADR-06 risk: replicated resolvers).

### W2 (`7dd425f0`, `f2b45738`, `4636a922`)

- `copyfiles@2.4.1` declared as devDependency (fixes R3-copyfiles-undeclared).
- T-2.10d: RED 3/3 (`isMasked` missing; approved customer saw `$100.25`) → GREEN. 25 cart price fields masked (Cart 12, CartItem 13) + shipping costs; `isMasked` on Cart and CartItem; schema-walk drift guard fails if core adds a Price field reachable from Cart.
- T-2.10e: RED 2 (approved customer got `min_price`/`max_price`/`ob` and `priceRange`) → GREEN. `productCollectionFilters` processor (bootstrap) wraps price filter/sort callbacks; decision at call time from an AsyncLocalStorage flag set by resolver wrappers (`Query.products`, `productSearch`, `Category.products`, `Collection.products`, `ProductListing.products`) that call compiled core resolvers; price filters ignored; `priceRange` null for wholesale.
- Suite 81/81 (writer); parent after clean recompile 81/81. Parent live check: pages + price filter/sort URLs 200; anonymous price sort still applied with real prices.
- Incident: dev watcher left `dist.compiling` again; parent stopped dev, cleaned, recompiled. Writer sourced `.env` into a shell for a leftover-row check (conflicts with the user's `.env*` deny intent) — reported to user.
- Phase 4 follow-ups: hide price sort option in `ProductSorting.tsx`; mini-cart/cart UI read `Cart.isMasked`.

### Review 2026-10-14 — phase 1 + W1 + W2 + doc reconcile (`f045916..7e4c68aa`)

- Lineage `review-70d0288d38f8c511`, medium, lens reliability; consent granted; approved and acknowledged.
- Advisory (later work): `R3-db-suites-skip-silently` (`tests/unit/graphql/storefrontSchema.ts:23`, suggestion); `R3-price-range-narrowing-vacuous` (`tests/unit/graphql/priceFilters.test.ts:160-161`, warning).

### W2b (`8bbec4af`)

- One passive middleware per core route, `api/<routeId>/[<handler>]maskWholesaleCartAmounts.ts`, rewriting `response.$body` before core `apiResponse`: `addCartItem`, `addMineCartItem`, `updateCartItemQty`, `updateMineCartItemQty`, `removeCartItem`, `removeMineCartItem`, `createCart`.
- REST masked representation: amount keys → `null` (not 0, so no client reads it as free), item gains `is_masked: true`; extra regex guard on price/total/amount/discount/cost/fee keys. B2C/anonymous bodies untouched. Lookup failure → `next(err)` → 500 without prices.
- RED observed 4 failed / 11 passed → GREEN 15/15. Drift guards: every core `cartItemFields` key classified; set of core API routes using `.export()` equals covered set; core `sortMiddlewares` order handler < mask < `apiResponse` (core silently drops a middleware with a missing dependency).
- Writer: build ok, `tsc` clean, suite 96/96, `packages/evershop/src` diff empty. Parent spot check: rebuild + suite 96/96.
- Review: assess medium, `slice_budget_reached`; lineage `review-d038e7e5714bfa99`, consent granted, approved and acknowledged. Advisory (later work): `R3-shape-fail-open` (`maskCartRestResponse.ts:80-93`, warning — an unexpected body shape passes through unmasked); `R3-nested-amounts` (`:72-74`, suggestion); `R3-dist-coupling` (`cartRestMasking.test.ts:29-31`, suggestion).
- Live HTTP check 2026-10-14 (dev server, session login via `POST /customer/login`; customer approved/revoked by a scratchpad DB script, all test rows deleted afterwards): approved customer → `POST /api/cart/mine/items`, `PATCH`/`DELETE /api/cart/mine/items/:id`, `POST /api/carts` all 200 with the 11 amount keys `null` and `is_masked: true`; same session after revoke and anonymous `POST /api/carts` → real prices (15 / 30), no `is_masked`. `POST /api/customer/tokens` returns 400 `JWT secret for customer is not configured` in this env (not used). Fail-closed 500 path not exercised over HTTP (`R3-http-fail-closed-unproved`, suggestion from review `review-b9879c624f2a361f`).
- Follow-ups: masking of order/checkout REST responses (`cartCheckout`, `createOrder`) in a later phase; masking follows the viewer, not the cart owner (same as GraphQL); wiki entry on extension middleware for core API routes.

### W2c (`5bf707c7`, `24ada00a`, `86f0378c`, `44147714`)

- T-2.32/T-2.52 (`5bf707c7`): `services/runtime/getRuntimeMode.ts` + `assertRuntimeConfig.ts`, called from `bootstrap.ts` except `command === 'build'` (core `bin/build/index.js:47` passes it). Demo forbids the 6 real credentials of ADR-08; production requires 4 WhatsApp + 5 SIFEN vars and a real SIFEN provider (G-1) — so production boot fails by design until the SIFEN provider is wired (`realFiscalProviderAvailable`). `CLAUDE.md` §3 production rule amended for demo mode. RED: TS2307 / module not found → GREEN 49/49.
- T-2.33 (`24ada00a`): v2.1 defaults from arch §2 + `isSpecialFreightAlways()`; `freeShippingMaxWeightKg = null` survives `getConfig` (node-config keeps null leaves). RED: TS2305/TS2339 → GREEN 16/16.
- T-2.34 (`86f0378c`): `Version-1.1.0.ts` (920 lines) + integration test (885). Writer-chosen column types for tables the doc lists only in prose (§7.7–§7.9), extra CHECKs/indexes, status-check relaxation guarded, NRE FK moved after its table — see writer report in Engram. RED: module not found → GREEN 21/21; mutation check on the no-op snapshot.
- Review `review-e2b461a827c14e51`: CRITICAL `R3-legacy-quote-totals-check` (NOT VALID check breaks UPDATEs of 1.0.0 quotes) → user decision D-P2-5 → correction `44147714` (inline, +45/-10; test written together with the fix, RED not observed separately). After the correction the lineage stopped at `captured_artifacts_unverifiable` (terminal); user chose a fresh review.
- Review `review-7a42e4518059bc80` (W2c + correction, 2420 lines): approved and acknowledged. Advisory (later work): `R3-prod-boot-always-fails` (by design, G-1), `R3-build-skip-unproved` (verified unfounded: core passes `command: 'build'`), `R3-legacy-quote-hard-stop` (by design, D-P2-5), `R3-customer-delete-restrict` (credit FK RESTRICT blocks deleting approved wholesale customers — joins D-P2-1), `R3-test-lock-contention`, `R3-weakened-100-assertion` (1.0.0 table list now `arrayContaining`).
- Checks: suite 183/183, `tsc` clean, build ok, `packages/evershop/src` diff empty; GGA pre-commit passed on all four commits.
- Pending (user): add `WHOLESALE_DEMO_MODE`, `SIFEN_ENVIRONMENT`, `SIFEN_CERT_PATH`, `SIFEN_CERT_PASSWORD`, `SIFEN_CSC_ID`, `SIFEN_CSC` to `extensions/wholesale/.env.example` (agents are denied `.env*`).
- Note: migration 1.1.0 applies on the next `npm run dev` (dev DB currently at 1.0.0 with 0 quotes).

### W3 (`c044f0e4`, `1f03eb94`, `3f34c04a`, `c5c9f8df`, `d13a20ff`)

- T-2.35/T-2.36 (`c044f0e4`): `services/taxpayer/*` — `rucCheckDigit` + `normalizeRuc` (mod 11), `dnitMockProvider` (seed + even/odd), `localOnlyTaxpayerProvider`, `checkTaxpayer` by runtime mode. RED TS2307 → GREEN 71/71; the 3 CIRCUITO bad DVs fail in every mode.
- T-2.37/T-2.38 (`1f03eb94`): `GET /api/wholesale/ruc-check` (200/422) and `GET /api/v1/mock-dnit/consulta-ruc` (CIRCUITO §2 shape, 404 in production). Build now copies `src/api/**/*.json`. Writer choices not in the docs: 422 body `{status, code, message}`; `tipo_contribuyente` JURIDICA for 8-digit bases starting `80`. RED TS2307 → GREEN 39/39.
- T-2.3/T-2.4 (`3f34c04a`): RED runtime 2/2 (approval fields accepted on registration and profile update) → GREEN; `sanitizeWholesaleFields` processors (priority 900) strip approval fields; B2B create runs `checkTaxpayer`, stores RUC with DV, mock business name in dev/demo, `is_wholesale_approved = false`, `wholesale_requested_at` set.
- T-2.4b (`c5c9f8df`): subscriber `customer_registered/notifyPendingApproval` → admin notification only when `wholesale_requested_at`. GREEN 3/3.
- T-2.4c (`d13a20ff`, D-P2-6): `registrationAddress.ts`; end-to-end test through the compiled core `createCustomer` with a throwing probe hook to roll back. RED 3 failed → GREEN; `is_default` is BOOLEAN since core customer migration 1.0.3 (= RF-19 `is_default = 1`). Required fields follow core `validateAddress` (`full_name, address_1, province, country, postcode`; `city`/`telephone` optional).
- Checks: suite 334/334 (writers + parent spot checks), `tsc` clean, `packages/evershop/src` diff empty; GGA passed on every commit.
- Reviews: `review-71af6236f7c724ea` (`c044f0e4..c5c9f8df`, 1351 lines) and `review-e2444e68ce20f0a9` (`d13a20ff`) approved and acknowledged. A full-branch review attempt failed `stale_target_identity` (HEAD moved during consent) — full-branch reviews also exceed the lens budget; review per slice.
- Advisory (later work): `R3-update-taxid-unvalidated` (profile edit can change `tax_id`/`phone` unvalidated and without revocation — W4 T-2.8); `R3-core-error-mapping-unproved` + `R3-address-error-500` (core returns registration errors as 500; map to 422 later); `R3-notify-undefined-body`; `R3-address-fixture-validity`; `R3-numeric-postcode`; `R3-b2c-address-rollback-unasserted`.
- Open gaps (no SDD codes): phone (E.164) and business name are not validated at registration — a B2B registration without phone is accepted; consider requiring `city`. Core `POST /api/customers` also writes `group_id`/`status` from the body (core behaviour).
- Pending: live HTTP check of `ruc-check`, mock DNIT and B2B registration once migration 1.1.0 is applied (`npm run dev`).

### W4 (`1cc2081e`, `d1b9b042`, `e767fc7a`, `eadb3a72`)

- T-2.39 (`1cc2081e`): `services/audit/writeAudit.ts` — refuses a connection outside a transaction; admin email snapshot; a failing audit insert rolls the change back. RED TS2307 → GREEN 4/4.
- T-2.6 (`d1b9b042`): `POST /api/wholesale/customers/:id/approval` (private route, `:id` = customer uuid, body `{approved}`); `services/customer/setCustomerApproval.ts`. Approve → credit row 0 / 30 days (`ON CONFLICT DO NOTHING`, keeps manager terms) + audit `customer.approve`; revoke → clears `wholesale_approved_at/_by`, keeps credit, audit `customer.revoke`; no-ops write nothing. Codes `CUSTOMER_NOT_FOUND` (404, also non-uuid id), `CUSTOMER_NOT_WHOLESALE` (422, no `wholesale_requested_at`). RED TS2307 → GREEN 11/11.
- T-2.7 (`e767fc7a`): `wholesale_customer_approved` emitted through core `emit(name, data, connection)` on the approval transaction (commits/rolls back with it); not on revoke or no-op. RED 3 failed → GREEN 14/14.
- T-2.8 (`eadb3a72`): `revokeOnContactChange.ts` as a before-hook of core `updateCustomerData` (not the `customerDataBeforeUpdate` processor the SDD sketches — the hook has the transaction connection). Normalized phone / RUC change on an approved customer → revoke + system audit; changed `tax_id` revalidated by `checkTaxpayer` (bad DV, blocked or emptied RUC refused); address edits untouched. RED end-to-end 1 failed → GREEN 64/64 (customer folder).
- Checks: suite 364/364 (writer + parent spot check), `tsc` clean, build ok, `packages/evershop/src` diff empty; GGA passed on all four commits. DB tests apply 1.0.0 + 1.1.0 inside rolled-back transactions (no dev DB migration needed).
- Review `review-74654bdbd82ebd21` (`4a9d0f41..eadb3a72`, 1328 lines, medium, reliability): consent granted, approved and acknowledged. Advisory (later work): `R3-handler-txn-path-untested` (`approveCustomer.ts:47-69`, warning), `R3-retail-taxid-revalidated` (`revokeOnContactChange.ts:74-76`, warning — retail customers' `tax_id` edits are also revalidated), `R3-core-test-mixed-migration-state` (suggestion).
- Open gaps for the user:
  - **G-a** core admin `PATCH /api/customers/:id` writes the body directly (no service, hooks or transaction): admin phone/`tax_id` edits skip revocation, RUC check and audit, and an admin can set `is_wholesale_approved` / `wholesale_approved_*` without credit row or audit. Needs a decision (W2b-style middleware that strips/blocks, or accept).
  - G-b core `PATCH` profile `TaxpayerError` → 500 (same as `R3-core-error-mapping-unproved`).
  - G-c no-op approve/revoke not audited; G-d revocation clears `wholesale_approved_at/_by` (history in audit log); event payload pending its Phase subscriber.
- Not exercised: HTTP happy path of the approval endpoint (needs migration 1.1.0 on dev DB; audit rows are undeletable).

### W4b (`ee668e30`, `71089952`, `350d4a59`, `b9a79941`)

- (a) `ee668e30`: `api/updateCustomer/[escapeHtml]guardWholesaleCustomerUpdate[updateCustomer].ts` + `services/customer/guardAdminCustomerUpdate.ts` — strips `PROTECTED_CUSTOMER_FIELDS` (single source in `sanitizeWholesaleFields.ts`); approved customer + normalized phone/RUC change → 422 `WHOLESALE_REVOKE_REQUIRED`, nothing written; other customers: phone normalized, changed RUC validated by `checkTaxpayer` (422 taxpayer code). Fails closed without a DB pool. Ordering drift guard via shared `tests/unit/api/coreMiddleware.ts`. RED 14 failed → GREEN 68/68 (api folder).
- (c) `71089952`: core `POST /api/customers` is public — `api/createCustomer/[bodyParser,getCurrentUser]stripRegistrationPrivileges[createCustomer].ts` drops `group_id`/`status` unless an admin is logged in (`status: 0` would also have skipped `customer_registered`). RED 4 failed → GREEN 5/5.
- (b) `350d4a59`: inventory drift guard `tests/unit/api/customerWriteInventory.test.ts` — core `customer` writers: admin `updateCustomer` route (guarded, a), `createCustomer` service (processor + c), `updateCustomer` service (processor + hook), `updatePassword` (password only), `customerMetafield` / `pruneCustomer` (`meta_data` only), `deleteCustomer` (FK RESTRICT on credit). No GraphQL mutations. Mutation-checked (removing a route entry fails 1/17).
- (d) `b9a79941`: `createApproveCustomerHandler(acquire)` injectable; test maps BEGIN/COMMIT/ROLLBACK to savepoints — success commits approval+credit+audit+event; injected audit/event failures roll back to zero rows; connection released exactly once. GREEN 18/18.
- Checks: suite 405/405 (writer + parent spot check), `tsc` clean, build ok, `packages/evershop/src` diff empty; GGA passed.
- Review `review-875d69332740a9d2` (`750a642c..b9a79941`, 1044 lines, medium, reliability): consent granted, approved and acknowledged. Advisory: `R3-guard-read-write-race` (warning → W4c), `R3-business-name-overwrite-untested`, `R3-inventory-route-module-assumption` (suggestions).
- Remaining gaps: admin PATCH DB errors (E.164, duplicate wholesale RUC) still → 500 (G-b family).

### W4c (`41329a82`)

- `migration/Version-1.1.1.ts`: `wholesale_contact_value(text)` + `wholesale_customer_approval_guard()` `BEFORE INSERT OR UPDATE` trigger on `customer` (creation guarded, re-runnable). Rule 1: approved → approved with a changed phone/`tax_id` (trimmed, blank = NULL) → `WH001 WHOLESALE_REVOKE_REQUIRED` (the flag does not lift it). Rule 2: changes to `is_wholesale_approved`, `wholesale_approved_at`, `wholesale_approved_by`, `wholesale_requested_at` (UPDATE) or approval columns on INSERT need `wholesale.approval_write = 'on'` → else `WH002 WHOLESALE_APPROVAL_PROTECTED`. `wholesale_requested_at` allowed on INSERT (registration), protected on UPDATE.
- `services/customer/approvalWriteFlag.ts` (`set_config(..., true)`, tx-local): `setCustomerApproval` arms only around its UPDATE; `revokeOnContactChange` arms only when revoking and an `updateCustomerData` after-hook disarms.
- RED: TS2307, then behaviour 18 failed (WH002 on approve/revoke/auto-revocation) → GREEN 424/424. Mutation check: removing the disarm after-hook fails the core end-to-end test. Flag-leak tests (commit/rollback, same backend); race simulated (approval lands after the guard read → core-style write rejected WH001, row unchanged).
- Checks: suite 424/424 (writer + parent spot check), `tsc` clean, build ok, `packages/evershop/src` diff empty; GGA passed.
- Review `review-5cd9737c8d3a7f6b` (`c477ae36..41329a82`, 787 lines, medium, reliability): consent granted, approved and acknowledged. Advisory: `R3-admin-patch-under-trigger-unproved` (warning — admin PATCH guard tests don't apply 1.1.1), `R3-arm-window-before-core-write` (suggestion).
- Operator notes: manual SQL approvals need `SELECT set_config('wholesale.approval_write','on',true)` in the same transaction and are not audited — use the endpoint. In the race, core admin PATCH answers 500 with `WHOLESALE_REVOKE_REQUIRED: …` (core catches errors; no 422 without touching core). DB test suites must lock `customer` first (apply 1.0.0 first) to avoid deadlocks. Migration 1.1.1 applies on the next `npm run dev`.

### W5a (`cb84abdb`, `95a99e8c`, `2f3b2d6a`, `55bfd622`, `41adcdfe`)

- T-2.40 `services/line/validateLineTiers.ts`: RED TS2307 → GREEN 32/32 (order, duplicates, 0–100 with 2 decimals, non-decreasing, label ≤ 64 code points; must be pre-sorted, not sorted; empty table allowed per RF-12; max 50 tiers).
- T-2.41 `services/line/productLines.ts`: create / rename / activate / replace tiers (`FOR UPDATE` + DELETE + `INSERT … unnest`); duplicate name (case/space-insensitive, also the unique-index race) → 409 `PRODUCT_LINE_NAME_TAKEN`; invalid tiers → 422 `INVALID_TIERS` with per-row errors. GREEN 18/18.
- T-2.42 routes `createProductLine`, `updateProductLine`, `saveProductLineTiers` + `services/line/productLineHandler.ts`; payload schemas use `ajv-errors` so the core 400 names the field; 404 `PRODUCT_LINE_NOT_FOUND`. GREEN 16/16. Not audited (not marked (A) in SDD §7).
- T-2.43 admin GraphQL `WholesaleProductLine` / `wholesaleProductLines(includeInactive)`: RED 3 → GREEN 4/4; tiers ordered; absent from storefront schema.
- `41adcdfe`: 30 s per-test timeouts on core-pool registration tests (R3-test-lock-contention flake; baseline failed 1/3 runs). Schemas built before fixture transactions.
- Checks: suite 494/494 (writer 3 runs + parent spot check), `tsc` clean, build ok, `packages/evershop/src` diff empty; GGA passed. No migration needed (1.1.0 matches SDD §7.1).
- Review `review-56245aa953612127` (`f4ca3ca9..41adcdfe`, 1858 lines, medium, reliability): consent granted, approved and acknowledged. Advisory: `R3-handler-next-inside-try` (`productLineHandler.ts:64-81`, warning — `next()` runs inside the try after COMMIT, so a downstream throw would trigger a rollback and a second `next(e)`) → fold into W5b for both handler factories.
- Gaps: HTTP not exercised live; core HTML escaping can push a label past 64 → 422 `LABEL_TOO_LONG`.

### W5b (`fc35b8ad` … `733c9882`)

- `fc35b8ad` R3-handler-next-inside-try: `next()` after try/catch in both admin handlers; RED 2 failed (next called twice) → GREEN. Shared `services/admin/adminTransactionHandler.ts`.
- T-2.44 (`e1873fa9`): `services/rule/isQuotable.ts` (`isQuotable`, `loadQuoteProducts` with fixed query count; null weight kept). RED TS2307 → GREEN 15/15.
- T-2.11/T-2.12 (`a6683858`): `saveRule` (`insertOnUpdate` on `product_id`, never writes `tiers`, `FOR UPDATE` on product) / `getRule` (uuids only, line + tiers, `isQuotable`). GREEN 37/37 (rule folder).
- T-2.13 (`8091077d`): `POST /api/wholesale/products/:id/rule` (private; v2.0 schema; `tiers` → core 400). 404 `PRODUCT_NOT_FOUND`, 422 `PRODUCT_LINE_NOT_FOUND` / `INVALID_RULE` with `details.field`. Omitted optional keys keep stored values, explicit `null` clears. Not audited.
- T-2.14 (`e6f486c6`): `validateQuantity` (min/step/max, nearest lower/upper). GREEN 20/20.
- T-2.15 (`d5103ac6`): `services/cart/wholesaleCartItemFields.ts` — extra resolver on core `qty` (error key `wholesale_item`) + `updateCartItemQty` after-hook that refuses (core saves errored items on qty update). Decided by cart owner (`cart.customer_id`), not the viewer. E2E through compiled core `Cart`: 13 with min 6 / step 6 refused; non-quotable refused; B2C/anonymous unaffected; messages carry no amounts. GREEN 10/10.
- T-2.16 (`1c1c2b60`): admin `Product.wholesaleRule` (`WholesaleProductRule`, no tiers). RED 4 → GREEN 5/5.
- T-2.17 (`733c9882`): storefront `Product.wholesaleConstraint` — approved viewer (DB re-read) + quotable product only, else null; schema-walk guard (only `WholesaleProductConstraint` + `Int` reachable, no price/tier/tax-like names). RED 6 → GREEN 6/6.
- Checks: suite 600/600 (writer twice + parent spot check), `tsc` clean, build ok, `packages/evershop/src` diff empty; GGA passed. No migration needed.
- Review `review-25a26ec4ee3057e3` (`bd62ec5c..733c9882`, 2596 lines, medium, reliability): consent granted, approved and acknowledged. Advisory: `R3-baseprice-decimal-epsilon` (`saveRule.ts:64-69`, warning — the 1e-6 epsilon on `value*100` loses meaning near the `numeric(14,2)` maximum, so a 3-decimal value could be rounded silently by PostgreSQL), `R3-stale-error-test-swallows-refusal` (suggestion).
- Gaps: "13 with step 6 fails" holds for min 6 (RF-08 grid starts at min; with min 1 / step 6, 13 is valid); refused cart qty → core 500, not 422 (G-b family); N+1 on `wholesaleConstraint` / `wholesaleRule` for listings; a DB failure in the cart item resolver blocks logged-in B2C cart loads (fail closed); live HTTP not exercised.

### W6a (`06b5f8b2`, `a32921e3`, `7f096c96`, `dcafa5c5`, `0cc6a57b`)

- T-2.46 (`06b5f8b2`): `services/money/roundToCurrency.ts` (half-up, halves away from zero, 15-significant-digit read to absorb float noise; `currencyDecimals` via `Intl`, PYG 0) + `computeVat.ts` (per item). RED TS2307 → GREEN 29/29; per-item VAT sum (3 × 1.235 = 3.705) differs from the rounded sum (3.704).
- T-2.49 (`a32921e3`): `services/money/computeTaxBreakdown.ts` — spec example `dBaseGrav10 = 10.500.000`, `dIVA10 = 1.050.000`, `dTotOpe = 11.550.000`; 10/5/exempt mix; `dTotOpe = Σ dSub*`; refuses an exempt line with VAT. RED TS2307 → GREEN 7/7.
- T-2.47 (`7f096c96`): `services/quote/weightThreshold.ts` — kg threshold → store unit from core `getWeightUnit()` (kg, g, lb = 0.45359237 kg, oz = 0.028349523125 kg; unit read like core `createShipment`: case-insensitive, plural `s` dropped). Null threshold → null; unknown unit → null (special freight, fail safe); negative/non-finite threshold throws. Ambient `services/quote/evershop-setting.d.ts` declares `getWeightUnit`. RED TS2305/TS2307 → GREEN 23/23.
- T-2.50 (`dcafa5c5`): `services/quote/statuses.ts` and `services/order/statuses.ts` — ADR-14 name ↔ code maps, tests parse the CHECK constraints of `Version-1.1.0.ts` (quote, order, payment status); full from×to matrix vs the data-model §5/§8 tables (self-transitions: payment terms, invoicing retry, further partial dispatch); payment status (codes used as-is, no canonical names) never returns to `pending`. Unlisted transition → `INVALID_STATUS_TRANSITION` (`QuoteStatusError` / `OrderStatusError` with `from`/`to`); endpoints map it to their own 409 codes. RED TS2307 → GREEN 17/17.
- T-2.45 (`0cc6a57b`): `services/quote/calculateQuote.ts` — pure, follows arch §8; CIRCUITO §3.B tier tables (base prices invented) incl. boundaries 11/12/47/48 and 1/2/5/6; example 60 × HERR-MAN-01 + 2 × MAQ-CON-05 → net 10.730.000, VAT 1.073.000, `dTotOpe` 11.803.000; mix < 15 % reprices only critical consumables at the maximum tier (exactly 15 % keeps it); minimum exact / one below / met only after the mix rule; null weight → `special`; null threshold → `special`; threshold exact → `free`. RED TS2307 → GREEN 42/42; mutation `>=` → `>` on the mix share fails 1 test.
- Writer choices: a repriced line keeps the `tier` its quantity reached with `discountPercent: 0` and `mixRuleApplied: true` (for the RF-27 note); unit net computed as `basePrice × (100 − discount) / 100`; total weight rounded to 4 decimals (`product.weight` is `decimal(12,4)`); `freeShippingMaxWeight` passed to `calculateQuote` already in the store unit (the caller converts with `freeShippingMaxWeightInStoreUnit`); empty item list allowed (minimum not met); invalid quantity/price/weight/unsorted tiers/config throw.
- Checks: `tsc` clean, build ok, suite 718/718 (`--runInBand` and one parallel run); two parallel runs hit 5 s `beforeAll` hook timeouts in DB/GraphQL suites (`cartPriceMasking`, `priceFilters`, `productPriceMasking`, `notifyPendingApproval`) — load flake, those suites pass alone and serially; `packages/evershop/src` diff empty; GGA passed on all five commits.

## Next step

W6b (quote persistence: T-2.19, T-2.20, T-2.21, T-2.22, T-2.48, T-2.51) after the W6a review; `createQuote` converts `freeShippingMaxWeightKg` with `freeShippingMaxWeightInStoreUnit` and uses `quote/statuses.ts` for `DRAFT_QUOTE` / `AWAITING_SHIPPING_QUOTE`. Pending live HTTP check of W3/W4 endpoints after `npm run dev` applies 1.1.0 + 1.1.1.
