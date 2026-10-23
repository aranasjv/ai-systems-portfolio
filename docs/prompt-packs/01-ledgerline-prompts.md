# Ledgerline — Claude Code Prompt Pack

Eight prompts, in build order. Run one per branch: `feat/01-scaffold` … `feat/08-otel`.

For each: paste the prompt, let Claude Code produce a plan, review it against the prompt's constraints, accept, then verify the **Done when** block before committing. If a Done-when check fails, fix it in the same branch — do not carry it forward.

Project spec: [01-ledgerline.md](../projects/01-ledgerline.md)

---

## 1. Scaffolding

```
Context: greenfield repo "ledgerline", a settlement reconciliation engine
(TypeScript). Nothing exists yet except an empty git repo.

Scaffold a pnpm + Turborepo monorepo:

apps/api        Fastify 5 HTTP server
apps/worker     BullMQ worker process
packages/contracts  OpenAPI/GraphQL specs + generated clients
packages/db     Drizzle schema, migrations, seed
packages/ai     triage + embeddings + eval harness
packages/observability  OTel setup shared by api and worker
packages/testing     testcontainers helpers, factories

Requirements:
- Node 22, TypeScript strict, ESM, `tsx` for dev, `tsup` for build.
- ESLint + Prettier with one shared config; `pnpm lint` fails on warnings.
- Vitest workspace config with projects: unit, integration, contract.
- docker-compose.yml: postgres:16 + pgvector, redis:7-alpine,
  otel-collector, jaeger, prometheus, grafana (provisioned datasource only).
- .env.example with every variable, .env gitignored, zero secrets committed.
- Root scripts: dev, build, typecheck, lint, test, db:migrate, db:seed,
  eval, contracts:gen, contracts:check.
- Health endpoints in api: /healthz (liveness) and /readyz (DB + Redis).
- CLAUDE.md documenting: architecture map, every command, and the
  non-negotiables (idempotency keys, money as integer minor units + currency,
  cursor pagination only, expand/contract migrations, no business logic in
  route handlers).

Do not add business logic in this step. Optimize for a clean base.

Done when: `pnpm install`, `pnpm typecheck`, `pnpm build`, `pnpm lint` all
pass; `docker compose up -d` reports all services healthy; `pnpm dev` serves
/healthz on :3000 returning service name, version, and git sha.
```

---

## 2. Contracts

```
Context: ledgerline monorepo, scaffolded. Add the API contract layer in
packages/contracts. Spec-first: the YAML and SDL are the source of truth.

REST (OpenAPI 3.1, openapi.yaml):
- POST /v1/ingestion-batches   multipart file upload; requires Idempotency-Key
  header; returns 202 with batch id, or 207 with per-row results.
- GET  /v1/ingestion-batches   cursor paginated list
- GET  /v1/ingestion-batches/{id}
- GET  /v1/exceptions          cursor paginated, filters: status, reason_code,
  psp, amount_min, amount_max
- POST /v1/exceptions/{id}/resolve   body: reason_code, note, candidate_ids[]
- GET  /v1/reconciliations/{id}  run summary with counts
- Errors: RFC 9457 application/problem+json everywhere, with `type`,
  `title`, `status`, `detail`, `trace_id`.
- Pagination envelope: { data: [...], pageInfo: { nextCursor, hasMore } }.
- Document 429/Retry-After and 207 explicitly with schemas.

GraphQL (schema.graphql, Yoga):
- Read model: ExceptionConnection (Relay cursor connections), Resolution,
  Batch, RunSummary. No mutations — mutations stay REST.

Generate:
- `openapi-typescript` types + `orval` fetch client and zod schemas.
- `@graphql-codegen/client-preset` typed operations.
- All generated output into packages/contracts/src/generated (committed).

Guardrails:
- Spectral lint with a ruleset requiring operationId, error responses,
  429 on write routes, and pagination params on collections.
- `pnpm contracts:check` regenerates and fails if git diff is non-empty.
- Contract tests asserting spec and generated client agree on every route.

Done when: contracts:gen and contracts:check pass; a smoke test uses the
generated client to call the live API and type-checks without `any`.
```

---

## 3. Data

