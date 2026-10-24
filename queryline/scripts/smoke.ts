import { ask } from '../src/ai/loop.js';
import { MockModelClient } from '../src/ai/model.js';
import { applyCatalogPolicy } from '../src/catalog.js';
import { loadConfig } from '../src/config.js';
import { createWarehouseAdapter } from '../src/warehouse/index.js';

/**
 * End-to-end read path against a real warehouse, with a scripted model.
 * Proves guard -> admission -> pagination wrapper -> driver -> result mapping
 * without needing a provider key.
 */
async function main(): Promise<void> {
  const config = loadConfig();
  const adapter = createWarehouseAdapter(config.warehouse);
  await adapter.connect();

  try {
    const catalog = applyCatalogPolicy(await adapter.catalog());
    if (catalog.tables.length === 0) {
      throw new Error(
        `No tables found in schema "${config.warehouse.schema ?? '(default)'}". Run pnpm db:migrate && pnpm db:seed.`,
      );
    }

    const table = config.warehouse.kind === 'oracle' ? 'orders' : `${config.warehouse.schema ?? 'warehouse'}.orders`;
    const sql = `SELECT status, COUNT(*) AS order_count FROM ${table} WHERE tenant_id = '${config.tenantId}' GROUP BY status ORDER BY status`;

    const model = new MockModelClient(() =>
      JSON.stringify({
        kind: 'sql',
        sql,
        explanation: 'Order count by status for this tenant.',
        chart: { type: 'bar', x: 'status', y: ['order_count'] },
        confidence: 1,
        refusal: null,
      }),
    );

    const result = await ask({
      question: 'How many orders are there per status?',
      tenantId: config.tenantId,
      catalog,
      adapter,
      model,
      page: { limit: 100, offset: 0 },
      maxRepairs: 0,
    });

    console.log(
      JSON.stringify(
        {
          outcome: result.outcome,
          columns: result.columns,
          rows: result.rows,
          refusal: result.refusal,
          degraded: result.degraded,
          validation: result.validation,
          latencyMs: result.latencyMs,
        },
        null,
        2,
      ),
    );

    if (result.outcome !== 'answered') process.exit(1);
  } finally {
    await adapter.close();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
