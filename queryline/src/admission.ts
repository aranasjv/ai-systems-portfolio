import type { QueryEstimate, WarehouseAdapter } from './types.js';

export interface AdmissionPolicy {
  maxEstimatedRows: number;
  maxCost: number;
}

export interface AdmissionDecision {
  admitted: boolean;
  estimate: QueryEstimate;
  reason: string | null;
}

export const DEFAULT_ADMISSION: AdmissionPolicy = {
  maxEstimatedRows: 5_000_000,
  maxCost: 250_000,
};

/**
 * Reject a query before it runs when the plan says it will be enormous.
 * Dialects that cannot produce a plan (missing SHOWPLAN permission, no
 * PLAN_TABLE) fall through as `unverified` and are still bounded by the
 * statement timeout and row cap.
 */
export async function checkAdmission(
  adapter: WarehouseAdapter,
  sql: string,
  policy: AdmissionPolicy,
  timeoutMs: number,
): Promise<AdmissionDecision> {
  let estimate: QueryEstimate;

  try {
    estimate = await adapter.estimate(sql, timeoutMs);
  } catch {
    estimate = { estimatedRows: null, cost: null, source: 'unverified' };
  }

  if (estimate.source === 'unverified') {
    return { admitted: true, estimate, reason: null };
  }

  if (estimate.estimatedRows !== null && estimate.estimatedRows > policy.maxEstimatedRows) {
    return {
      admitted: false,
      estimate,
      reason: `Estimated ${Math.round(estimate.estimatedRows).toLocaleString()} rows exceeds the ${policy.maxEstimatedRows.toLocaleString()} row admission limit.`,
    };
  }

  if (estimate.cost !== null && estimate.cost > policy.maxCost) {
    return {
      admitted: false,
      estimate,
      reason: `Estimated plan cost ${Math.round(estimate.cost).toLocaleString()} exceeds the ${policy.maxCost.toLocaleString()} limit.`,
    };
  }

  return { admitted: true, estimate, reason: null };
}
