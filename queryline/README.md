# Queryline

Self-serve analytics copilot. A user asks a business question; the agent retrieves the relevant schema, generates one read-only `SELECT`, validates it, runs it under a locked-down role, repairs its own errors, and returns rows plus a chart spec.

**Supported warehouses: PostgreSQL, SQL Server, and Oracle** — real adapters, not a Postgres abstraction with a dialect string.

## Why this is not a toy

The failure mode that matters is not a wrong answer — it is a cartesian join that melts a production warehouse, or a generated query that reads another tenant's data. Both are handled in code:

| Concern | Implementation |
|---|---|
| **Backpressure** | Per-tenant semaphore (3) + global cap (12) in the worker; queue depth > 200 returns `429` with `Retry-After` |
| **Retries** | Transient driver errors retried 3× with exponential backoff; statement timeouts are **not** retried; semantic SQL errors go to the repair loop instead |
| **Pagination** | Keyset cursors on query history; result rows paged by offset with a hard 1,000-row cap; paging past page 1 requires `ORDER BY` |
| **Partial failures** | Schema retrieval falls back to the core catalog (`degraded: ["schema_fallback"]`); missing chart spec returns rows + text; lexical validation and unverified admission are surfaced as flags |
| **Schema migrations** | `sql/warehouse.*.sql` per dialect; control plane is Postgres with expand/contract-friendly tables and pgvector behind a separate migration |

## Dialect support

| Capability | PostgreSQL | SQL Server | Oracle |
|---|---|---|---|
| Pagination wrapper | `LIMIT/OFFSET` | `ORDER BY (SELECT NULL) OFFSET/FETCH` | `OFFSET/FETCH` (12c+) |
| Identifier folding | lower-case | as written | UPPER-case |
| Plan estimate | `EXPLAIN (FORMAT JSON)` | `SET SHOWPLAN_XML ON` | `EXPLAIN PLAN` + `PLAN_TABLE` |
| Read-only enforcement | `SET TRANSACTION READ ONLY` + grants | reader role (grants) + `LOCK_TIMEOUT` | `SET TRANSACTION READ ONLY` + grants |
| Statement timeout | `statement_timeout` | `requestTimeout` + `LOCK_TIMEOUT` | `callTimeout` |
| AST validation | `node-sql-parser` (Postgresql) | `node-sql-parser` (TransactSQL) | parsed as Postgresql, lexical fallback |
| Row cap | outer subquery `LIMIT` | outer `OFFSET/FETCH` | outer `FETCH FIRST` |

Dialect selection is one env var: `WAREHOUSE_KIND=postgres|mssql|oracle`.

## Guardrails (code, not prompt)

1. **Single statement, SELECT only.** Lexical pre-check runs before parsing so `DELETE`, `DROP`, `MERGE`, `xp_cmdshell`, `DBMS_*`, `UTL_*`, `pg_read_file`, etc. are rejected even if a parser would accept them.
2. **Table allowlist** from live introspection. Unknown tables are repairable (the model retries); destructive constructs are not.
3. **PII projection blocking.** Explicit PII columns are a hard refusal; `SELECT *` over a table containing PII is a repairable refusal.
4. **Tenant predicate enforcement.** Any tenant-scoped table must carry `tenant_id = '<caller>'`.
5. **Admission control.** `EXPLAIN` runs before execution; plans above 5M estimated rows or a cost ceiling are rejected.
6. **Read-only execution.** Dedicated reader role, read-only transaction, statement timeout, bounded rows.

Safety refusals (`pii_column`, `forbidden_keyword`, `missing_tenant_predicate`, `multiple_statements`) are never repaired — retrying a safety violation is how guardrails get talked around.

## Architecture

```
POST /v1/questions
        │
        ▼
  Fastify ──▶ BullMQ (query.run) ──▶ worker
                                      │
        retrieve schema slice ────────┤  (lexical now; pgvector tables included)
        generate JSON ────────────────┤
        validate (AST + lexical) ─────┤
        admit (EXPLAIN) ──────────────┤
        execute (reader role) ────────┤
        repair ≤ 2 ───────────────────┘
                                      │
                                      ▼
                       queries table (Postgres control plane)
```

The control plane is always Postgres (query history, verified examples, dead letters, optional pgvector). Only the warehouse side is multi-dialect.

## Quick start

### No Docker (embedded Postgres)

```bash
cd queryline
cp .env.example .env     # then set ports to 55432 if 5432 is reserved on Windows
pnpm install
pnpm dev:db              # terminal 1: embedded Postgres on :55432
pnpm db:migrate && pnpm db:seed
pnpm smoke               # proves guard -> admission -> execute on real data
pnpm dev                 # terminal 2: API on :3000
```

