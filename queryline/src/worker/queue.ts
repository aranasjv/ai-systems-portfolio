import { Queue, Worker, type Job, type WorkerOptions } from 'bullmq';
import IORedis from 'ioredis';

export const QUERY_QUEUE = 'query.run';
export const QUERY_DLQ = 'query.dlq';

export interface QueryJob {
  queryId: string;
  tenantId: string;
  question: string;
}

export function createRedis(url: string): IORedis {
  return new IORedis(url, {
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
  });
}

export function createQueryQueue(connection: IORedis): Queue<QueryJob> {
  return new Queue<QueryJob>(QUERY_QUEUE, { connection });
}

export function createDeadLetterQueue(connection: IORedis): Queue {
  return new Queue(QUERY_DLQ, { connection });
}

export interface WorkerSettings {
  concurrency: number;
  maxAttempts: number;
}

/**
 * BullMQ gives us the retry/backoff shell. Poison classification happens in
 * the processor: only transient errors are allowed to consume attempts.
 */
export function createQueryWorker(
  connection: IORedis,
  handler: (job: Job<QueryJob>) => Promise<void>,
  settings: WorkerSettings,
): Worker<QueryJob> {
  const options: WorkerOptions = {
    connection,
    concurrency: settings.concurrency,
    limiter: { max: 20, duration: 1_000 },
    // Prefetch stays at 1 so one tenant cannot fill a worker's local buffer.
    drainDelay: 5,
  };

  return new Worker<QueryJob>(QUERY_QUEUE, handler, options);
}

export async function enqueueQuery(
  queue: Queue<QueryJob>,
  job: QueryJob,
  attempts: number,
): Promise<string> {
  const added = await queue.add('run', job, {
    jobId: job.queryId,
    attempts,
    backoff: { type: 'exponential', delay: 500 },
    removeOnComplete: 1_000,
    removeOnFail: false,
  });
  return added.id ?? job.queryId;
}

export async function queueDepth(queue: Queue): Promise<number> {
  const counts = await queue.getJobCounts('waiting', 'active', 'delayed');
  return (counts.waiting ?? 0) + (counts.active ?? 0) + (counts.delayed ?? 0);
}

export async function moveToDeadLetter(
  dlq: Queue,
  job: Job<QueryJob>,
  error: Error,
): Promise<void> {
  await dlq.add(
    'dead',
    {
      ...job.data,
      failedReason: error.message,
      attemptsMade: job.attemptsMade,
      failedAt: new Date().toISOString(),
    },
    { jobId: `${job.data.queryId}:dead:${Date.now()}`, removeOnComplete: false, removeOnFail: false },
  );
}

export async function listDeadLetters(dlq: Queue): Promise<
  { id: string | undefined; data: unknown; failedReason: string | undefined }[]
> {
  const jobs = await dlq.getJobs(['waiting', 'delayed', 'failed'], 0, 99);
  return jobs.map((job) => ({
    id: job.id,
    data: job.data,
    failedReason: job.failedReason,
  }));
}

export async function replayDeadLetter(
  dlq: Queue,
  queue: Queue<QueryJob>,
  id: string,
  attempts: number,
): Promise<boolean> {
  const job = await dlq.getJob(id);
  if (!job) return false;

  const data = job.data as QueryJob & { failedReason?: string; attemptsMade?: number };
  await enqueueQuery(
    queue,
    { queryId: data.queryId, tenantId: data.tenantId, question: data.question },
    attempts,
  );
  await job.remove();
  return true;
}
