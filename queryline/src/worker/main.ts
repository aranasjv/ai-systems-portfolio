import { pathToFileURL } from 'node:url';
import pg from 'pg';
import { applyCatalogPolicy } from '../catalog.js';
import { loadConfig } from '../config.js';
import { createModelClient } from '../ai/model.js';
import { MemoryQueryStore, PgQueryStore, type QueryStore } from '../api/store.js';
import { initObservability } from '../observability.js';
import { createWarehouseAdapter } from '../warehouse/index.js';
import { processQuery } from './processor.js';
import {
  createDeadLetterQueue,
  createQueryQueue,
  createQueryWorker,
  createRedis,
  moveToDeadLetter,
  queueDepth,
} from './queue.js';

export async function startWorker(): Promise<void> {
  const config = loadConfig();
  await initObservability('queryline-worker');

  const adapter = createWarehouseAdapter(config.warehouse);
  await adapter.connect();
  const catalog = applyCatalogPolicy(await adapter.catalog());

  const model = createModelClient(config.model);
  const store: QueryStore = config.databaseUrl
    ? new PgQueryStore(new pg.Pool({ connectionString: config.databaseUrl }))
    : new MemoryQueryStore();

  const connection = createRedis(config.redisUrl);
  const queue = createQueryQueue(connection);
  const dlq = createDeadLetterQueue(connection);

  const worker = createQueryWorker(
    connection,
    async (job) => processQuery({ adapter, catalog, model, store, limits: config.limits }, job),
    { concurrency: 4, maxAttempts: 3 },
  );

  worker.on('failed', (job, error) => {
    if (!job) return;
    if (job.attemptsMade >= (job.opts.attempts ?? 3)) {
      void moveToDeadLetter(dlq, job, error).catch((dlqError: unknown) => {
        console.error('Failed to move job to dead letter queue', dlqError);
      });
    }
  });

  const depthTimer = setInterval(() => {
    void queueDepth(queue)
      .then((depth) => {
        if (depth > config.backpressure.queueDepthLimit) {
          console.warn(`Queue depth ${depth} exceeds limit ${config.backpressure.queueDepthLimit}`);
        }
      })
      .catch(() => undefined);
  }, 15_000);
  depthTimer.unref();

  const shutdown = async (): Promise<void> => {
    clearInterval(depthTimer);
    await worker.close();
    await queue.close();
    await dlq.close();
    await connection.quit();
    await adapter.close();
    process.exit(0);
  };

  process.on('SIGTERM', () => void shutdown());
  process.on('SIGINT', () => void shutdown());

  console.log('queryline worker ready');
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  startWorker().catch((error: unknown) => {
    console.error(error);
    process.exit(1);
  });
}