```
Context: ledgerline monorepo with contracts in place. Build the Postgres
layer in packages/db with Drizzle ORM + drizzle-kit.

Schema (money as bigint minor units + currency char(3); never float):
  tenants, psp_accounts, ingestion_batches, settlement_rows,
  ledger_entries, reconciliation_runs, exceptions, resolutions,
  resolution_embeddings(vector(1024)), dead_letter_jobs, outbox_events.

Migrations — four steps, each reversible, zero-downtime safe:
  0001_init            core tables, enums, constraints
  0002_keyset_indexes  (tenant_id, created_at DESC, id DESC) keyset indexes,
                       partial index on open exceptions, pg_trgm index on
                       settlement_rows.reference; all CREATE INDEX CONCURRENTLY
  0003_embeddings      pgvector extension + resolution_embeddings
  0004_outbox          outbox_events + dlq table
Every migration must include a documented rollback and a note on lock level.
The repo must include a batched backfill job pattern (1k rows per tick) used
by 0004, not a single UPDATE.

Seed script `pnpm db:seed --scale small|large`, deterministic (fixed RNG seed):
- small: 2 tenants, 20k settlement rows, 2k ledger entries, 800 exceptions.
- large: 20 tenants, 2M settlement rows, 300k ledger entries, 8k exceptions,
  realistic skew (3 PSPs = 70% of volume, 4 reason codes = 80% of exceptions),
  500 resolved exceptions with written resolutions to seed the eval corpus.
- Use COPY / multi-row inserts in batches of 5k.

Also generate evals/golden/exceptions.jsonl: 500 rows, stratified across 12
reason codes, with `label`, `confidence_slice`, and `human_verified` fields
(150 true).

Done when: migrate from an empty database succeeds; rollback works; seed
small completes < 10s and large < 90s; `EXPLAIN (ANALYZE)` on the exceptions
keyset query shows an index scan with no sort; a test asserts the endpoint
query plan does not sequentially scan.
```

---

## 4. Workers

```
Context: ledgerline monorepo, DB + contracts done. Implement the async
pipeline in apps/worker using BullMQ on Redis 7.

Queue `reconcile.batch`:
- Worker concurrency 4, limiter 50 jobs/sec, attempts 5, exponential backoff
  base 2000ms with full jitter.
- Job id = sha256(batchId + tenantId) so duplicate enqueues are no-ops.
- Per-tenant fairness: at most 2 in-flight jobs per tenant; a tenant cannot
  starve others (document the mechanism and test it).

Backpressure:
- Track queue depth + oldest-job age in Redis.
- api returns 429 + Retry-After when depth > 5000 or p95 lag > 30s.
- Worker uses pause/resume on Redis memory pressure and drains on SIGTERM
  (stop intake, finish in-flight ≤ 25s, close pools, exit 0).

Failure handling:
- Classify transient (network, deadlock, 5xx) vs poison (validation, schema).
  Poison fails fast to DLQ on attempt 1 and does not burn 5 attempts.
- DLQ = `reconcile.dlq` queue + `dead_letter_jobs` table with payload,
  attempt count, error class, first/last seen.
- Replay CLI: `pnpm dlq:list`, `pnpm dlq:replay --id <id>|--all [--dry-run]`.
- Postings go through the outbox + a unique constraint so any replay is
  idempotent at the database level, not just in code.

Partial failure semantics: one bad row is quarantined, the batch continues,
and the 207 response reports accepted/rejected row counts with row numbers.

Done when these integration tests pass against Testcontainers:
(a) transient fault retried with visibly increasing delays (fake timers);
(b) poison row lands in DLQ on attempt 1 while the batch still completes;
(c) SIGTERM mid-job leaves zero duplicate ledger entries;
(d) replaying a DLQ job is a no-op on already-applied postings;
(e) a third tenant cannot exceed the 2-in-flight cap.
```

---

## 5. Tests

```
Context: ledgerline monorepo, workers implemented. Build the test suite.

Vitest workspace projects:
- unit: pure logic, no IO, < 5s total
- integration: Testcontainers postgres + redis, isolated schema per test
- contract: generated client vs spec
- eval-smoke: recorded LLM cassettes, no network

Coverage:
- Matching engine (> 90% lines): amount tolerance, FX conversion, rounding
  boundaries, duplicate detection, tie-breaking, zero/negative amounts.
- Property-based tests with fast-check: reconciliation is order-independent
  and never posts the same ledger entry twice.
- Integration: full ingest → reconcile → exception → resolve flow on a
  200-row fixture; keyset pagination stability while rows are inserted
  concurrently (no duplicates, no skips); 207 partial failure contract;
  DLQ replay idempotency.
- Determinism: freeze clock, seed all randomness, no shared mutable fixtures.
- Factories instead of fixture files (buildTenant, buildBatch, buildException).
- Coverage gates in config: 85% lines overall, 90% on packages/db + matching,
  100% on guardrail branches (abstain, amount threshold).

Done when: `pnpm test` completes < 120s cold; the suite passes 3 consecutive
runs with zero flakes; coverage gates fail the build when violated (prove it
by temporarily deleting a test).
```

---

## 6. AI