The local `.env` should use port 55432 on Windows, which commonly reserves 5432
(WinNAT/Hyper-V); binding it surfaces as `could not bind ... Permission denied`.

### Docker

```bash
cd queryline
cp .env.example .env
docker compose up -d postgres redis jaeger

pnpm install
pnpm db:migrate          # control plane + warehouse DDL
pnpm db:seed             # deterministic 40 customers / 120 orders / 200 line items

# mock provider: proves the pipeline, always refuses
pnpm dev                 # http://localhost:3000/healthz

# real generation
# .env: MODEL_PROVIDER=openai, MODEL_API_KEY=sk-...
pnpm eval                # 18 golden cases, threshold-gated
```

### SQL Server

```bash
docker compose --profile mssql up -d
# .env
WAREHOUSE_KIND=mssql
WAREHOUSE_PORT=1433
WAREHOUSE_USER=sa
WAREHOUSE_PASSWORD='Queryline!Passw0rd'
WAREHOUSE_DATABASE=master
pnpm db:migrate && pnpm db:seed
pnpm eval   # evals/golden/questions.mssql.jsonl
```

### Oracle

```bash
docker compose --profile oracle up -d   # first boot takes several minutes
# .env
WAREHOUSE_KIND=oracle
WAREHOUSE_PORT=1521
WAREHOUSE_USER=queryline
WAREHOUSE_PASSWORD='Queryline!Passw0rd'
WAREHOUSE_SERVICE_NAME=FREEPDB1
pnpm db:migrate && pnpm db:seed
pnpm eval   # evals/golden/questions.oracle.jsonl
```

## Eval harness

`pnpm eval` runs the golden set for the configured dialect and compares **result-set hashes**, not SQL strings — two correct queries can look different. Row order is ignored unless the case declares `"ordered": true`.

Metrics: execution accuracy, answer rate, refusal precision/recall, unsafe-block rate, repair recovery, p50/p95 latency, cost per query. Thresholds live in `evals/thresholds.json` and the run exits non-zero on breach. Any executed unsafe query is a hard failure.

Cassette mode is not wired yet; CI runs unit/integration tests and a build, and the live eval runs nightly with a provider key.

## Tests

```bash
pnpm typecheck
pnpm test        # guard matrix, dialect SQL, agent loop, API, metrics
```

The guard matrix is property-oriented: `tests/guard.test.ts` covers DDL, multi-statement, PII, wildcard PII, tenant isolation, keyword-in-string, CTE and subquery resolution, and the Oracle lexical fallback.

## Deviations from the spec

- **`pg` + SQL migrations instead of Prisma.** The control plane needs pgvector index control and the warehouse side is already raw SQL across three dialects; an ORM would add codegen without hiding anything. SQL lives in `sql/`.
- **Single package, not a pnpm workspace.** Modules are split by domain (`api`, `worker`, `ai`, `warehouse`) so the workspace split is mechanical if the project grows.
- **Retrieval is lexical.** pgvector tables are migrated but no embedding provider is wired yet.

## Known limitations

- **Oracle validation can fall back to lexical.** `node-sql-parser` has no Oracle grammar. Statements that fail a Postgres parse are checked lexically and flagged `validation: "lexical"` in the trace and response. The reader role and read-only transaction are the backstop.
- **One tenant predicate satisfies the guard.** Aliased multi-table queries are not checked per alias. Production would pair this with row-level security (Postgres) or per-tenant views (MSSQL/Oracle).
- **Admission control is best-effort.** Without `SHOWPLAN` permission (MSSQL) or a `PLAN_TABLE` (Oracle) the estimate is `unverified` and the query proceeds under the timeout and row cap.
- **Retrieval is lexical.** The pgvector tables exist and the control-plane migration creates them; wiring an embedding provider is the next step.
- **Seeding requires write privileges.** The runtime user should be `queryline_reader`; seeding uses the adapter's explicit `admin()` path, which is never reachable from the agent.
- **No UI.** API + CLI + eval report only.

## Layout

```
queryline/
├── src/
│   ├── dialect.ts            # per-engine quoting, folding, pagination, explain
│   ├── guard.ts              # lexical + AST validation, tenant/PII rules
│   ├── admission.ts           # EXPLAIN-based cost gate
│   ├── catalog.ts             # governance metadata (tenant-scoped, PII)
│   ├── warehouse/             # postgres.ts, mssql.ts, oracle.ts
│   ├── ai/                    # model client, retrieval, loop, metrics, harness
│   ├── api/                   # Fastify server + memory/pg store
│   └── worker/                # BullMQ queue, processor, DLQ
├── sql/                       # control plane + warehouse DDL per dialect
├── evals/                     # golden sets + thresholds
├── scripts/                   # migrate, seed, eval, dlq
├── contracts/openapi.yaml
└── tests/
```
