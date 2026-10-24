import { describe, expect, it } from 'vitest';
import { ask } from '../src/ai/loop.js';
import { MockModelClient } from '../src/ai/model.js';
import type {
  ExecuteOptions,
  QueryEstimate,
  ResultSet,
  SchemaCatalog,
  WarehouseAdapter,
} from '../src/types.js';

const catalog: SchemaCatalog = {
  kind: 'postgres',
  tables: [
    {
      schema: 'warehouse',
      name: 'orders',
      columns: [
        { name: 'id', dataType: 'bigint', nullable: false },
        { name: 'tenant_id', dataType: 'text', nullable: false },
        { name: 'status', dataType: 'text', nullable: false },
        { name: 'total_cents', dataType: 'bigint', nullable: false },
      ],
      tenantScoped: true,
      piiColumns: [],
    },
  ],
};

class FakeAdapter implements WarehouseAdapter {
  readonly kind = 'postgres' as const;
  executed: string[] = [];

  constructor(
    private readonly rows: unknown[][] = [[1]],
    private readonly estimateRows = 10,
  ) {}

  async connect(): Promise<void> {}
  async close(): Promise<void> {}

  async catalog(): Promise<SchemaCatalog> {
    return catalog;
  }

  async estimate(): Promise<QueryEstimate> {
    return { estimatedRows: this.estimateRows, cost: 1, source: 'explain' };
  }

  async execute(sql: string, options: ExecuteOptions): Promise<ResultSet> {
    this.executed.push(sql);
    return {
      columns: ['value'],
      rows: this.rows,
      rowCount: this.rows.length,
      truncated: this.rows.length >= options.limit,
    };
  }

  admin(): { exec(statement: string): Promise<void> } {
    return { exec: async () => undefined };
  }
}

function sqlResponse(sql: string): string {
  return JSON.stringify({
    kind: 'sql',
    sql,
    explanation: 'Computed from orders.',
    chart: null,
    confidence: 0.9,
    refusal: null,
  });
}

function scripted(responses: string[]): MockModelClient {
  let index = 0;
  return new MockModelClient(() => responses[Math.min(index++, responses.length - 1)]!);
}

const base = {
  question: 'How many orders are there?',
  tenantId: 'demo-tenant',
  catalog,
  page: { limit: 100, offset: 0 },
};

describe('agent loop', () => {
  it('answers with a validated query', async () => {
    const adapter = new FakeAdapter([[42]]);
    const model = scripted([
      sqlResponse(`SELECT COUNT(*) AS total FROM warehouse.orders WHERE tenant_id = 'demo-tenant'`),
    ]);

    const result = await ask({ ...base, adapter, model, maxRepairs: 0 });

    expect(result.outcome).toBe('answered');
    expect(result.rows).toEqual([[42]]);
    expect(result.repairAttempts).toBe(0);
    expect(adapter.executed).toHaveLength(1);
  });

  it('refuses a destructive statement without retrying', async () => {
    const adapter = new FakeAdapter();
    const model = scripted([sqlResponse('DELETE FROM warehouse.orders WHERE id = 1')]);

    const result = await ask({ ...base, adapter, model, maxRepairs: 2 });

    expect(result.outcome).toBe('refused');
    expect(result.refusal?.reason).toBe('forbidden_keyword');
    expect(result.repairAttempts).toBe(0);
    expect(adapter.executed).toHaveLength(0);
  });

  it('repairs an unknown table on the second attempt', async () => {
    const adapter = new FakeAdapter([[7]]);
    const model = scripted([
      sqlResponse(`SELECT id FROM warehouse.missing WHERE tenant_id = 'demo-tenant'`),
      sqlResponse(`SELECT id FROM warehouse.orders WHERE tenant_id = 'demo-tenant'`),
    ]);

    const result = await ask({ ...base, adapter, model, maxRepairs: 2 });

    expect(result.outcome).toBe('answered');
    expect(result.repairAttempts).toBe(1);
  });

  it('surfaces model refusals', async () => {
    const adapter = new FakeAdapter();
    const model = scripted([
      JSON.stringify({
        kind: 'refusal',
        sql: null,
        explanation: 'Not answerable.',
        chart: null,
        confidence: 0,
        refusal: { reason: 'pii', detail: 'Emails are protected.' },
      }),
    ]);

    const result = await ask({ ...base, adapter, model, maxRepairs: 0 });

    expect(result.outcome).toBe('refused');
    expect(result.refusal?.reason).toBe('model_refusal');
    expect(result.refusal?.detail).toContain('protected');
  });

  it('stops at admission control for an oversized plan', async () => {
    const adapter = new FakeAdapter([[1]], 10_000_000);
    const model = scripted([
      sqlResponse(`SELECT id FROM warehouse.orders WHERE tenant_id = 'demo-tenant'`),
    ]);

    const result = await ask({ ...base, adapter, model, maxRepairs: 0 });

    expect(result.outcome).toBe('refused');
    expect(result.refusal?.reason).toBe('admission_rejected');
    expect(adapter.executed).toHaveLength(0);
  });

  it('requires ORDER BY for pagination past page one', async () => {
    const adapter = new FakeAdapter();
    const model = scripted([
      sqlResponse(`SELECT id FROM warehouse.orders WHERE tenant_id = 'demo-tenant'`),
    ]);

    const result = await ask({
      ...base,
      adapter,
      model,
      maxRepairs: 0,
      page: { limit: 100, offset: 100 },
    });

    expect(result.outcome).toBe('refused');
    expect(result.refusal?.reason).toBe('pagination_requires_order_by');
    expect(adapter.executed).toHaveLength(0);
  });

  it('repairs malformed JSON before giving up', async () => {
    const adapter = new FakeAdapter([[3]]);
    const model = scripted([
      'not json at all',
      sqlResponse(`SELECT id FROM warehouse.orders WHERE tenant_id = 'demo-tenant'`),
    ]);

    const result = await ask({ ...base, adapter, model, maxRepairs: 1 });

    expect(result.outcome).toBe('answered');
    expect(result.repairAttempts).toBe(1);
  });
});
