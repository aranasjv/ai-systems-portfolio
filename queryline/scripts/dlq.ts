import { loadConfig } from '../src/config.js';
import {
  createDeadLetterQueue,
  createQueryQueue,
  createRedis,
  listDeadLetters,
  replayDeadLetter,
} from '../src/worker/queue.js';

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  const config = loadConfig();

  const connection = createRedis(config.redisUrl);
  const queue = createQueryQueue(connection);
  const dlq = createDeadLetterQueue(connection);

  try {
    if (command === 'list') {
      const jobs = await listDeadLetters(dlq);
      console.log(JSON.stringify(jobs, null, 2));
      return;
    }

    if (command === 'replay') {
      const idIndex = rest.indexOf('--id');
      const id = idIndex === -1 ? undefined : rest[idIndex + 1];
      if (!id) {
        console.error('Usage: pnpm dlq replay --id <dead-letter-job-id>');
        process.exit(1);
      }

      const replayed = await replayDeadLetter(dlq, queue, id, 3);
      console.log(replayed ? `replayed ${id}` : `dead letter ${id} not found`);
      if (!replayed) process.exit(1);
      return;
    }

    console.error('Usage: pnpm dlq <list|replay> [--id <id>]');
    process.exit(1);
  } finally {
    await queue.close();
    await dlq.close();
    await connection.quit();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
