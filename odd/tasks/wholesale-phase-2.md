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

## Decisions

- **D-P2-3 (2026-10-12, user):** W2b = extension API middleware that masks amounts in core REST cart responses for approved wholesale customers (T-2.31).
- **D-P2-4 (2026-10-13, user):** SDD replanned to v2.1 — Alt A (ADR-13), canonical states (ADR-14), NRE (ADR-15), payment void only (ADR-16); G-1 … G-11 confirmed. Phase 2 gains W2b and W2c; open minor points P-1 … P-11 live in `01_plan_de_fases.md` (P-5 still unconfirmed, not Phase 2).
- **D-P2-2 (2026-10-12, user):** keep the global `Price.text` override — masked amounts print `Subject to quote` from the API itself; real amounts format identically to core (parity-tested). W2 reuses `MASKED_AMOUNT` for cart prices.

## Tasks (work units)

- [x] **W1** Price masking core: T-2.10 (RED), T-2.10a `isWholesaleViewer`, T-2.10b `resolveCorePrice` + parity test, T-2.10c `ProductPrice.isMasked` + `Product.price` override — route: delegated direct (writer + preparation trigger) — commit `50f3477c`
- [x] **W2** Cart masking + no price filters/sort for wholesale: T-2.10d, T-2.10e — route: delegated direct — commits `7dd425f0`, `f2b45738`, `4636a922`
- [x] **W2b** REST cart masking: T-2.31 — route: delegated direct (writer + preparation trigger) — commit `8bbec4af` (+503) — review approved

- [ ] **W2c** Runtime modes + config + migration 1.1.0: T-2.32, T-2.33, T-2.34, T-2.52 — ~1,000 lines (single additive migration file + test) — **next**
- [ ] **W3** Registration + RUC: T-2.3 (RED), T-2.4, T-2.4c, T-2.4b, T-2.35 … T-2.38 — ~550 lines
- [ ] **W4** Approval + audit: T-2.39, T-2.6, T-2.7, T-2.8 — ~300 lines
- [ ] **W5** Product lines + per-product data: T-2.40 … T-2.44, T-2.11 … T-2.17 — ~650 lines
- [ ] **W6** Quote calculation: T-2.45, T-2.46, T-2.49, T-2.50, T-2.51, T-2.47, T-2.48, T-2.19 … T-2.22 — ~800 lines
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
- Pending: live HTTP check on the dev server (approved customer `POST /api/cart/mine/items`).
- Follow-ups: masking of order/checkout REST responses (`cartCheckout`, `createOrder`) in a later phase; masking follows the viewer, not the cart owner (same as GraphQL); wiki entry on extension middleware for core API routes.

## Next step

Live HTTP check of W2b, then W2c (T-2.32, T-2.33, T-2.34, T-2.52). Task list reconciled with SDD v2.1 on 2026-10-14.
