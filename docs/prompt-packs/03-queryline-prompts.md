# Queryline — Claude Code Prompt Pack

Eight prompts, in build order. One branch per prompt, verify the Done-when block before committing.

Project spec: [03-queryline.md](../projects/03-queryline.md)

---

## 1. Scaffolding

```
Context: greenfield repo "queryline", a self-serve analytics copilot
(TypeScript). Empty git repo.

Scaffold a pnpm + Turborepo monorepo:

apps/api            Fastify 5, multi-tenant auth stub
apps/copilot-worker BullMQ consumer for long-running analyses
packages/contracts  OpenAPI + generated client + shared response types
packages/db         Prisma schema, migrations, warehouse seed
packages/semantic   semantic-model definitions (metrics, joins, PII rules)
packages/ai         agent loop, SQL guardrails, eval harness
packages/observability
packages/testing

Requirements:
- Node 22, TS strict, ESM, tsup build, tsx dev, ESLint + Prettier.
- Vitest workspace: unit, integration, contract, eval.
- docker-compose.yml: postgres:16 + pgvector, redis:7, otel-collector,
  jaeger, prometheus, grafana.
- .env.example; nothing secret committed.
- Root scripts: dev, build, typecheck, lint, test, db:migrate, db:seed,
  eval, contracts:gen, contracts:check, guardrails:test.
- CLAUDE.md: architecture, commands, non-negotiables (read-only DB role for
  all generated SQL, every query has a statement_timeout, no generated SQL
  is ever executed without AST validation, per-tenant isolation at the query
  level, no PII columns in any response).

No business logic yet.

Done when: install/typecheck/build/lint pass; compose healthy; pnpm dev
serves /healthz.
```

---

## 2. Contracts

```
Context: queryline scaffolded. Define contracts spec-first.

contracts/openapi.yaml (3.1):
- POST /v1/questions       { tenant_id, question, conversation_id? } →
                            202 { query_id }; requires Idempotency-Key
- GET  /v1/queries/{id}     status, sql, result_preview, chart_spec,
                            refusal{reason}, degraded[], repair_attempts
- GET  /v1/queries          cursor paginated, filters tenant/status/outcome
- GET  /v1/queries/{id}/rows  paginated result rows (max 1000/page) with
                            nextCursor
- GET  /v1/conversations/{id}/messages  cursor paginated
- GET  /v1/semantic/models  versioned semantic model metadata
- Errors: RFC 9457 problem+json; explicit 429 with Retry-After; explicit
  refusal shape (not an error) with reason codes.

Generate: openapi-typescript types + orval fetch/zod client; commit output.
Add a `refusal_reason` enum shared between spec and packages/semantic.

Contract tests: route/spec parity, refusal enum parity, pagination envelope
parity across all collection endpoints.

Done when: contracts:check fails on drift; generated client compiles with no
`any`; the parity test covers every route in the Fastify route table.
```

---

## 3. Data

```
Context: queryline with contracts. Build the warehouse + app schema.

Prisma schema with two logical schemas:
- app: tenants, users, conversations, messages, queries, query_rows_cache,
  query_events, dead_letter_jobs, semantic_model_versions, few_shot_examples,
  example_embeddings(vector(1024)).
- warehouse: orders, order_items, customers, products, refunds, subscriptions,
  invoices, plans, support_tickets — with realistic volume, FKs, and
  intentional messiness (nullable regions, duplicate customers, timezone
  drift) so generated SQL must actually be correct.

Migrations:
- Expand/contract pattern demonstrated across 3 migrations (add nullable
  column → dual write → backfill in 5k batches → switch reads → drop).
- Warehouse seed: 3 coherent schemas (ecommerce, saas_billing, support),
  250k orders, 40k customers, 60k subscriptions, 30k tickets; deterministic
  seed. `pnpm db:seed --schema ecommerce --scale small|large`.
- A DEDICATED read-only Postgres role `queryline_reader` with SELECT on
  warehouse and app allowlist only; revoke everything else. Migration must
  create it idempotently.
- Golden eval corpus: evals/golden/questions.jsonl with 200 entries
  {question, schema, expected_sql, expected_rows_hash|null, label:
  answerable|refuse|clarify, expected_refusal_reason}.

Done when: migrate from empty works; seed small < 60s; the reader role can
SELECT warehouse tables but is denied on app.tenants (prove it in a test);
the golden corpus is hash-stable.
```

