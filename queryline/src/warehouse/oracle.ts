import oracledb from 'oracledb';
import { dialectFor, statementId } from '../dialect.js';
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

interface OracleColumnRow {
  OWNER: string;
  TABLE_NAME: string;
  COLUMN_NAME: string;
  DATA_TYPE: string;
  NULLABLE: string;
}

export class OracleAdapter implements WarehouseAdapter {
  readonly kind = 'oracle' as const;
  private pool: oracledb.Pool | null = null;
  private readonly dialect = dialectFor('oracle');

  constructor(private readonly config: WarehouseConnectionConfig) {}

  private connectString(): string {
    const service = this.config.serviceName ?? this.config.database;
    return `${this.config.host}:${this.config.port}/${service}`;
  }

  async connect(): Promise<void> {
    this.pool = await oracledb.createPool({
      user: this.config.user,
      password: this.config.password,
      connectString: this.connectString(),
      poolMin: 0,
      poolMax: 10,
      poolTimeout: 30,
    });

    const connection = await this.pool.getConnection();
    try {
      await connection.execute('SELECT 1 FROM DUAL');
    } finally {
      await connection.close();
    }
  }

  async close(): Promise<void> {
    await this.pool?.close(0);
    this.pool = null;
  }

  private get db(): oracledb.Pool {
    if (!this.pool) throw new Error('OracleAdapter is not connected');
    return this.pool;
  }

  private owner(): string {
    return (this.config.schema ?? this.config.user).toUpperCase();
  }

  admin(): { exec(statement: string): Promise<void> } {
    return {
      exec: async (statement) => {
        const connection = await this.db.getConnection();
        try {
          await connection.execute(statement);
          await connection.commit();
        } finally {
          await connection.close();
        }
      },
    };
  }

  async catalog(): Promise<SchemaCatalog> {
    const connection = await this.db.getConnection();
    try {
      const result = await connection.execute<OracleColumnRow>(
        `SELECT owner, table_name, column_name, data_type, nullable
           FROM all_tab_columns
          WHERE owner = :1
          ORDER BY table_name, column_id`,
        [this.owner()],
        { outFormat: oracledb.OUT_FORMAT_OBJECT },
      );

      const tables = new Map<string, TableMeta>();
      for (const row of result.rows ?? []) {
        const key = `${row.OWNER}.${row.TABLE_NAME}`;
        const column: ColumnMeta = {
          name: row.COLUMN_NAME,
          dataType: row.DATA_TYPE,
          nullable: row.NULLABLE === 'Y',
        };
        const existing = tables.get(key);
        if (existing) {
          existing.columns.push(column);
        } else {
          tables.set(key, {
            schema: row.OWNER,
            name: row.TABLE_NAME,
            columns: [column],
            tenantScoped: false,
            piiColumns: [],
          });
        }
      }

      return { kind: 'oracle', tables: [...tables.values()] };
    } finally {
      await connection.close();
    }
  }

  async estimate(sql: string, timeoutMs: number): Promise<QueryEstimate> {
    const id = statementId('QL');
    const connection = await this.db.getConnection();
    connection.callTimeout = timeoutMs;

    try {
      await connection.execute(`EXPLAIN PLAN SET STATEMENT_ID = '${id}' FOR ${sql}`);

      const result = await connection.execute<{ CARDINALITY: number | null; COST: number | null }>(
        `SELECT cardinality, cost FROM plan_table WHERE statement_id = :1 AND id = 0`,
        [id],
        { outFormat: oracledb.OUT_FORMAT_OBJECT },
      );

      const row = result.rows?.[0];
      return {
        estimatedRows: row?.CARDINALITY ?? null,
        cost: row?.COST ?? null,
        source: 'explain',
      };
    } catch {
      return { estimatedRows: null, cost: null, source: 'unverified' };
    } finally {
      try {
        await connection.execute(`DELETE FROM plan_table WHERE statement_id = :1`, [id]);
      } catch {
        // PLAN_TABLE may be read-only for this user
      }
      await connection.close();
    }
  }

  async execute(sql: string, options: ExecuteOptions): Promise<ResultSet> {
    const paged = this.dialect.pageSql(sql, options);
    const connection = await this.db.getConnection();
    connection.callTimeout = options.timeoutMs;

    try {
      // No statement_timeout in Oracle; callTimeout above is the client-side
      // bound, and the reader role has no DML grants.
      await connection.execute('SET TRANSACTION READ ONLY');

      const result = await connection.execute<unknown[]>(paged, [], {
        outFormat: oracledb.OUT_FORMAT_ARRAY,
        maxRows: options.limit,
        fetchArraySize: Math.min(options.limit, 500),
      });

      await connection.rollback();

      const rows = (result.rows ?? []) as unknown[][];
      return {
        columns: (result.metaData ?? []).map((meta) => meta.name),
        rows,
        rowCount: rows.length,
        truncated: rows.length >= options.limit,
      };
    } finally {
      await connection.close();
    }
  }
}
