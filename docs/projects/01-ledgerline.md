# Ledgerline

**Settlement reconciliation engine for a multi-PSP marketplace.**

Ingests PSP settlement files and internal ledger entries, matches them, and routes unmatched items into a review queue with AI-assisted triage.

- Prompt pack: [01-ledgerline-prompts.md](../prompt-packs/01-ledgerline-prompts.md)
- Stack: TypeScript
- Domain: fintech / treasury operations

## Why it isn't a toy

Real money movement, exactly-once postings, ~2M rows per day, a full audit trail, and reconciliation failures that must degrade per row rather than failing a whole batch. The interesting part is not "match two records" — it is what happens when row 480,003 is malformed while the previous 480,002 are already posted.

## Architecture

```
                 ┌──────────────┐
 PSP files ─────▶│  Fastify API │──▶ Postgres (settlement_rows, batches)
 (CSV / MT940)   │  /v1/ingest  │         │
                 └──────┬───────┘         │ outbox
                        │ enqueue         ▼
                   ┌────▼─────┐     ┌──────────────┐
                   │  Redis   │────▶│ BullMQ worker│──▶ matching engine
                   │ reconcile│     │  conc 4      │    (SQL candidates)
                   └────┬─────┘     └──────┬───────┘
                        │                  │
                   DLQ queue          triage call ──▶ pgvector retrieval
                        │                  │             of past resolutions
                        ▼                  ▼
                 dead_letter_jobs     exceptions + resolutions
```

## Stack

| Layer | Choice |
|---|---|
| Runtime | Node 22, TypeScript 5.7 strict, ESM |
| Monorepo | pnpm 9 workspaces + Turborepo |
| API | Fastify 5 (REST) + GraphQL Yoga 5 (read model) |
| Data | Postgres 16 + pgvector, Drizzle ORM + drizzle-kit |
| Queue | Redis 7 + BullMQ 5 |
| Contracts | OpenAPI 3.1 → `openapi-typescript` + `orval` (zod/fetch client); GraphQL SDL → `@graphql-codegen` |
| Tests | Vitest 3 + Testcontainers (`postgres:16`, `redis:7`) + `fast-check` |
| Observability | OTel Node SDK, OTLP collector, Tempo, Prometheus, Grafana |
| AI | Provider SDK with structured JSON output, `text-embedding-3-small` @ 1024 dims, pgvector retrieval |

## Non-functional requirements

| Concern | Concrete behaviour |
|---|---|
| Backpressure | Bounded queue (5k depth), per-tenant in-flight cap 2, worker concurrency 4 + rate limiter 50/s; API returns `429` + `Retry-After` when depth > 5k or p95 lag > 30s; CSV ingestion streamed, never fully buffered |
| Retries | 5 attempts, exponential backoff 2s → 32s with full jitter; transient vs poison classification; DLQ + replay CLI |
| Pagination | Keyset cursors `(created_at DESC, id DESC)` on `/v1/exceptions` and GraphQL connections; no `OFFSET` anywhere |
| Partial failures | `207` per-row result array; quarantined rows isolated; batch succeeds if ≥ 1 row accepted; a poison row costs zero extra attempts |
| Schema migrations | Expand/contract across four migrations, `CREATE INDEX CONCURRENTLY`, batched backfill job, zero-downtime rollout documented |

## AI system

Triage is **deterministic candidate generation + retrieval + one structured LLM call**.

1. Candidate matches come from SQL — amount ±1%, date ±3 days, same currency, `pg_trgm` reference similarity > 0.4; top 10 with features. Never from the model.
2. The top-5 most similar *resolved* exceptions are retrieved from `resolution_embeddings` by cosine distance.
3. One call returns `{ reason_code, candidate_ids[], confidence, rationale, citations[] }` at temperature 0, validated against the retrieved set.

Guardrails: confidence < 0.60 → abstain and route to a human; amount > $10k → always human; invented case IDs are rejected and retried exactly once. The model never posts a ledger entry.

## Eval contract

Golden set: 500 labeled exceptions (`evals/golden/exceptions.jsonl`), 12 reason codes, stratified, 150 human-verified, 50-row low-confidence slice, frozen hash.

| Metric | Target | Baseline to beat |
|---|---|---|
| Reason-code macro-F1 | ≥ 0.85 | rules-only 0.62 |
| Candidate top-1 / top-3 | ≥ 0.70 / ≥ 0.90 | 0.41 / 0.66 |
| Abstention recall on low-confidence slice | ≥ 0.90 | n/a |
| Overall abstain rate | ≤ 25% (anti-cheat ceiling) | n/a |
| Citation validity | 100% schema-valid | n/a |
| p95 / p99 latency | ≤ 2.5s / ≤ 4.0s | n/a |
| Cost per exception | ≤ $0.004 | n/a |
| Embedding/result cache hit | ≥ 40% on replay | n/a |
| CI regression gate | fail on −2 pts F1 or +20% cost | n/a |

## Non-goals

- FX rate sourcing. Rates are seeded fixtures; production would call a rates service.
- Dispute workflows after a human rejects a suggestion.
- Multi-currency ledger revaluation. The ledger stores minor units per currency and does not revalue.