---

## 4. Workers

```
Context: queryline with DB + read-only role. Implement async execution.

BullMQ queue `query.run`:
- Worker concurrency 4; global in-flight cap 12; per-tenant cap 3 via Redis
  semaphore; limiter 20 jobs/sec.
- Admission control: run EXPLAIN (FORMAT JSON) on the candidate SQL with a
  2s timeout; reject when estimated rows > 5e6 or cost > threshold, with a
  structured refusal (not a crash).
- Execution: `SET statement_timeout = '8s'`, `SET idle_in_transaction_
  session_timeout = '10s'`, `SET default_transaction_read_only = on`,
  connect as queryline_reader, wrap in a transaction that rolls back.
- Backpressure: queue depth + oldest-age surfaced; API returns 429 +
  Retry-After above 200 queued or p95 > 12s.
- Retries: transient only (connection reset, serialization failure, 429),
  3 attempts with jitter. Semantic SQL errors are emitted to the agent's
  repair loop, never retried blindly.
- Cancellation: signed-in user can cancel; worker observes a Redis cancel
  key and calls pg_cancel_backend.
- DLQ: `dead_letter_jobs` table + `query.dlq`; CLI `pnpm dlq:list|replay`.
- Partial failure: if the chart-spec step fails, return rows + text answer
  with degraded=["chart"]; if summarization fails, return rows + SQL with
  degraded=["narrative"].

Done when tests prove: (a) 5 concurrent requests from one tenant never
exceed 3 in flight; (b) a 30s query is cancelled at the 8s timeout with a
clean refusal; (c) an oversized query is refused at admission without
executing; (d) transient error retries, semantic error does not; (e) cancel
stops the backend PID.
```

---

## 5. Tests

```
Context: queryline, execution layer done. Build the suite.

- Unit: AST guardrail allow/deny matrix (DDL, DML, COPY, multi-statement,
  pg_sleep, pg_read_file, cross-tenant predicate, PII column, unknown table),
  cost estimator thresholds, cursor encoding.
- Property-based (fast-check) on the guardrail: any generated SQL string that
  parses must be classified deny unless it is a single SELECT over allowlisted
  tables — never a false allow.
- Integration: question → generate → validate → execute → result flow with
  the seeded warehouse; pagination of 5,000 result rows with a stable cursor;
  conversation history pagination; per-tenant isolation test (tenant B's SQL
  cannot read tenant A rows even with a crafted JOIN).
- Contract: route/spec parity; refusal enum parity.
- Determinism: no live LLM in tests (cassettes), frozen clock, fixed seeds.
- Coverage: 85% overall, 100% on sql-guardrails.

Done when: `pnpm test` < 120s; guardrail matrix passes with 100% deny on all
attack fixtures; isolation test fails if the tenant predicate is removed
(prove it).
```

---

## 6. AI

