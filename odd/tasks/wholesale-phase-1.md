# Wholesale B2B — Phase 1 (Data)

Locator: `odd/tasks/wholesale-phase-1.md` · Engram mirror: `odd/wholesale-phase-1/tasks`

## Objective

The `extensions/wholesale/` extension exists, boots with the core, and its schema lands in PostgreSQL through an idempotent `Version-1.0.0.ts` migration.

## Problem / why

Phase 1 of the wholesale SDD (`docs/sdd-wholesale/04_planificacion_y_tareas/`). Every later phase (pricing mask, quotes, WhatsApp, UI) depends on this schema and scaffold.

## Scope

- In: SDD tasks T-1.1 … T-1.17 (scaffold, config, `.env.example`, migration, integration test).
- Out: any business logic (Phase 2+). No changes under `packages/evershop/src` (project golden rule).

## Constraints

- Source of truth for the schema: `docs/sdd-wholesale/02_diseno_tecnico/02_modelo_datos_postgresql.md`.
- TypeScript strict, ESM, `export default`. Migration SQL idempotent (`IF NOT EXISTS`, guarded constraints).
- `/config` and `dist` are git-ignored: `config/default.json` is local-only; versioned defaults must live in the extension.
- Commits: Conventional Commits, no AI attribution (user rule).

## Tasks

- [x] **W1** Scaffold + config (T-1.1 … T-1.5, T-1.7) — route: delegated direct (writer trigger: 2+ non-trivial files; preparation reading of extension loading) — commit `bd9a63f2`
- [ ] **W1b** `.env.example` (T-1.6) — blocked: writer was denied write access to `.env*` paths by permission settings; needs user decision
- [x] **W2** Migration `Version-1.0.0.ts` + integration test (T-1.8 … T-1.17) — route: delegated direct (writer + preparation trigger) — commit `7acb36f0`

## Acceptance criteria

- `npm run build` / extension compile succeeds; `npm run dev` boots and lists the extension.
- Migration runs; second boot runs clean (re-executable).
- Integration test verifies columns, constraints (E.164, qty, status) and indexes.
- `git diff --stat -- packages/evershop/src` empty.

## Delivery

- Branch: `feat/wholesale-phase-1` (from `chore/gentle-ai-setup`).
- Forecast: ~600 authored lines across 2 work units (> 400 budget) → strategy `ask-on-risk`; chain strategy to be asked before any PR.

## Progress / evidence

- Config defaults versioned in the extension via `config.util.setModuleDefaults('wholesale', …)` in `bootstrap.ts`; local `config/default.json` registers the extension (git-ignored).
- `npm run build --prefix extensions/wholesale` OK; `npx tsc -p extensions/wholesale --noEmit` exit 0.
- Integration test: RED observed (13 failed / 1 passed, missing tables/columns), GREEN 14/14; parent spot check re-run 14/14.
- Migration applied through core runner; `migration` row `wholesale 1.0.0`; 4 `wholesale_*` tables present.
- Two full `npm run dev` boots (parent): both clean, `/`, `/accessories`, `/about-us`, `/admin/login` → 200.
- `git diff --stat -- packages/evershop/src` empty.
- Lint: root eslint ignores `**/extensions/**`; `npx eslint --no-ignore` on extension sources → 0 findings.
- Incident: dev watcher recompile (`bin/lib/watch/compileSwc.ts:60-61`) removed core `dist` and failed to rename `dist.compiling` on Windows, killing the dev server; recovered with `npm run compile`. Core bug, not fixed (golden rule).
- Open: `package-lock.json` does not yet list the `extensions/*` workspace (next `npm install` adds it).
- RDD: assess on `889e71d6..HEAD` → medium (`configuration_change`), `review_due: slice_budget_reached`.

## Next step

Native review of W1+W2, then user decision on T-1.6 (`.env.example`).
