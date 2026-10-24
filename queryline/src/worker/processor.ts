import type { Job } from 'bullmq';
import type { ModelClient } from '../ai/model.js';
import { ask } from '../ai/loop.js';
import type { QueryStore } from '../api/store.js';
import type { LimitConfig } from '../config.js';
import type { AnswerResult, SchemaCatalog, WarehouseAdapter } from '../types.js';
import type { QueryJob } from './queue.js';

export interface ProcessorDeps {
  adapter: WarehouseAdapter;
  catalog: SchemaCatalog;
  model: ModelClient;
  store: QueryStore;
  limits: LimitConfig;
}

function statusFor(outcome: AnswerResult['outcome']): 'succeeded' | 'refused' | 'failed' {
  if (outcome === 'answered') return 'succeeded';
  if (outcome === 'refused') return 'refused';
  return 'failed';
}

export async function processQuery(deps: ProcessorDeps, job: Job<QueryJob>): Promise<void> {
  const record = await deps.store.get(job.data.queryId, job.data.tenantId);
  if (!record) throw new Error(`Unknown query ${job.data.queryId}`);

  await deps.store.update(record.id, { status: 'running' });

  const result = await ask({
    question: record.question,
    tenantId: record.tenantId,
    catalog: deps.catalog,
    adapter: deps.adapter,
    model: deps.model,
    page: { limit: deps.limits.maxRows, offset: 0 },
    policy: {
      maxEstimatedRows: deps.limits.maxEstimatedRows,
      maxCost: deps.limits.maxEstimatedCost,
    },
    maxRepairs: deps.limits.maxRepairs,
    maxSqlLength: deps.limits.maxSqlLength,
    timeoutMs: deps.limits.queryTimeoutMs,
    explainTimeoutMs: deps.limits.explainTimeoutMs,
  });

  await deps.store.update(record.id, {
    status: statusFor(result.outcome),
    result,
  });
}

/**
 * Only infrastructure failures deserve a retry. Guard refusals and semantic
 * SQL errors are outcomes, not retries — retrying them just burns budget.
 */
export function isTransientJobError(error: unknown): boolean {
  const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  if (
    /statement timeout|canceling statement due to statement timeout|callTimeout|ORA-01013/i.test(
      message,
    )
  ) {
    return false;
  }
  return /ECONNRESET|ECONNREFUSED|ETIMEDOUT|socket hang up|server closed|connection terminated|deadlock|ORA-00060|40001|40P01|08S01/i.test(
    message,
  );
}
