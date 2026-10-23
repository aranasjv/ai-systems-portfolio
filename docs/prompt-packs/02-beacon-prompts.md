# Beacon — Claude Code Prompt Pack

Eight prompts, in build order. One branch per prompt, verify the Done-when block before committing.

Project spec: [02-beacon.md](../projects/02-beacon.md)

---

## 1. Scaffolding

```
Context: greenfield repo "beacon", an on-call incident response agent
(Python). Nothing exists except an empty git repo.

Scaffold a Python 3.12 project managed with uv:

src/beacon/
  api/          FastAPI app, routers, deps
  agent/        loop, tools, prompts, guardrails
  db/           SQLAlchemy models, session, repositories
  workers/      Celery app + tasks
  evals/        replay harness, scorers, fixtures loader
  obs/          OTel setup
migrations/     Alembic
tests/          unit, integration, contract
scripts/        seed, fixture recorder

Requirements:
- pyproject.toml with dependency groups (dev/test/eval); uv.lock committed.
- ruff (format + lint, line length 100), mypy strict, pytest + pytest-asyncio
  with asyncio_mode=auto.
- docker-compose.yml: postgres:16 + pgvector, redis:7, otel-collector,
  jaeger, prometheus, grafana.
- .env.example, no secrets committed.
- Makefile targets: dev, test, test-integration, lint, typecheck, migrate,
  seed, eval.
- CLAUDE.md: architecture map, commands, non-negotiables (no action executes
  without approval, every LLM call has a budget, every tool call is traced,
  no unbounded loops, PII never enters prompts).

Do not implement agent logic yet.

Done when: `uv sync`, `make lint`, `make typecheck`, `make test` pass;
`docker compose up -d` is healthy; `make dev` serves /healthz and /readyz.
```

---

## 2. Contracts

```
Context: beacon repo scaffolded. Define the API contract spec-first.

Write contracts/openapi.yaml (OpenAPI 3.1) for:
- POST /v1/incidents            create from alert payload; Idempotency-Key
                                required; dedupe by fingerprint
- GET  /v1/incidents            cursor paginated, filters status/severity/service
- GET  /v1/incidents/{id}       includes evidence_manifest + degraded_sources
- POST /v1/incidents/{id}/investigate   starts the agent, returns 202 + run id
- GET  /v1/investigations/{id}  status, steps[], hypothesis, confidence,
                                citations[], cost, tokens
- POST /v1/proposals/{id}/approve | /reject   human-in-the-loop gate
- GET  /v1/tools/{tool}/results  cursor paginated (used by the agent itself)
- Errors: RFC 9457 problem+json including trace_id and retryable flag.

Then generate Python types with datamodel-code-generator into
src/beacon/api/generated, and a typed httpx client for internal tool calls.
Add a contract test suite that fails if a route exists in code but not in the
spec (and vice versa) by comparing the FastAPI route table to the parsed spec.

Also define the tool-call JSON schema in contracts/tools.json and generate
Pydantic models from it — the agent must not accept free-form tool args.

Done when: `make contracts` regenerates cleanly, `make contracts-check` fails
on drift, and the route/spec parity test passes with zero `Any` in generated
models.
```

---

## 3. Data

```
Context: beacon repo with contracts. Build the persistence layer.

SQLAlchemy 2 async models + Alembic migrations:
  services, alert_fingerprints, incidents, investigations, agent_steps,
  tool_results, evidence_items, hypotheses, proposals, approvals,
  runbook_chunks(vector(1024)), runbook_documents, budgets, dead_letter_jobs.

Requirements:
- Money as Numeric(18,6); timestamps timezone-aware UTC everywhere.
- Keyset indexes (service_id, created_at DESC, id DESC) on incidents and
  investigations; partial index on open incidents; GIN index for runbook
  full-text search.
- Alembic: online index creation via autocommit block; a batched backfill
  task for runbook embeddings (500 rows/tick); every migration has a tested
  downgrade.
- Seed: 40 runbook documents (realistic SRE content: retry storms, DB pool
  exhaustion, bad deploy, cert expiry, disk pressure, DNS, queue backlog),
  chunked + embedded; 50 incident fixtures with ground-truth labels in
  evals/fixtures/incidents/*.json; sanitized tool responses for replay.

Done when: `make migrate` from empty works; `make downgrade` returns cleanly;
`make seed` finishes < 60s; the incidents keyset query plan is index-only;
fixtures load deterministically and hash-stable across runs.
```

