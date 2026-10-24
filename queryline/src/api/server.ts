import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import Fastify, { type FastifyInstance, type FastifyReply } from 'fastify';
import pg from 'pg';
import { z } from 'zod';
import { applyCatalogPolicy } from '../catalog.js';
import { loadConfig } from '../config.js';
import { ask } from '../ai/loop.js';
import { createModelClient } from '../ai/model.js';
import { initObservability } from '../observability.js';
import { createWarehouseAdapter } from '../warehouse/index.js';
import type { AnswerResult } from '../types.js';
import { MemoryQueryStore, PgQueryStore, type QueryRecord, type QueryStore } from './store.js';

const QuestionBody = z.object({
  tenantId: z.string().min(1).max(128),
  question: z.string().min(3).max(4_000),
  conversationId: z.string().max(128).optional(),
});

export interface ServerDeps {
  store: QueryStore;
  runQuestion: (record: QueryRecord) => Promise<void>;
  queueDepth?: () => number | Promise<number>;
  maxQueueDepth?: number;
  defaultTenantId?: string;
  logger?: boolean;
}

function problem(
  reply: FastifyReply,
  status: number,
  title: string,
  detail: string,
): FastifyReply {
  return reply
    .code(status)
    .type('application/problem+json')
    .send({ type: 'about:blank', title, status, detail });
}

function tenantFor(headers: Record<string, unknown>, fallback: string): string {
  const header = headers['x-tenant-id'];
  if (typeof header === 'string' && header.length > 0) return header;
  return fallback;
}

function statusFor(outcome: AnswerResult['outcome']): QueryRecord['status'] {
  if (outcome === 'answered') return 'succeeded';
  if (outcome === 'refused') return 'refused';
  return 'failed';
}

function summary(record: QueryRecord): Record<string, unknown> {
  const result = record.result;
  return {
    id: record.id,
    tenantId: record.tenantId,
    question: record.question,
    status: record.status,
    error: record.error,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    result: result
      ? {
          outcome: result.outcome,
          sql: result.sql,
          explanation: result.explanation,
          columns: result.columns,
          rowCount: result.rows.length,
          preview: result.rows.slice(0, 5),
          truncated: result.truncated,
          chart: result.chart,
          refusal: result.refusal,
          degraded: result.degraded,
          repairAttempts: result.repairAttempts,
          validation: result.validation,
          usage: result.usage,
          latencyMs: result.latencyMs,
        }
      : null,
  };
}