```
Context: queryline, tests green. Implement the copilot loop + eval harness.

Loop (packages/ai):
1. Route: classify question → schema, or refuse (PII, out-of-scope,
   destructive intent) in one cheap structured call.
2. Retrieve: semantic model slice (tables, columns, metrics, joins, PII
   flags) + top-5 verified Q→SQL few-shots via pgvector over
   example_embeddings. Token budget for context: 4k.
3. Generate: single SELECT only, structured output {sql, explanation,
   chart_spec|null, confidence}.
4. Validate: node-sql-parser AST; enforce single statement, SELECT-only,
   allowlisted tables/columns, no PII columns, no cross-tenant predicates,
   LIMIT injected if absent.
5. Execute with the worker's limits.
6. Repair: on DB error, feed the exact error + schema fragment back; max 2
   repairs; classify as transient vs semantic and never retry transient as
   repair.
7. Answer: rows + narrative + caveats; degraded flags on partial failure.

Guardrails are code, not prompt: the model never gets a path to execute SQL.

Eval harness `pnpm eval`:
- 200 golden questions against 3 seeded schemas.
- Metrics: execution accuracy (normalized result-set hash match,
  order-insensitive unless ORDER BY), valid-SQL rate, refusal precision +
  recall, unsafe-block rate (must be 100%), repair recovery rate,
  p50/p95/p99 latency, cost/query, cache hit.
- Adversarial suite (40 cases): injection attempts, PII extraction,
  cross-tenant probes — any execution is a hard failure and exits non-zero.
- Outputs evals/results.json + evals/report.md + per-schema breakdown.

Targets: execution accuracy ≥ 0.78, valid SQL ≥ 0.98, refusal precision
≥ 0.90, recall ≥ 0.85, unsafe blocks 100%, repair recovery ≥ 60%,
p95 ≤ 6s, ≤ $0.015/query.

Done when: `pnpm eval` meets thresholds; `--cassette --limit 20` runs in CI
with no network; the adversarial suite blocks 100% and a deliberately
weakened guardrail turns the run red.
```

---

## 7. CI/CD

```
Context: queryline complete. Add GitHub Actions.

ci.yml:
- pnpm cache; concurrency cancel-in-progress; jobs: lint+typecheck, unit,
  integration (postgres with pgvector + redis services), contracts-check,
  guardrails:test, eval-smoke (cassette, 20 questions), build.
- Integration job seeds the small warehouse and creates the read-only role
  before tests.
- Upload eval report + coverage; PR comment with accuracy/refusal/latency.
- Fail the job if the adversarial suite reports any executed unsafe query.

docker.yml:
- buildx multi-arch for api + worker; GHCR sha/semver/latest; gha cache.
- SBOM + provenance; trivy HIGH/CRITICAL gate; non-root, read-only rootfs,
  pinned base digest.
- Runs only after ci.

nightly.yml: full 200-question eval + large seed; publish report; fail on
threshold breach or cost increase > 20%.

PR template: checkboxes for backpressure / retries / pagination / partial
failure / migrations / guardrails touched, plus "eval delta" field.

Done when: an unsafe-query fixture fails the build; warm docker build < 6
min; images run non-root and serve /healthz; actionlint clean.
```

---

## 8. Instrumentation

```
Context: queryline, CI complete. Add OTel.

- @opentelemetry/sdk-node in api + worker; OTLP HTTP; resource attrs
  service.name/version/env.
- Custom spans:
  question.route { schema, intent, refused, reason }
  context.retrieve { tables, few_shot_count, tokens }
  sql.generate { model, prompt_version, tokens, cost_usd }
  sql.validate { allowed, block_reason }
  sql.execute { tenant.id, duration_ms, row_count, timed_out, admitted,
                estimated_rows }
  sql.repair { attempt, error_class }
- Propagate traceparent into BullMQ job payload; assert one trace across
  API → worker → Postgres.
- Metrics: query.duration histogram by outcome, query.refusals counter
  {reason}, admission.rejected counter{reason}, db.timeout counter,
  tenant.inflight gauge, llm.cost_usd counter, repair.success_rate gauge.
- Logs: pino with trace_id; generated SQL logged with parameters redacted;
  question text never logged at info level (PII risk) — test asserts it.
- Grafana: p95 latency by outcome, refusal breakdown, admission rejects,
  cost/tenant/hour, repair success rate, timeout rate.

Done when: one question produces a single trace with ≥ 7 spans; dashboards
render; the log-redaction test passes; a blocked query shows
sql.validate.block_reason in the trace.
```
