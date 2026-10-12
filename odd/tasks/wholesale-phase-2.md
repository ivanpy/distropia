# Wholesale B2B — Phase 2 (Logic and security)

Locator: `odd/tasks/wholesale-phase-2.md` · Engram mirror: `odd/wholesale-phase-2/tasks`

## Objective

The whole wholesale domain works at service and API level, without real WhatsApp: masked prices for approved wholesale customers, B2B registration and approval, product rules, quote creation, and anti-bot protections on `POST /api/wholesale/request-quote`.

## Problem / why

Phase 2 of the SDD (`docs/sdd-wholesale/04_planificacion_y_tareas/`). ADR-06 (price masking) is on the critical path: everything B2B-facing depends on approved customers never receiving prices.

## Scope

- In: SDD tasks T-2.3 … T-2.30 (T-2.1/T-2.2 spikes already resolved as ADR-06/ADR-07).
- Out: WhatsApp sending, webhook, order creation (Phase 3); UI (Phase 4). No changes under `packages/evershop/src`.

## Constraints

- Design sources: `docs/sdd-wholesale/02_diseno_tecnico/*` (ADR-06 in `04_decisiones_spikes.md`), `03_integraciones_y_seguridad/01_seguridad_y_antibot.md`.
- Wholesale viewer = `customer.is_wholesale_approved === true` read from the DB (boolean; `=== 1` fails open).
- TypeScript strict, ESM; tests compiled to `dist` (`npm run build --prefix extensions/wholesale`) then Jest scoped to `extensions/wholesale`.
- Commits: Conventional Commits, no AI attribution.

## Open decisions

- **D-P2-1** `wholesale_quote` → `customer` FK is `ON DELETE RESTRICT` (deferred from Phase 1 review). Keep quote history vs allow customer deletion. Any change needs a new `Version-1.0.1.ts`.

## Decisions

- **D-P2-2 (2026-10-12, user):** keep the global `Price.text` override — masked amounts print `Subject to quote` from the API itself; real amounts format identically to core (parity-tested). W2 reuses `MASKED_AMOUNT` for cart prices.

## Tasks (work units)

- [x] **W1** Price masking core: T-2.10 (RED), T-2.10a `isWholesaleViewer`, T-2.10b `resolveCorePrice` + parity test, T-2.10c `ProductPrice.isMasked` + `Product.price` override — route: delegated direct (writer + preparation trigger) — commit `50f3477c`
- [x] **W2** Cart masking + no price filters/sort for wholesale: T-2.10d, T-2.10e — route: delegated direct — commits `7dd425f0`, `f2b45738`, `4636a922`
- [ ] **W2b** REST cart endpoints (`POST /api/carts/:id/items`, `addMineCartItem`, `updateQty`) return `item.export()` with raw prices — pending user decision
- [ ] **W3** B2B registration: T-2.3 (RED), T-2.4, T-2.4c, T-2.5, T-2.4b
- [ ] **W4** Approval: T-2.6, T-2.7, T-2.8
- [ ] **W5** Product rules: T-2.9, T-2.10f, T-2.11 … T-2.17
- [ ] **W6** Quote: T-2.18 … T-2.22
- [ ] **W7** Security middlewares: T-2.23 … T-2.28
- [ ] **W8** `POST /api/wholesale/request-quote` + trust proxy: T-2.29, T-2.30

## Acceptance criteria (phase exit)

- Unit tests: `validateQuantity`, tier calculation, rule validation (edge cases).
- Integration tests of `request-quote`: every error code in the contracts table reproduces.
- Concurrency: 5 parallel requests with the same `Idempotency-Key` → 1 quote.
- Rate limit: 4th request in one hour → 429.
- An approved B2B customer gets no prices from storefront GraphQL.
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

## Next step

User decision on W2b (REST cart price leak), then W3.
