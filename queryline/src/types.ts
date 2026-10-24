export type WarehouseKind = 'postgres' | 'mssql' | 'oracle';

export interface WarehouseConnectionConfig {
  kind: WarehouseKind;
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
  schema?: string;
  ssl?: boolean;
  serviceName?: string;
  encrypt?: boolean;
  trustServerCertificate?: boolean;
}

export interface ColumnMeta {
  name: string;
  dataType: string;
  nullable: boolean;
}

export interface TableMeta {
  schema: string;
  name: string;
  columns: ColumnMeta[];
  /** When true, every query touching this table must filter tenant_id. */
  tenantScoped: boolean;
  /** Columns that must never appear in a result set. */
  piiColumns: string[];
}

export interface SchemaCatalog {
  kind: WarehouseKind;
  tables: TableMeta[];
}

export interface Page {
  limit: number;
  offset: number;
}

export interface QueryEstimate {
  estimatedRows: number | null;
  cost: number | null;
  /** `unverified` means the dialect could not produce a plan; admission falls back. */
  source: 'explain' | 'unverified';
}

export interface ResultSet {
  columns: string[];
  rows: unknown[][];
  rowCount: number;
  truncated: boolean;
}

export interface ExecuteOptions extends Page {
  timeoutMs: number;
  signal?: AbortSignal;
}

/**
 * Deliberately separate from the read path: seeding and migrations use this,
 * the agent never does. Implementations run without the guard or row cap.
 */
export interface WarehouseAdmin {
  exec(statement: string): Promise<void>;
}

export interface WarehouseAdapter {
  readonly kind: WarehouseKind;
  connect(): Promise<void>;
  close(): Promise<void>;
  catalog(): Promise<SchemaCatalog>;
  estimate(sql: string, timeoutMs: number): Promise<QueryEstimate>;
  execute(sql: string, options: ExecuteOptions): Promise<ResultSet>;
  admin(): WarehouseAdmin;
}

export type RefusalReason =
  | 'empty'
  | 'too_long'
  | 'multiple_statements'
  | 'not_select'
  | 'forbidden_keyword'
  | 'unknown_table'
  | 'pii_column'
  | 'wildcard_pii'
  | 'missing_tenant_predicate'
  | 'parse_error'
  | 'pagination_requires_order_by'
  | 'model_refusal'
  | 'admission_rejected'
  | 'execution_error'
  | 'budget_exceeded';

export interface GuardRequest {
  sql: string;
  dialect: WarehouseKind;
  catalog: SchemaCatalog;
  tenantId: string;
  maxSqlLength?: number;
}

export type GuardResult =
  | {
      ok: true;
      sql: string;
      tables: string[];
      validation: 'ast' | 'lexical';
      hasOrderBy: boolean;
    }
  | {
      ok: false;
      reason: RefusalReason;
      detail: string;
      /** Whether the model may be asked to correct the SQL. Safety refusals are not repairable. */
      repairable: boolean;
    };

export interface ChartSpec {
  type: 'bar' | 'line' | 'table' | 'number';
  x: string | null;
  y: string[];
}

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

export interface AnswerResult {
  outcome: 'answered' | 'refused' | 'failed';
  sql: string | null;
  explanation: string | null;
  columns: string[];
  rows: unknown[][];
  truncated: boolean;
  chart: ChartSpec | null;
  refusal: { reason: RefusalReason; detail: string } | null;
  degraded: string[];
  repairAttempts: number;
  validation: 'ast' | 'lexical' | null;
  usage: Usage;
  latencyMs: number;
}