```
Context: ledgerline monorepo, tests green. Implement AI-assisted exception
triage in packages/ai and the eval harness.

Pipeline (deterministic first, model second):
1. Candidate generation in SQL — amount ±1%, date ±3 days, same currency,
   pg_trgm reference similarity > 0.4; top 10 candidates with features.
2. Retrieval — embed exception summary with text-embedding-3-small
   (dimensions=1024), cosine top-5 resolved cases from resolution_embeddings.
3. One structured call — JSON schema output
   { reason_code, candidate_ids[], confidence 0-1, rationale, citations[] }.
   temperature 0, max 800 output tokens, 10s timeout.
4. Validation — reject any candidate_id or citation not in the retrieved set,
   retry exactly once with a corrective message, then abstain.

Guardrails:
- confidence < 0.60 → abstain, route to human queue, never auto-post.
- amount > $10,000 → human approval regardless of confidence.
- Every suggestion persists prompt_version, model, tokens, cost, latency.

Cost/latency:
- Embedding cache keyed by content hash; exact-result cache keyed by
  (exception fingerprint, prompt_version). Target ≥ 40% hit on replay.

Eval harness `pnpm eval` over the frozen 500-row golden set:
- Metrics: reason-code macro-F1, top-1/top-3 candidate accuracy, abstention
  recall + precision, citation validity, p50/p95/p99 latency, cost per
  exception, cache hit rate.
- Output evals/results.json + evals/report.md (table + failure samples
  grouped by reason code).
- Thresholds in evals/thresholds.json; exit non-zero on breach.
- `--limit 50 --cassette` mode for CI (no network, deterministic).

Targets: macro-F1 ≥ 0.85, top-1 ≥ 0.70, top-3 ≥ 0.90, abstention recall
≥ 0.90, abstain rate ≤ 25%, citation validity 100%, p95 ≤ 2.5s,
cost ≤ $0.004/exception.

Done when: `pnpm eval` produces the report and meets every threshold;
CI runs the 50-row cassette eval on every PR; a deliberately broken prompt
regresses macro-F1 by > 2 points and fails the gate.
```

---

## 7. CI/CD

```
Context: ledgerline monorepo, app + eval harness complete. Add GitHub Actions.

ci.yml (PR + main):
- pnpm store cache; concurrency group cancels superseded PR runs.
- Jobs: lint+typecheck, unit, integration (services: postgres:16 with
  pgvector, redis:7), contracts:check, eval-smoke (cassettes), build.
- Integration job must create the vector extension before tests.
- Upload coverage + eval results as artifacts; annotate the PR with the
  eval report table.
- Total wall clock target < 12 minutes.

docker.yml (main + tags v*):
- buildx multi-arch (linux/amd64, linux/arm64) for api and worker.
- GHCR push with tags: sha, semver, latest (latest only on tags).
- Registry cache (type=gha); SBOM + provenance attestations.
- trivy scan, fail on HIGH/CRITICAL.
- Only run after ci succeeds (workflow_run or needs).
- Images: non-root user, read-only rootfs, no build toolchain in final layer,
  pinned base digest.

nightly.yml: full eval (no cassettes) + large seed + smoke load test,
publish the report as an artifact and fail on threshold breach.

Also add a PR template with the "which concern did you touch" checklist
(backpressure / retries / pagination / partial failure / migrations).

Done when: PR with a failing eval threshold is blocked; docker build uses
cache and finishes < 6 min on a warm cache; `docker run` of the api image
serves /healthz as a non-root user; all workflow YAML passes actionlint.
```

---

## 8. Instrumentation

```
Context: ledgerline monorepo, CI in place. Add end-to-end OTel.

Tracing:
- @opentelemetry/sdk-node in api and worker; OTLP HTTP exporter.
- Resource attributes: service.name, service.version (git sha),
  deployment.environment.
- Auto-instrument http, fastify, pg, ioredis.
- Custom spans:
  reconcile.batch { tenant.id, batch.id, row.count, attempt, outcome }
  match.candidates { candidate.count, strategy }
  triage.call { llm.model, prompt_version, input_tokens, output_tokens,
                cost_usd, confidence, abstained }
- W3C traceparent injected into the BullMQ job payload and extracted in the
  worker so one trace spans HTTP → enqueue → worker → Postgres → LLM.
  Add a test asserting trace_id equality across the boundary.

Metrics (OTel meter):
  queue.depth (gauge), job.duration (histogram), job.failures
  (counter, by reason), dlq.size (gauge), ingest.rows (counter),
  llm.cost_usd (counter), triage.abstain_rate (gauge).

Logs:
- pino with trace_id/span_id on every line; no PII, no account numbers.
- Collector config: batch processor + tail sampling (100% errors, 10% success).

Dashboards (provisioned JSON): p95 latency, queue depth vs 429 rate, DLQ
growth, cost/hour, abstain rate, per-tenant fairness.

Done when: `docker compose up`, POST one batch, and Tempo shows a single
trace with ≥ 8 spans crossing enqueue and worker; Grafana panels render real
data; a test asserts PII redaction and that span attributes never include
raw account numbers.
```