export function buildServer(deps: ServerDeps): FastifyInstance {
  const app = Fastify({ logger: deps.logger ?? false });
  const defaultTenant = deps.defaultTenantId ?? 'demo-tenant';
  const maxQueueDepth = deps.maxQueueDepth ?? 200;
  const idempotency = new Map<string, { fingerprint: string; id: string }>();

  app.get('/healthz', async () => ({
    status: 'ok',
    version: process.env.GIT_SHA ?? 'dev',
    uptimeSeconds: Math.round(process.uptime()),
  }));

  app.post('/v1/questions', async (request, reply) => {
    const key = request.headers['idempotency-key'];
    if (typeof key !== 'string' || key.length === 0 || key.length > 200) {
      return problem(reply, 400, 'Idempotency-Key required', 'POST /v1/questions requires an Idempotency-Key header.');
    }

    const parsed = QuestionBody.safeParse(request.body);
    if (!parsed.success) {
      return problem(reply, 400, 'Invalid request', parsed.error.issues.map((issue) => issue.message).join('; '));
    }

    const body = parsed.data;
    const fingerprint = `${body.tenantId}:${body.question}`;
    const existing = idempotency.get(key);
    if (existing) {
      if (existing.fingerprint !== fingerprint) {
        return problem(reply, 409, 'Idempotency conflict', 'This key was used with a different request body.');
      }
      return reply.code(202).send({ id: existing.id, status: 'queued' });
    }

    if (deps.queueDepth) {
      const depth = await deps.queueDepth();
      if (depth > maxQueueDepth) {
        reply.header('retry-after', '5');
        return problem(reply, 429, 'Too many queries', `Queue depth ${depth} exceeds ${maxQueueDepth}.`);
      }
    }

    const record = await deps.store.create({
      id: `qry_${randomUUID()}`,
      tenantId: body.tenantId,
      question: body.question,
    });

    idempotency.set(key, { fingerprint, id: record.id });

    try {
      await deps.runQuestion(record);
    } catch (error) {
      await deps.store.update(record.id, {
        status: 'failed',
        error: error instanceof Error ? error.message : String(error),
      });
    }

    return reply.code(202).send({ id: record.id, status: 'queued' });
  });

  app.get('/v1/queries/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const tenant = tenantFor(request.headers, defaultTenant);
    const record = await deps.store.get(id, tenant);
    if (!record) return problem(reply, 404, 'Not found', `No query ${id} for tenant ${tenant}.`);
    return summary(record);
  });

  app.get('/v1/queries', async (request) => {
    const tenant = tenantFor(request.headers, defaultTenant);
    const query = request.query as { cursor?: string; limit?: string };
    const limit = Math.min(100, Math.max(1, Number(query.limit ?? 20) || 20));

    const page = await deps.store.list(tenant, {
      cursor: query.cursor ?? null,
      limit,
    });

    return {
      data: page.items.map(summary),
      pageInfo: { nextCursor: page.nextCursor, hasMore: page.nextCursor !== null },
    };
  });

  app.get('/v1/queries/:id/rows', async (request, reply) => {
    const { id } = request.params as { id: string };
    const tenant = tenantFor(request.headers, defaultTenant);
    const query = request.query as { limit?: string; offset?: string };
    const limit = Math.min(1_000, Math.max(1, Number(query.limit ?? 100) || 100));
    const offset = Math.max(0, Number(query.offset ?? 0) || 0);

    const page = await deps.store.pageRows(id, tenant, limit, offset);
    if (!page) return problem(reply, 404, 'Not found', `No result rows for query ${id}.`);

    return {
      data: page.rows,
      columns: page.columns,
      pageInfo: {
        offset,
        limit,
        nextOffset: page.truncated ? offset + limit : null,
        hasMore: page.truncated,
      },
    };
  });

  app.setErrorHandler((error: unknown, _request, reply) => {
    const statusCode =
      typeof (error as { statusCode?: unknown }).statusCode === 'number'
        ? (error as { statusCode: number }).statusCode
        : 500;
    const status = statusCode >= 400 ? statusCode : 500;
    const message = error instanceof Error ? error.message : String(error);
    return problem(reply, status, 'Internal error', message);
  });

  return app;
}

export async function start(): Promise<void> {
  const config = loadConfig();
  await initObservability('queryline-api');

  const adapter = createWarehouseAdapter(config.warehouse);
  await adapter.connect();
  const catalog = applyCatalogPolicy(await adapter.catalog());

  const model = createModelClient(config.model);
  const store: QueryStore = config.databaseUrl
    ? new PgQueryStore(new pg.Pool({ connectionString: config.databaseUrl }))
    : new MemoryQueryStore();

  const app = buildServer({
    store,
    defaultTenantId: config.tenantId,
    logger: true,
    maxQueueDepth: config.backpressure.queueDepthLimit,
    runQuestion: async (record) => {
      const result = await ask({
        question: record.question,
        tenantId: record.tenantId,
        catalog,
        adapter,
        model,
        page: { limit: config.limits.maxRows, offset: 0 },
        policy: {
          maxEstimatedRows: config.limits.maxEstimatedRows,
          maxCost: config.limits.maxEstimatedCost,
        },
        maxRepairs: config.limits.maxRepairs,
        maxSqlLength: config.limits.maxSqlLength,
        timeoutMs: config.limits.queryTimeoutMs,
        explainTimeoutMs: config.limits.explainTimeoutMs,
      });

      await store.update(record.id, {
        status: statusFor(result.outcome),
        result,
      });
    },
  });

  const shutdown = async (): Promise<void> => {
    await app.close();
    await adapter.close();
    process.exit(0);
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  await app.listen({ port: config.port, host: '0.0.0.0' });
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  start().catch((error: unknown) => {
    console.error(error);
    process.exit(1);
  });
}
