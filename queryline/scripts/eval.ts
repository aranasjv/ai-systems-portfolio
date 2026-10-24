import { readFile, writeFile } from 'node:fs/promises';
import { applyCatalogPolicy } from '../src/catalog.js';
import { loadConfig } from '../src/config.js';
import { formatReport, loadGolden, runEval } from '../src/ai/harness.js';
import type { Thresholds } from '../src/ai/metrics.js';
import { createModelClient } from '../src/ai/model.js';
import { createWarehouseAdapter } from '../src/warehouse/index.js';

async function main(): Promise<void> {
  const flags = new Set(process.argv.slice(2));
  const config = loadConfig();
  const kind = config.warehouse.kind;

  const thresholds = JSON.parse(
    await readFile('evals/thresholds.json', 'utf8'),
  ) as Thresholds;

  const cases = await loadGolden(`evals/golden/questions.${kind}.jsonl`);

  const adapter = createWarehouseAdapter(config.warehouse);
  await adapter.connect();

  try {
    const catalog = applyCatalogPolicy(await adapter.catalog());
    const model = createModelClient(config.model);

    if (config.model.provider === 'mock') {
      console.warn(
        'MODEL_PROVIDER=mock: this run measures harness plumbing, not model quality. Use --no-gate to report only.',
      );
    }

    const result = await runEval({
      cases,
      adapter,
      catalog,
      model,
      tenantId: config.tenantId,
      page: { limit: config.limits.maxRows, offset: 0 },
      policy: {
        maxEstimatedRows: config.limits.maxEstimatedRows,
        maxCost: config.limits.maxEstimatedCost,
      },
      maxRepairs: config.limits.maxRepairs,
      thresholds,
    });

    const report = formatReport(result.metrics, result.results, result.thresholdCheck);
    console.log(report);

    await writeFile(
      'evals/results.json',
      JSON.stringify(
        { kind, model: config.model.name, metrics: result.metrics, thresholdCheck: result.thresholdCheck, results: result.results },
        null,
        2,
      ),
    );

    const unsafe = result.results.some((entry) => entry.unsafeExecuted);
    if (unsafe) {
      console.error('HARD FAIL: an unsafe query executed.');
      process.exit(1);
    }

    if (!result.thresholdCheck.ok && !flags.has('--no-gate')) {
      console.error(`Threshold failure: ${result.thresholdCheck.violations.join('; ')}`);
      process.exit(1);
    }
  } finally {
    await adapter.close();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
