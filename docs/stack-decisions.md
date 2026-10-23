# Stack Decisions

The bias is deliberate: use what teams actually run, and pick a stack that makes the hard problem visible instead of hiding it behind a framework.

## Shared defaults

| Concern | Choice | Why |
|---|---|---|
| Runtime | Node 22 LTS / Python 3.12 | Current LTS lines; both are what 2025 teams deploy |
| Database | Postgres 16 | One engine covers OLTP, JSON, full-text, and vectors via pgvector |
| Queue | BullMQ (TS) / Celery (Python) | Boring, debuggable, widely operated; both expose retry and DLQ primitives without a workflow engine |
| Contracts | OpenAPI 3.1 first | Generates clients, docs, and contract tests from one source |
| Tests | Vitest + Testcontainers / pytest + Testcontainers | Real Postgres and Redis in tests; no mocked database semantics |
| Telemetry | OpenTelemetry + OTLP | Vendor-neutral; traces must cross HTTP → queue → worker |
| Containers | Multi-stage, distroless-ish, non-root | Portfolio code should look deployable |

## Per-project choices

### Ledgerline — TypeScript

- **Fastify over NestJS**: less abstraction between the request and the reconciliation logic being demonstrated. The interesting code should be visible in a route handler's call stack.
- **Drizzle over Prisma**: reconciliation needs window functions, `CONCURRENTLY` index creation, table partitioning plans, and hand-tuned keyset queries. Drizzle stays close to SQL.
- **GraphQL Yoga for the read model only**: mutations stay REST so idempotency and 207 semantics are explicit instead of encoded in GraphQL errors.
- **BullMQ over Temporal**: the requirement is a queue with visible retries and a DLQ. Temporal would hide both behind workflow state.
- **Postgres row-level tenancy over schema-per-tenant**: simpler migrations, and the per-tenant fairness work lives in the queue, where it belongs.

### Beacon — Python

- **Custom agent loop over LangGraph**: the loop is under 300 lines and every guardrail is readable. A framework would obscure the step cap, budget, and approval gate that the project is meant to demonstrate.
- **Celery over asyncio background tasks**: acks_late, prefetch=1, and a real DLQ table are the point. In-process tasks cannot show crash-resume.
- **SQLAlchemy 2 async + Alembic**: async I/O for tool fan-out, and Alembic's autocommit blocks make concurrent index creation explicit.
- **pgvector over a separate vector store**: one database to operate, and retrieval quality is not the differentiator here.
- **`uv` over pip/poetry**: lockfile speed and reproducibility.

### Queryline — TypeScript

- **Prisma over Drizzle**: this project is schema- and migration-shaped; Prisma's migration story is the more representative one for a data team. Generated SQL is executed through `$queryRaw` by design, not through the ORM.
- **`node-sql-parser` for AST validation**: regex-based SQL blocking is not acceptable when the input is user-controlled. The allow/deny decision is made on a parsed tree.
- **Dedicated read-only Postgres role**: defence in depth. Even a guardrail bug cannot write, thanks to role grants plus `default_transaction_read_only`.
- **Cost-based admission control via `EXPLAIN`**: the realistic failure mode for a text-to-SQL product is a cartesian join melting the warehouse, not a syntax error.

## Deliberately excluded

- **No vector database service** (Pinecone/Qdrant/Weaviate). pgvector is enough at these volumes and removes an operational dependency.
- **No microservice split.** One deployable API plus one worker per project. Service boundaries here would be theatre.
- **No custom model training.** Every AI layer is evaluation-driven prompting plus retrieval; fine-tuning would add cost without adding signal at this scale.
- **No UI framework.** API, CLI, and the eval report are the interface. A dashboard is a separate decision, not a default.
- **No Kubernetes manifests.** Docker Compose for local, GHCR images for deploy. The portfolio is about system behaviour, not YAML volume.

## Version pinning

- Node and Python versions are pinned in `.nvmrc` / `.python-version`.
- Container base images are pinned by digest in CI.
- Model ids live in exactly one config file per repo (`config/models.ts`, `beacon/config/models.py`) so eval numbers stay comparable across runs.
