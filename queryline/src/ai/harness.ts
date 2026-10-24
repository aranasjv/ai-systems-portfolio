import { readFile } from 'node:fs/promises';
import type { AdmissionPolicy } from '../admission.js';
import { validateSql } from '../guard.js';
import type { Page, SchemaCatalog, WarehouseAdapter } from '../types.js';
import { ask } from './loop.js';
import {
  checkThresholds,
  computeMetrics,
  hashRows,
  type CaseResult,
  type EvalMetrics,
  type ThresholdCheck,
  type Thresholds,
} from './metrics.js';
import type { ModelClient } from './model.js';
import type { FewShot } from './retrieve.js';

export interface GoldenCase {
  id: string;
  schema: string;
  question: string;
  label: 'answerable' | 'refuse' | 'unsafe';
  sql?: string;
  ordered?: boolean;
  reason?: string;
}

export function parseGolden(text: string): GoldenCase[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('//'))
    .map((line) => JSON.parse(line) as GoldenCase);
}

export async function loadGolden(path: string): Promise<GoldenCase[]> {
  return parseGolden(await readFile(path, 'utf8'));
}

export interface RunEvalOptions {
  cases: GoldenCase[];
  adapter: WarehouseAdapter;
  catalog: SchemaCatalog;
  model: ModelClient;
  tenantId: string;
  page?: Page;
  policy?: AdmissionPolicy;
  maxRepairs?: number;
  fewShots?: FewShot[];
  thresholds?: Thresholds;
}

export interface RunEvalResult {
  metrics: EvalMetrics;
  results: CaseResult[];
  thresholdCheck: ThresholdCheck;
}

export async function runEval(options: RunEvalOptions): Promise<RunEvalResult> {
  const page: Page = options.page ?? { limit: 1000, offset: 0 };
  const results: CaseResult[] = [];

  for (const testCase of options.cases) {
    const answer = await ask({
      question: testCase.question,
      tenantId: options.tenantId,
      catalog: options.catalog,
      adapter: options.adapter,
      model: options.model,
      page,
      policy: options.policy,
      maxRepairs: options.maxRepairs,
      fewShots: options.fewShots,
    });

    let correct: boolean | null = null;
    let unsafeExecuted = false;

    if (testCase.label === 'answerable') {
      correct = false;
      if (answer.outcome === 'answered' && testCase.sql) {
        const expectedGuard = validateSql({
          sql: testCase.sql,
          dialect: options.adapter.kind,
          catalog: options.catalog,
          tenantId: options.tenantId,
        });

        if (expectedGuard.ok) {
          const expected = await options.adapter.execute(expectedGuard.sql, {
            limit: page.limit,
            offset: 0,
            timeoutMs: 8000,
          });
          correct =
            hashRows(answer.rows, testCase.ordered) ===
            hashRows(expected.rows, testCase.ordered);
        }
      }
    } else {
      correct = answer.outcome === 'refused';
      unsafeExecuted = answer.outcome === 'answered';
    }

    results.push({
      id: testCase.id,
      label: testCase.label,
      outcome: answer.outcome,
      refusalReason: answer.refusal?.reason ?? null,
      correct,
      unsafeExecuted,
      repairAttempts: answer.repairAttempts,
      latencyMs: answer.latencyMs,
      costUsd: answer.usage.costUsd,
    });
  }

  const metrics = computeMetrics(results);
  const thresholdCheck = options.thresholds
    ? checkThresholds(metrics, options.thresholds)
    : { ok: true, violations: [] };

  return { metrics, results, thresholdCheck };
}

export function formatReport(
  metrics: EvalMetrics,
  results: CaseResult[],
  thresholdCheck: ThresholdCheck,
): string {
  const lines = [
    '| metric | value |',
    '| --- | --- |',
    `| execution accuracy | ${format(metrics.executionAccuracy)} |`,
    `| answer rate | ${format(metrics.answerRate)} |`,
    `| refusal precision | ${format(metrics.refusalPrecision)} |`,
    `| refusal recall | ${format(metrics.refusalRecall)} |`,
    `| unsafe block rate | ${format(metrics.unsafeBlockRate)} |`,
    `| repair recovery | ${format(metrics.repairRecoveryRate)} |`,
    `| p50 latency (ms) | ${metrics.p50LatencyMs} |`,
    `| p95 latency (ms) | ${metrics.p95LatencyMs} |`,
    `| cost / query (USD) | ${metrics.costPerQueryUsd} |`,
    '',
    `cases: ${metrics.total} (answered ${metrics.answered}, refused ${metrics.refused}, failed ${metrics.failed})`,
  ];

  const failures = results.filter((result) => result.correct === false || result.unsafeExecuted);
  if (failures.length > 0) {
    lines.push('', '### Failures', '');
    for (const failure of failures.slice(0, 10)) {
      lines.push(
        `- ${failure.id} [${failure.label}] outcome=${failure.outcome} reason=${failure.refusalReason ?? 'n/a'}`,
      );
    }
  }

  lines.push('', thresholdCheck.ok ? 'Thresholds: PASS' : `Thresholds: FAIL (${thresholdCheck.violations.join('; ')})`);
  return lines.join('\n');
}

function format(value: number | null): string {
  return value === null ? 'n/a' : value.toFixed(4);
}
