# Queryline

**Self-serve analytics copilot.**

A non-technical user asks a question; the agent retrieves the relevant schema and semantic model, generates SQL, executes it in a locked-down read-only sandbox, repairs its own errors, and returns a result set, a chart spec, and plain-English caveats.

- Prompt pack: [03-queryline-prompts.md](../prompt-packs/03-queryline-prompts.md)
- Implementation: [`queryline/`](../../queryline/README.md) — Postgres, SQL Server, and Oracle adapters
- Stack: TypeScript
- Domain: analytics / internal BI

## Why it isn't a toy

Arbitrary user input against a production-shaped warehouse, multi-tenant isolation, cost-based admission control, PII refusal, and partial failures in a multi-step agent. The failure mode that matters is not a wrong answer — it is a cartesian join that takes the warehouse down.

## Architecture

```
 question ──▶ Fastify /v1/questions ──▶ BullMQ query.run
                                              │
                                              ▼
                               ┌──────────────────────────────┐
                               │ route → retrieve → generate  │
                               │      → validate (AST)        │
                               │      → execute → repair ≤ 2  │
                               │      → answer + chart spec   │
                               └──────────────┬───────────────┘
                                              │
              pgvector: semantic model +      │  read-only role
              verified Q→SQL few-shots        ▼
                                        Postgres warehouse
                                        statement_timeout 8s
                                        admission control via EXPLAIN
```

## Stack

| Layer | Choice |
|---|---|
| Runtime | Node 22, TypeScript 5.7 strict, ESM |
| API | Fastify 5 |
| Data | Postgres 16 (warehouse-shaped seed), Prisma 6, pgvector |
| Queue | Redis 7 + BullMQ 5 |
| SQL safety | `node-sql-parser` AST validation + read-only DB role + `statement_timeout` |
| Tests | Vitest 3, Testcontainers |
| Observability | OTel Node SDK, Tempo, Prometheus, Grafana |
| AI | multi-step tool loop, schema/few-shot RAG, structured chart spec |

## Non-functional requirements

| Concern | Concrete behaviour |
|---|---|
| Backpressure | Per-tenant concurrency 3 + global 12; admission control estimates cost via `EXPLAIN` and rejects queries above a scan threshold; `429` + `Retry-After`; queue depth surfaced |
| Retries | Transient (connection, `429`, deadlock) → 3 attempts with jitter; semantic SQL errors are **not** retried, they trigger the repair loop |
| Pagination | Result sets capped at 1,000 rows with `nextCursor`; conversation history keyset paginated |
| Partial failures | Schema retrieval timeout → fall back to curated core schema, flagged `degraded`; chart-spec failure → text answer only; repairs capped at 2 |
| Schema migrations | Semantic-model versioning, expand/contract on tenant tables, embedding backfill migration |

## AI system

Multi-step loop: retrieve (schema slice + top-5 verified question→SQL examples) → generate → validate AST → execute with limits → repair on error (≤ 2) → summarize + chart spec.

Guardrails are code, not prompt text:

- Single statement, `SELECT` only, allowlisted tables and columns.
- No PII columns, no cross-tenant predicates, no `pg_sleep`/`pg_read_file`/`COPY`.
- `LIMIT` injected when absent.
- Connection uses `queryline_reader` with `SELECT` on the allowlist only and `default_transaction_read_only = on`.
- `statement_timeout = 8s`, `idle_in_transaction_session_timeout = 10s`.

## Eval contract

Golden set: 200 questions (140 answerable, 40 should-refuse, 20 ambiguous → clarify) across three seeded schemas. Plus a 40-case adversarial suite (injection, PII extraction, cross-tenant probes) where any execution is a hard failure.

| Metric | Target |
|---|---|
| Execution accuracy (result-set match) | ≥ 0.78 |
| Valid-SQL rate | ≥ 0.98 |
| Refusal precision / recall | ≥ 0.90 / ≥ 0.85 |
| Unsafe query block rate | 100% (hard fail if any executes) |
| Repair recovery of first-attempt failures | ≥ 60% |
| p95 / p99 latency | ≤ 6s / ≤ 10s |
| Cost per query | ≤ $0.015 |

## Non-goals

- Writing SQL that modifies data. The product is read-only by construction.
- Warehouse-native optimizations (materialized view selection, clustering keys). The agent reads an existing model.
- Semantic-layer authoring UI. The model is versioned YAML, committed.
- Multi-turn follow-ups beyond the last three messages of context.