---

## 4. Workers

```
Context: beacon repo with DB. Implement Celery + Redis background execution.

Celery app with two queues: `investigate` and `tool-fetch`.
- acks_late=true, worker_prefetch_multiplier=1, per-worker concurrency 4,
  task_time_limit=300s, soft_time_limit=240s.
- Per-service concurrency cap of 3 enforced with a Redis semaphore so one
  noisy service cannot starve the rest.
- Alert storm control: dedupe on fingerprint, coalesce identical alerts
  within 60s into one investigation, and expose the collapsed count.
- Global budget: token-bucket in Redis ($50/day, 200k tokens/incident).
  When exhausted, return 429 with Retry-After and do not start the agent.
- Retries: tenacity for tool HTTP (3 attempts, 1–8s exp, jitter, only on
  5xx/timeout/429); LLM 429 respects Retry-After; deterministic errors do
  not retry.
- Checkpointing: every agent step commits (step_index, tool, args hash,
  result ref) so a retry resumes rather than restarts. Steps are idempotent
  by (investigation_id, step_index, args_hash) unique constraint.
- DLQ: `dead_letter_jobs` table + `beacon.dlq` queue; CLI
  `python -m beacon.scripts.dlq list|replay|purge`.
- Partial failure: if a tool dies, record it in degraded_sources, spend the
  remaining step budget on other tools, and lower final confidence by a
  documented rule.

Done when these tests pass with redis+postgres containers:
(a) 100 identical alerts within 60s produce 1 investigation;
(b) a tool returning 503 is retried 3x with jitter then degraded, and the
    investigation still completes;
(c) killing the worker mid-step and re-running produces no duplicate steps;
(d) exhausting the budget returns 429 and creates zero LLM calls (count via
    a respx-mocked transport);
(e) one service with 20 queued investigations cannot exceed 3 in flight.
```

---

## 5. Tests

```
Context: beacon repo, worker layer done. Build the test suite.

- Unit: budget math, dedupe window, confidence adjustment on degraded tools,
  tool-arg validation, loop termination guards (step cap, token cap,
  repeated-identical-tool-call detection).
- Integration (Testcontainers): incident ingest → investigate → proposal →
  approve flow; resume-after-crash; DLQ replay; OTel trace propagation.
- Contract: FastAPI route table vs OpenAPI spec parity; generated Pydantic
  models vs contracts/tools.json.
- Determinism: freeze time, fixed RNG, respx for all HTTP, no live LLM in
  tests (cassettes only).
- Fixtures: each eval incident has a recorded tool-response bundle; loading
  is hash-verified so silent fixture drift fails the suite.
- Coverage gates: 85% overall, 95% on agent/guardrails.py, 100% on the
  approval-gate branch.

Done when: `make test` < 90s; `make test-integration` < 180s; three
consecutive clean runs; a deliberately removed guardrail test makes coverage
fail.
```

---

## 6. AI

