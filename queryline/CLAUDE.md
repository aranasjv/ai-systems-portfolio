# Queryline — working notes for Claude Code

## Commands

```bash
pnpm typecheck          # tsc --noEmit, strict
pnpm test               # vitest (guard, dialect, loop, api, metrics)
pnpm lint
pnpm db:migrate         # control plane + dialect DDL
pnpm db:seed            # deterministic demo data
pnpm eval               # golden set for the configured WAREHOUSE_KIND
pnpm dlq list|replay    # dead-letter inspection
```

## Architecture map

- `src/dialect.ts` — the only place that knows engine-specific SQL syntax. Add a dialect here first.
- `src/guard.ts` — lexical pre-check, AST validation, tenant/PII enforcement. Never bypass it.
- `src/admission.ts` — EXPLAIN-based rejection before execution.
- `src/warehouse/*` — one adapter per engine. `execute()` always wraps with pagination and runs in a read-only transaction.
- `src/ai/loop.ts` — the only caller of `model.complete`, `adapter.estimate`, and `adapter.execute`.
- `src/ai/harness.ts` — result-hash based evaluation. Do not compare SQL strings.

## Invariants

1. Generated SQL never reaches the database without `validateSql` returning `ok: true`.
2. Safety refusals are not repairable. Only parse/unknown-table/ordering/admission failures are retried.
3. `adapter.admin()` is for migrations and seeding only. The agent must never receive an admin handle.
4. Every new dialect must define: quoting, folding, pagination, explain, session setup, and an adapter with `catalog`, `estimate`, `execute`.
5. Result rows are capped by the outside wrapper. Do not rely on the inner query's `LIMIT`.
6. Tests must not call a live model. Use `MockModelClient`.

## When adding a dialect

1. Add the kind to `WarehouseKind`.
2. Add a `DialectSpec` in `src/dialect.ts`.
3. Implement `WarehouseAdapter` in `src/warehouse/`.
4. Register it in `src/warehouse/index.ts`.
5. Add DDL to `sql/warehouse.<kind>.sql`, a golden file, and dialect unit tests.
