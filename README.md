# AI Systems Portfolio

Three production-shaped AI systems in three distinct domains. Each one is a real system with real operating constraints — not a demo — and each ships with a Claude Code prompt pack: eight prompts, in build order, that take it from empty repo to instrumented, CI-gated service.

## The projects

| # | Project | Domain | Stack | Hardest problem | Headline eval |
|---|---|---|---|---|---|
| 1 | [Ledgerline](docs/projects/01-ledgerline.md) | Fintech — multi-PSP settlement reconciliation | TypeScript, Fastify, Postgres, Drizzle, BullMQ | Exactly-once postings under partial batch failure | Reason-code macro-F1 ≥ 0.85, ≤ $0.004/exception, p95 ≤ 2.5s |
| 2 | [Beacon](docs/projects/02-beacon.md) | SRE — on-call incident response agent | Python, FastAPI, Postgres + pgvector, Celery | Investigating with failing tools and a hard token budget | Root-cause top-1 ≥ 0.75, 0 unsafe actions, ≤ $0.12/incident |
| 3 | [Queryline](docs/projects/03-queryline.md) | Analytics — self-serve text-to-SQL copilot | TypeScript, Fastify, Postgres / SQL Server / Oracle, BullMQ | Arbitrary user input against a read-only warehouse | Execution accuracy ≥ 0.78, 100% unsafe-query block rate |

> **Queryline is implemented.** See [`queryline/`](queryline/README.md) for the working TypeScript service with PostgreSQL, SQL Server, and Oracle adapters, AST guardrails, the agent loop, eval harness, API, and BullMQ worker.

## What every project demonstrates

Not claimed in a README — each has a test that fails if the behaviour is removed:

- **Backpressure** — bounded queues, per-tenant concurrency caps, load shedding with `429` + `Retry-After`
- **Retries** — exponential backoff with jitter, transient vs poison classification
- **Pagination** — keyset cursors only; no `OFFSET`
- **Partial failures** — per-row or per-tool degradation, never all-or-nothing
- **Schema migrations** — expand/contract, concurrent index creation, batched backfills, tested rollbacks

## Prompt packs

Each pack follows the same eight stages, so the packs are comparable:

1. Scaffolding — monorepo for the chosen stack
2. Contracts — OpenAPI + GraphQL, then generated typed clients
3. Data — Postgres schema, migrations, deterministic seed data
4. Workers — queue with retries and dead-letter handling
5. Tests — unit + integration, coverage gates, determinism
6. AI — RAG or agent loop, eval harness, golden dataset
7. CI/CD — GitHub Actions for test, build, and container push
8. Instrumentation — OpenTelemetry traces, metrics, logs

- [Ledgerline prompts](docs/prompt-packs/01-ledgerline-prompts.md)
- [Beacon prompts](docs/prompt-packs/02-beacon-prompts.md)
- [Queryline prompts](docs/prompt-packs/03-queryline-prompts.md)

Run one prompt per branch (`feat/01-scaffold` … `feat/08-otel`), review the plan Claude Code proposes, then verify the **Done when** block before committing. Those blocks are where the interview stories come from.

## Build order

1. **Ledgerline** — strongest hiring signal: money, idempotency, migrations.
2. **Beacon** — the most AI-native: bounded agent loop with human approval gates.
3. **Queryline** — broadest audience: every data team wants this.

## Standards

- [Eval standards](docs/eval-standards.md) — how metrics, baselines, and CI gates are defined
- [Stack decisions](docs/stack-decisions.md) — why these stacks, and what was deliberately excluded
- [Definition of done](docs/definition-of-done.md) — the checklist every project must pass

## Layout

```
ai-systems-portfolio/
├── README.md
└── docs/
    ├── eval-standards.md
    ├── stack-decisions.md
    ├── definition-of-done.md
    ├── projects/
    │   ├── 01-ledgerline.md
    │   ├── 02-beacon.md
    │   └── 03-queryline.md
    └── prompt-packs/
        ├── 01-ledgerline-prompts.md
        ├── 02-beacon-prompts.md
        └── 03-queryline-prompts.md
```

Each project lives in its own repository. This repo is the spec and prompt-pack index.
