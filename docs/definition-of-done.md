# Definition of Done

Every project must pass this before it is listed in the README. No exceptions, no "in progress" badges.

## System

- [ ] `docker compose up` brings a working stack from a clean clone with only Docker installed.
- [ ] Migrations run forward and backward from an empty database.
- [ ] Seed data is deterministic and produces realistic volume (millions of rows where the project claims scale).
- [ ] The service survives a worker kill with no duplicate side effects.

## The five concerns

Each concern needs a test that fails if the behaviour is removed:

- [ ] **Backpressure** — a test proves the system sheds load or caps concurrency rather than degrading without bound.
- [ ] **Retries** — a test proves transient failures are retried with increasing delay and poison inputs are not.
- [ ] **Pagination** — a test proves cursor stability under concurrent writes (no duplicates, no skips).
- [ ] **Partial failures** — a test proves one bad unit of work does not fail the batch, and the degradation is reported.
- [ ] **Migrations** — a test or documented drill proves expand/contract works with the old code running.

## AI

- [ ] Golden set committed, hashed, stratified, and ≥ 40 negative cases.
- [ ] Eval harness runs deterministically from cassettes in CI.
- [ ] Every metric in the README is produced by the harness, not estimated.
- [ ] Thresholds enforced in CI; a deliberate regression fails the build.
- [ ] Cost and latency reported per unit of work.
- [ ] Guardrails are code, not prompt text, and have their own tests.

## Operations

- [ ] One trace in Tempo spans HTTP → queue → worker → database → model call.
- [ ] Dashboards committed as provisioned JSON and render real data.
- [ ] Logs carry trace ids and contain no PII (redaction test).
- [ ] CI: lint, typecheck, unit, integration, contract drift, eval smoke.
- [ ] Docker: non-root, read-only rootfs, pinned digest, SBOM, vulnerability scan.
- [ ] A PR that breaks an eval threshold is blocked.

## Documentation

- [ ] README: architecture diagram, the five concerns with links to the implementing code, eval table, cost model.
- [ ] One honest limitation documented — what the system does not handle and why.
- [ ] ADR for the one decision a reviewer would question.
- [ ] Tempo trace screenshot committed to `docs/`.
