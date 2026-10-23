# Beacon

**On-call incident response agent.**

Takes a paged alert, investigates metrics/logs/deploys/runbooks, produces a ranked root-cause hypothesis with evidence, and proposes remediation that requires human approval.

- Prompt pack: [02-beacon-prompts.md](../prompt-packs/02-beacon-prompts.md)
- Stack: Python
- Domain: SRE / platform reliability

## Why it isn't a toy

Alert storms, token cost ceilings, tools that go down mid-investigation, and irreversible actions — all inside the loop, not bolted on afterwards. The hard question is not "can an LLM read logs" but "what does the agent do when `search_logs` returns 503 on step 3 of 8 with 40 cents of budget left".

## Architecture

```
 Alertmanager ──▶ FastAPI /v1/incidents ──▶ dedupe (fingerprint + 60s window)
                        │
                        ▼
                  Celery investigate queue ──▶ agent loop (max 8 steps)
                        │                          │
                        │                          ├─ query_metrics
                        │                          ├─ search_logs      (paginated)
                        │                          ├─ get_recent_deploys
                        │                          ├─ search_runbooks  (pgvector)
                        │                          └─ propose_action ──▶ approval gate
                        ▼
                 investigations + agent_steps (checkpointed)
                        │
                        ▼
                 hypothesis + evidence manifest + cost
```

## Stack

| Layer | Choice |
|---|---|
| Runtime | Python 3.12, `uv`, ruff, mypy strict |
| API | FastAPI + Pydantic v2 |
| Data | Postgres 16 + pgvector, SQLAlchemy 2 async, Alembic |
| Queue | Celery 5 + Redis 7 (`prefetch=1`, `acks_late`) |
| Resilience | tenacity, httpx |
| Tests | pytest, pytest-asyncio, Testcontainers, respx |
| Observability | OTel Python (FastAPI/Celery/SQLAlchemy/httpx) |
| AI | bounded agent loop (custom, no framework), tool calling, pgvector runbook RAG |

## Non-functional requirements

| Concern | Concrete behaviour |
|---|---|
| Backpressure | Alert storm dedupe by fingerprint + 60s coalescing window; per-service concurrency 3; global token-bucket budget ($50/day, 200k tokens/incident); shed with `429` when tripped |
| Retries | tenacity on tool HTTP (3 attempts, 1–8s exponential + jitter); LLM `429` honours `Retry-After`; step outcomes checkpointed so retries resume rather than restart |
| Pagination | Every log/metric tool returns `{items, next_cursor}`; the agent caps at 3 pages per tool call |
| Partial failures | Tool failure records `degraded: [tool]` in the evidence manifest; the agent continues, lowers confidence by a documented rule, and marks missing evidence |
| Schema migrations | Alembic, `CREATE INDEX CONCURRENTLY` in an autocommit block, batched embedding backfill, downgrade tested |

## AI system

Bounded loop: max 8 steps, max 2 tool calls per step, hard token and dollar ceiling per incident, early stop at confidence ≥ 0.8 with ≥ 2 independent evidence sources.

- Tool choice is constrained to generated JSON schemas; invalid arguments are rejected before execution and count as a failed step.
- Repeating the same tool with identical arguments is refused.
- `propose_action` never executes. It writes a proposal with blast radius, rollback plan, and a blocked-category check (no delete, no scale-to-zero in prod, no credential rotation). Human approval is mandatory.
- Every step persists prompt version, model, tokens, cost, latency, tool, args hash, result ref, and degraded flag.

## Eval contract

50 recorded incidents (sanitized fixtures) across 12 failure classes. Ground truth = root-cause service + failure class + safe first action. Deterministic replay, no network.

| Metric | Target |
|---|---|
| Root-cause top-1 / top-3 | ≥ 0.75 / ≥ 0.90 |
| Unsafe action proposals | 0 (hard fail) |
| Runbook citation validity | ≥ 95% |
| ≥ 2 independent evidence sources | ≥ 80% of runs |
| Mean steps / max steps | ≤ 6 / 8 |
| p50 / p95 latency | ≤ 20s / ≤ 45s |
| Cost per incident | ≤ $0.12 |
| Accuracy under 1 injected tool failure | ≥ 60% of clean accuracy |

## Non-goals

- Executing remediation. The system proposes; humans approve and act. Auto-remediation is a separate product with a different risk profile.
- Correlating alerts across unrelated services. Dedupe is per fingerprint.
- Learning from outcomes. Feedback capture is stored but does not retrain anything.
