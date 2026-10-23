# Eval Standards

Rules that apply to all three projects. The point is to make AI claims falsifiable.

## 1. Every claim has a number, a dataset size, and a baseline

No "improves accuracy" without the metric, the dataset, and the value it beat. If there is no baseline, build the cheapest possible one (rules-only, prompt-only, no-retrieval) and report the lift.

## 2. Golden sets are frozen and hashed

- Stored as JSONL, one case per line, committed to the repo.
- A SHA-256 of the file is recorded in `evals/manifest.json`.
- Changing the set requires a version bump plus a re-baseline note in the PR.
- Cases are stratified by failure class, and the split is documented.

## 3. Evals are CI-enforced

There is no manually-run eval. Every PR runs a cassette-backed smoke eval; nightly runs the full set against live models.

```json
// evals/thresholds.json — shape used by all three projects
{
  "version": 3,
  "gate": { "max_f1_regression": 0.02, "max_cost_increase_pct": 20 },
  "metrics": {
    "primary":    { "name": "macro_f1", "min": 0.85 },
    "abstention": { "name": "recall_low_confidence", "min": 0.90 },
    "hot_path":   { "name": "p95_latency_ms", "max": 2500 },
    "unit_cost":  { "name": "cost_usd_per_item", "max": 0.004 }
  }
}
```

## 4. Cost and latency are per unit of work

Measure per exception, per incident, per query — never per run. Report p50, p95, p99. A model change that doubles cost for a 1-point F1 gain fails the gate unless the PR argues for it explicitly.

## 5. Negative cases are mandatory

Each project defines slices for the ways the system should *not* act:

- Ledgerline: low-confidence exceptions that must abstain; high-value exceptions that always require a human.
- Beacon: destructive actions that must never be proposed without approval.
- Queryline: PII extraction, cross-tenant probes, and prompts that must be refused.

An eval that only measures happy-path accuracy is not an eval.

## 6. Determinism

- PR evals run from recorded cassettes; no network.
- Fixtures are hash-verified on load, so silent drift fails the suite.
- Clock and RNG are frozen in tests.
- Live-model evals run nightly and publish a diff against the previous run.

## 7. Every model call is logged

Minimum fields per invocation: `prompt_version`, `model`, `input_tokens`, `output_tokens`, `cost_usd`, `latency_ms`, `outcome`, and a trace id. Evals and production telemetry use the same schema so a regression can be traced to a specific prompt version.

## 8. Report format

Each run produces:

- `evals/results.json` — machine-readable, one record per case
- `evals/report.md` — metric table vs thresholds, plus the worst 10 failures grouped by class

The report is committed for released versions and attached as a CI artifact otherwise.
