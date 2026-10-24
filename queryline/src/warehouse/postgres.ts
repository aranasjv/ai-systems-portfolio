import pg from 'pg';
import { dialectFor } from '../dialect.js';
import type {
  ColumnMeta,
  ExecuteOptions,
  QueryEstimate,
  ResultSet,
  SchemaCatalog,
  TableMeta,
  WarehouseAdapter,
  WarehouseConnectionConfig,
} from '../types.js';

interface ColumnRow {
  table_schema: string;
  table_name: string;
  column_name: string;
  data_type: string;
  is_nullable: string;
}

export class PostgresAdapter implements WarehouseAdapter {
  readonly kind = 'postgres' as const;
  private pool: pg.Pool | null = null;
  private readonly dialect = dialectFor('postgres');

  constructor(private readonly config: WarehouseConnectionConfig) {}

  async connect(): Promise<void> {
    this.pool = new pg.Pool({
      host: this.config.host,
      port: this.config.port,
      user: this.config.user,
      password: this.config.password,
      database: this.config.database,
      max: 10,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 5_000,
      ssl: this.config.ssl ? { rejectUnauthorized: false } : undefined,
    });
    await this.pool.query('SELECT 1');
  }

  async close(): Promise<void> {
    await this.pool?.end();
    this.pool = null;
  }

  private get db(): pg.Pool {
    if (!this.pool) throw new Error('PostgresAdapter is not connected');
    return this.pool;
  }

  admin(): { exec(statement: string): Promise<void> } {
    return {
      exec: async (statement) => {
        await this.db.query(statement);
      },
    };
  }

  async catalog(): Promise<SchemaCatalog> {
    // Restrict introspection to the configured schema so the control plane
    // (same database in local dev) is never exposed to the agent.
    const result = this.config.schema
      ? await this.db.query<ColumnRow>(
          `SELECT table_schema, table_name, column_name, data_type, is_nullable
             FROM information_schema.columns
            WHERE table_schema = $1
            ORDER BY table_name, ordinal_position`,
          [this.config.schema],
        )
      : await this.db.query<ColumnRow>(
          `SELECT table_schema, table_name, column_name, data_type, is_nullable
             FROM information_schema.columns
            WHERE table_schema NOT IN ('pg_catalog', 'information_schema')
            ORDER BY table_schema, table_name, ordinal_position`,
        );

    const tables = new Map<string, TableMeta>();
    for (const row of result.rows) {
      const key = `${row.table_schema}.${row.table_name}`;
      const existing = tables.get(key);
      const column: ColumnMeta = {
        name: row.column_name,
        dataType: row.data_type,
        nullable: row.is_nullable === 'YES',
      };
      if (existing) {
        existing.columns.push(column);
      } else {
        tables.set(key, {
          schema: row.table_schema,
          name: row.table_name,
          columns: [column],
          tenantScoped: false,
          piiColumns: [],
        });
      }
    }

    return { kind: 'postgres', tables: [...tables.values()] };
  }

  async estimate(sql: string, timeoutMs: number): Promise<QueryEstimate> {
    const [statement] = this.dialect.explainSql(sql, 'pg');
    if (!statement) return { estimatedRows: null, cost: null, source: 'unverified' };

    const client = await this.db.connect();
    try {
      await client.query('BEGIN');
      await client.query('SET TRANSACTION READ ONLY');
      await client.query(`SET LOCAL statement_timeout = ${Math.max(1, Math.trunc(timeoutMs))}`);
      const result = await client.query(statement);
      await client.query('ROLLBACK');

      const raw = result.rows[0]?.['QUERY PLAN'];
      const parsed = typeof raw === 'string' ? (JSON.parse(raw) as unknown) : raw;
      const root = Array.isArray(parsed) ? (parsed[0] as Record<string, unknown>) : parsed;
      const plan = (root?.['Plan'] ?? root) as Record<string, unknown> | undefined;

      const rows = Number(plan?.['Plan Rows']);
      const cost = Number(plan?.['Total Cost']);
      return {
        estimatedRows: Number.isFinite(rows) ? rows : null,
        cost: Number.isFinite(cost) ? cost : null,
        source: 'explain',
      };
    } catch (error) {
      try {
        await client.query('ROLLBACK');
      } catch {
        // ignore
      }
      throw error;
    } finally {
      client.release();
    }
  }

  async execute(sql: string, options: ExecuteOptions): Promise<ResultSet> {
    const paged = this.dialect.pageSql(sql, options);
    const client = await this.db.connect();

    try {
      await client.query('BEGIN');
      // Must be the first statement that touches data in the transaction.
      await client.query('SET TRANSACTION READ ONLY');
      for (const setup of this.dialect.sessionSetup(options.timeoutMs)) {
        await client.query(setup);
      }

      const result = await client.query({ text: paged, rowMode: 'array' });
      await client.query('ROLLBACK');

      const columns = result.fields.map((field) => field.name);
      const rows = result.rows as unknown[][];
      return {
        columns,
        rows,
        rowCount: rows.length,
        truncated: rows.length >= options.limit,
      };
    } catch (error) {
      try {
        await client.query('ROLLBACK');
      } catch {
        // connection may already be dead; the original error is what matters
      }
      throw error;
    } finally {
      client.release();
    }
  }
}
