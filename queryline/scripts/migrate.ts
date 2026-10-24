import { readFile } from 'node:fs/promises';
import path from 'node:path';
import pg from 'pg';
import { loadConfig } from '../src/config.js';
import { createWarehouseAdapter } from '../src/warehouse/index.js';

export function splitStatements(sql: string): string[] {
  return sql
    .split(';')
    .map((statement) =>
      statement
        .split(/\r?\n/)
        .filter((line) => !line.trim().startsWith('--'))
        .join('\n')
        .trim(),
    )
    .filter((statement) => statement.length > 0);
}

async function applyControlPlane(connectionString: string): Promise<void> {
  const client = new pg.Client({ connectionString });
  await client.connect();

  try {
    const base = await readFile(path.resolve('sql/control-plane.sql'), 'utf8');
    for (const statement of splitStatements(base)) {
      await client.query(statement);
    }
    console.log('control plane: base schema applied');

    try {
      const vector = await readFile(path.resolve('sql/control-plane-pgvector.sql'), 'utf8');
      for (const statement of splitStatements(vector)) {
        await client.query(statement);
      }
      console.log('control plane: pgvector schema applied');
    } catch (error) {
      console.warn(
        'control plane: pgvector unavailable, continuing without embeddings:',
        error instanceof Error ? error.message : error,
      );
    }
  } finally {
    await client.end();
  }
}

async function applyWarehouse(): Promise<void> {
  const config = loadConfig();
  const adapter = createWarehouseAdapter(config.warehouse);
  await adapter.connect();

  try {
    const file = path.resolve(`sql/warehouse.${config.warehouse.kind}.sql`);
    const sql = await readFile(file, 'utf8');
    for (const statement of splitStatements(sql)) {
      await adapter.admin().exec(statement);
    }
    console.log(`warehouse (${config.warehouse.kind}): schema applied`);
  } finally {
    await adapter.close();
  }
}

async function main(): Promise<void> {
  const config = loadConfig();
  if (config.databaseUrl) {
    await applyControlPlane(config.databaseUrl);
  } else {
    console.warn('DATABASE_URL not set; skipping control-plane migration');
  }
  await applyWarehouse();
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
