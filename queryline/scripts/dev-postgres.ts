import { existsSync } from 'node:fs';
import EmbeddedPostgres from 'embedded-postgres';

/**
 * Local-only Postgres for environments without Docker. Downloads a Postgres
 * binary on first run and keeps the data directory under .pgdata.
 */
const dataDir = process.env.PGDATA_DIR ?? '.pgdata';
// 5432 is commonly reserved on Windows (WinNAT / Hyper-V), so the embedded
// instance uses 55432 by default.
const port = Number(process.env.PGPORT ?? 55432);
const user = process.env.PGUSER_NAME ?? 'queryline';
const password = process.env.PGPASSWORD_VALUE ?? 'queryline';
const database = process.env.PGDATABASE_NAME ?? 'queryline';

async function main(): Promise<void> {
  const pg = new EmbeddedPostgres({
    databaseDir: dataDir,
    user,
    password,
    port,
    persistent: true,
  });

  if (!existsSync(`${dataDir}/PG_VERSION`)) {
    await pg.initialise();
  }

  await pg.start();

  try {
    await pg.createDatabase(database);
  } catch {
    // database already exists from a previous run
  }

  console.log(`embedded postgres ready on port ${port} (database: ${database})`);
  // Keep the process alive for as long as the server runs.
  setInterval(() => undefined, 1 << 30);

  const stop = async (): Promise<void> => {
    console.log('stopping embedded postgres');
    await pg.stop();
    process.exit(0);
  };

  process.on('SIGINT', () => void stop());
  process.on('SIGTERM', () => void stop());
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
