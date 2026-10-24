import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../src/api/server.js';
import { MemoryQueryStore } from '../src/api/store.js';
import type { AnswerResult } from '../src/types.js';

interface Harness {
  app: FastifyInstance;
  store: MemoryQueryStore;
}

const apps: FastifyInstance[] = [];

function answer(): AnswerResult {
  return {
    outcome: 'answered',
    sql: `SELECT COUNT(*) FROM warehouse.orders WHERE tenant_id = 't1'`,
    explanation: 'One row.',
    columns: ['total'],
    rows: [[42]],
    truncated: false,
    chart: null,
    refusal: null,
    degraded: [],
    repairAttempts: 0,
    validation: 'ast',
    usage: { inputTokens: 10, outputTokens: 5, costUsd: 0.0001 },
    latencyMs: 12,
  };
}

function makeHarness(options: { queueDepth?: number; maxQueueDepth?: number } = {}): Harness {
  const store = new MemoryQueryStore();
  const app = buildServer({
    store,
    maxQueueDepth: options.maxQueueDepth,
    queueDepth: options.queueDepth === undefined ? undefined : () => options.queueDepth!,
    runQuestion: async (record) => {
      await store.update(record.id, { status: 'succeeded', result: answer() });
    },
  });
  apps.push(app);
  return { app, store };
}

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe('POST /v1/questions', () => {
  it('requires an Idempotency-Key', async () => {
    const { app } = makeHarness();
    const response = await app.inject({
      method: 'POST',
      url: '/v1/questions',
      payload: { tenantId: 't1', question: 'How many orders?' },
    });

    expect(response.statusCode).toBe(400);
    expect(response.headers['content-type']).toContain('application/problem+json');
  });

  it('accepts a question and exposes the result', async () => {
    const { app } = makeHarness();
    const created = await app.inject({
      method: 'POST',
      url: '/v1/questions',
      headers: { 'idempotency-key': 'key-1' },
      payload: { tenantId: 't1', question: 'How many orders?' },
    });

    expect(created.statusCode).toBe(202);
    const body = created.json() as { id: string };
    expect(body.id).toMatch(/^qry_/);

    const fetched = await app.inject({
      method: 'GET',
      url: `/v1/queries/${body.id}`,
      headers: { 'x-tenant-id': 't1' },
    });

    expect(fetched.statusCode).toBe(200);
    const record = fetched.json() as {
      status: string;
      result: { outcome: string; rowCount: number };
    };
    expect(record.status).toBe('succeeded');
    expect(record.result.outcome).toBe('answered');
    expect(record.result.rowCount).toBe(1);
  });

  it('replays the same id for an identical idempotent request', async () => {
    const { app } = makeHarness();
    const request = {
      method: 'POST' as const,
      url: '/v1/questions',
      headers: { 'idempotency-key': 'key-1' },
      payload: { tenantId: 't1', question: 'How many orders?' },
    };

    const first = await app.inject(request);
    const second = await app.inject(request);

    expect((first.json() as { id: string }).id).toBe((second.json() as { id: string }).id);
  });

  it('rejects a reused key with a different body', async () => {
    const { app } = makeHarness();
    const headers = { 'idempotency-key': 'key-1' };

    await app.inject({
      method: 'POST',
      url: '/v1/questions',
      headers,
      payload: { tenantId: 't1', question: 'How many orders?' },
    });

    const conflict = await app.inject({
      method: 'POST',
      url: '/v1/questions',
      headers,
      payload: { tenantId: 't1', question: 'How much revenue?' },
    });

    expect(conflict.statusCode).toBe(409);
  });

  it('sheds load when the queue is deep', async () => {
    const { app } = makeHarness({ queueDepth: 500, maxQueueDepth: 200 });
    const response = await app.inject({
      method: 'POST',
      url: '/v1/questions',
      headers: { 'idempotency-key': 'key-1' },
      payload: { tenantId: 't1', question: 'How many orders?' },
    });

    expect(response.statusCode).toBe(429);
    expect(response.headers['retry-after']).toBe('5');
  });
});

describe('GET /v1/queries', () => {
  it('paginates with a keyset cursor', async () => {
    const { app } = makeHarness();

    for (let index = 0; index < 3; index += 1) {
      await app.inject({
        method: 'POST',
        url: '/v1/questions',
        headers: { 'idempotency-key': `key-${index}` },
        payload: { tenantId: 't1', question: `Question number ${index}` },
      });
    }

    const first = await app.inject({
      method: 'GET',
      url: '/v1/queries?limit=2',
      headers: { 'x-tenant-id': 't1' },
    });

    const page = first.json() as {
      data: unknown[];
      pageInfo: { nextCursor: string | null; hasMore: boolean };
    };
    expect(page.data).toHaveLength(2);
    expect(page.pageInfo.hasMore).toBe(true);
    expect(page.pageInfo.nextCursor).toBeTruthy();

    const second = await app.inject({
      method: 'GET',
      url: `/v1/queries?limit=2&cursor=${page.pageInfo.nextCursor}`,
      headers: { 'x-tenant-id': 't1' },
    });

    const next = second.json() as { data: unknown[]; pageInfo: { hasMore: boolean } };
    expect(next.data).toHaveLength(1);
    expect(next.pageInfo.hasMore).toBe(false);
  });

  it('does not leak records across tenants', async () => {
    const { app } = makeHarness();
    await app.inject({
      method: 'POST',
      url: '/v1/questions',
      headers: { 'idempotency-key': 'key-1' },
      payload: { tenantId: 't1', question: 'How many orders?' },
    });

    const otherTenant = await app.inject({
      method: 'GET',
      url: '/v1/queries',
      headers: { 'x-tenant-id': 't2' },
    });

    expect((otherTenant.json() as { data: unknown[] }).data).toHaveLength(0);
  });
});

describe('GET /v1/queries/:id/rows', () => {
  it('returns result rows separately from the summary', async () => {
    const { app } = makeHarness();
    const created = await app.inject({
      method: 'POST',
      url: '/v1/questions',
      headers: { 'idempotency-key': 'key-1' },
      payload: { tenantId: 't1', question: 'How many orders?' },
    });
    const { id } = created.json() as { id: string };

    const rows = await app.inject({
      method: 'GET',
      url: `/v1/queries/${id}/rows?limit=10&offset=0`,
      headers: { 'x-tenant-id': 't1' },
    });

    expect(rows.statusCode).toBe(200);
    const body = rows.json() as { data: unknown[][]; columns: string[] };
    expect(body.columns).toEqual(['total']);
    expect(body.data).toEqual([[42]]);
  });
});
