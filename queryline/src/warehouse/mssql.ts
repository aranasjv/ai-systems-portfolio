import sql from 'mssql';
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
  TABLE_SCHEMA: string;
  TABLE_NAME: string;
  COLUMN_NAME: string;
  DATA_TYPE: string;
  IS_NULLABLE: string;
}

interface ShowplanRow {
  [key: string]: unknown;
}

export class MssqlAdapter implements WarehouseAdapter {
  readonly kind = 'mssql' as const;
  private pool: sql.ConnectionPool | null = null;
  private readonly dialect = dialectFor('mssql');
  private readonly sqlConfig: sql.config;

  constructor(private readonly config: WarehouseConnectionConfig) {
    this.sqlConfig = {
      server: config.host,
      port: config.port,
      user: config.user,
      password: config.password,
      database: config.database,
      options: {
        encrypt: config.encrypt ?? false,
        trustServerCertificate: config.trustServerCertificate ?? true,
      },
      pool: { max: 10, min: 0, idleTimeoutMillis: 30_000 },
      connectionTimeout: 5_000,
      requestTimeout: 30_000,
    };
  }

  async connect(): Promise<void> {
    this.pool = await new sql.ConnectionPool(this.sqlConfig).connect();
    await this.pool.request().query('SELECT 1');
  }

  async close(): Promise<void> {
    await this.pool?.close();
    this.pool = null;
  }

  private get db(): sql.ConnectionPool {
    if (!this.pool) throw new Error('MssqlAdapter is not connected');
    return this.pool;
  }

  admin(): { exec(statement: string): Promise<void> } {
    return {
      exec: async (statement) => {
        await this.db.request().batch(statement);
      },
    };
  }

  async catalog(): Promise<SchemaCatalog> {
    const request = this.db.request();
    if (this.config.schema) {
      request.input('schema', sql.NVarChar, this.config.schema);
    }

    const result = await request.query<ColumnRow>(
      `SELECT TABLE_SCHEMA, TABLE_NAME, COLUMN_NAME, DATA_TYPE, IS_NULLABLE
         FROM INFORMATION_SCHEMA.COLUMNS
        WHERE ${this.config.schema ? 'TABLE_SCHEMA = @schema' : "TABLE_SCHEMA NOT IN ('sys', 'INFORMATION_SCHEMA')"}
        ORDER BY TABLE_SCHEMA, TABLE_NAME, ORDINAL_POSITION`,
    );

    const tables = new Map<string, TableMeta>();
    for (const row of result.recordset) {
      const key = `${row.TABLE_SCHEMA}.${row.TABLE_NAME}`;
      const column: ColumnMeta = {
        name: row.COLUMN_NAME,
        dataType: row.DATA_TYPE,
        nullable: row.IS_NULLABLE === 'YES',
      };
      const existing = tables.get(key);
      if (existing) {
        existing.columns.push(column);
      } else {
        tables.set(key, {
          schema: row.TABLE_SCHEMA,
          name: row.TABLE_NAME,
          columns: [column],
          tenantScoped: false,
          piiColumns: [],
        });
      }
    }

    return { kind: 'mssql', tables: [...tables.values()] };
  }

  async estimate(sqlText: string, timeoutMs: number): Promise<QueryEstimate> {
    // SHOWPLAN_XML is session-scoped, so it needs its own connection rather
    // than a pooled request that may land on a different socket.
    const connection = await new sql.ConnectionPool({
      ...this.sqlConfig,
      requestTimeout: Math.max(1_000, timeoutMs),
    }).connect();

    try {
      await connection.request().batch('SET SHOWPLAN_XML ON');
      // With SHOWPLAN_XML ON the statement is compiled, not executed.
      const result = await connection.request().batch(sqlText);

      const row = result.recordset?.[0] as ShowplanRow | undefined;
      const xml = row ? String(Object.values(row)[0] ?? '') : '';
      const rowsMatch =
        /EstimateRows="([\d.]+)"/i.exec(xml) ?? /StatementEstRows="([\d.]+)"/i.exec(xml);
      const costMatch = /EstimatedSubtreeCost="([\d.]+)"/i.exec(xml);

      return {
        estimatedRows: rowsMatch ? Number(rowsMatch[1]) : null,
        cost: costMatch ? Number(costMatch[1]) : null,
        source: 'explain',
      };
    } catch {
      return { estimatedRows: null, cost: null, source: 'unverified' };
    } finally {
      try {
        await connection.request().batch('SET SHOWPLAN_XML OFF');
      } catch {
        // the connection is about to be discarded; nothing useful to do
      }
      await connection.close();
    }
  }

  async execute(sqlText: string, options: ExecuteOptions): Promise<ResultSet> {
    const paged = this.dialect.pageSql(sqlText, options);
    const request = this.db.request();

    const mutable = request as unknown as { requestTimeout: number; arrayRowMode: boolean };
    mutable.requestTimeout = options.timeoutMs;
    mutable.arrayRowMode = true;

    const setup = this.dialect.sessionSetup(options.timeoutMs).join(';\n');
    const result = await request.query(`${setup};\n${paged}`);

    const recordset = result.recordset as unknown as
      | (unknown[][] & { columns?: Record<string, unknown> })
      | undefined;

    const columns = recordset?.columns ? Object.keys(recordset.columns) : [];
    const rows = (recordset ?? []) as unknown as unknown[][];

    return {
      columns,
      rows,
      rowCount: rows.length,
      truncated: rows.length >= options.limit,
    };
  }
}