```
Context: beacon repo, tests green. Implement the agent loop and eval harness.

Loop (src/beacon/agent):
- Max 8 steps; max 2 tool calls per step; per-incident token and dollar
  ceiling; stop early when confidence ≥ 0.8 with ≥ 2 independent sources.
- Tools: query_metrics, search_logs, get_recent_deploys, search_runbooks
  (pgvector top-6 over runbook_chunks), propose_action.
- Tool choice constrained to generated JSON schemas; invalid args are
  rejected before execution and count as a failed step.
- Loop guards: refuse to re-call the same tool with identical args twice;
  refuse to continue past the step cap; emit a partial answer with
  `truncated: true` instead of failing.
- propose_action NEVER executes. It emits a proposal row with blast radius,
  rollback plan, and a blocked-category check (no delete, no scale-to-zero
  in prod, no credential rotation) that requires human approval.
- Every step persists: prompt version, model, tokens, cost, latency, tool,
  args hash, result ref, degraded flag.

Eval harness `make eval`:
- Replays 50 recorded incidents deterministically (no network); scores
  root-cause top-1/top-3, unsafe proposal rate, citation validity, evidence
  source count, steps, p50/p95 latency, cost/incident.
- Failure injection matrix: run each incident with 0 and 1 failing tool;
  report accuracy delta.
- Outputs evals/results.json + evals/report.md with per-class breakdown.
- Thresholds in evals/thresholds.json; non-zero exit on breach; cassette
  mode for CI.

Targets: top-1 ≥ 0.75, top-3 ≥ 0.90, unsafe proposals 0, citation validity
≥ 95%, ≥ 2 sources in 80%, mean steps ≤ 6, p95 ≤ 45s, ≤ $0.12/incident.

Done when: `make eval` meets every threshold; `--fail-tools search_logs`
degrades accuracy by < 40% rather than crashing; CI runs a 10-incident
cassette eval.
```

---

## 7. CI/CD

```
Context: beacon repo complete. Add GitHub Actions.

ci.yml:
- uv cache; jobs: lint, typecheck, unit, integration (services postgres with
  pgvector + redis), contracts-check, eval-smoke (cassette, 10 incidents),
  docker build (no push on PR).
- Concurrency cancel-in-progress; timeouts on every job (15 min max).
- Publish eval report + coverage as artifacts; comment the eval summary on PRs.

docker.yml (main + tags):
- Multi-arch buildx for api and worker; GHCR; sha/semver/latest tags.
- Non-root user, read-only rootfs, no dev dependencies in the final image,
  base image pinned by digest.
- trivy scan failing on HIGH/CRITICAL; SBOM + provenance.

security.yml: weekly pip-audit / uv audit + secret scan; fail on new HIGH.

Add a PR template checkbox list (backpressure / retries / pagination /
partial failure / migrations / approval gate touched).

Done when: PR blocked by a failing eval threshold; image builds < 5 min warm;
`docker run` serves /healthz non-root; celery worker image starts and reports
ready; actionlint clean.
```

---

## 8. Instrumentation

```
Context: beacon repo, CI complete. Add OTel end to end.

- opentelemetry-instrumentation-fastapi, -celery, -sqlalchemy, -httpx,
  -redis; OTLP HTTP exporter; resource attrs service.name/version/env.
- Custom spans:
  incident.investigate { incident.id, severity, service.name, budget_left }
  agent.step { step_index, tool, args_hash, outcome, degraded }
  tool.call { tool, status_code, latency_ms, retry_count, pages_fetched }
  llm.call { model, prompt_version, input_tokens, output_tokens, cost_usd }
  proposal.create { category, blast_radius, requires_approval }
- Propagate traceparent through Celery headers and through the tool-call
  client; test asserts one trace_id across API → Celery → tool → LLM.
- Metrics: investigation.duration histogram, agent.steps histogram,
  tool.errors counter{degraded}, budget.remaining gauge, dlq.size gauge,
  approval.wait_seconds histogram.
- Logs: structlog with trace_id/span_id; redact hostnames, IPs, customer ids
  via a processor; test asserts redaction.
- Grafana: investigation p95, step count distribution, degraded-tool rate,
  budget burn-down, approval latency.

Done when: one investigation in Tempo shows a single trace with spans
crossing the API, Celery task, each tool call, and the LLM; the budget
burn-down panel moves; the redaction test passes.
```
