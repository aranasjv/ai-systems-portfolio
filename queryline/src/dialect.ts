import type { Page, WarehouseKind } from './types.js';

export type ParserDialect = 'Postgresql' | 'TransactSQL';

export interface DialectSpec {
  kind: WarehouseKind;
  /**
   * AST parser used for validation. Oracle has no native parser in
   * node-sql-parser, so it is parsed as Postgresql and falls back to a
   * lexical guard when the syntax does not round-trip.
   */
  parserDialect: ParserDialect;
  /** Oracle folds unquoted identifiers to upper case; Postgres to lower. */
  foldIdentifier(name: string): string;
  quoteIdentifier(name: string): string;
  /** Wrap a validated SELECT so it cannot return more than page.limit rows. */
  pageSql(sql: string, page: Page): string;
  /** Best-effort plan statement(s). Empty when the dialect cannot explain. */
  explainSql(sql: string, statementId: string): string[];
  /** Per-dialect statements that harden the session before execution. */
  sessionSetup(timeoutMs: number): string[];
  /** Whether the wrapper adds its own ORDER BY (SQL Server requires it for OFFSET). */
  wrapperProvidesOrder: boolean;
}

const IDENT_MAX = 128;

function assertIdentifier(name: string): string {
  if (!name || name.length > IDENT_MAX) {
    throw new Error(`Invalid identifier: ${name.slice(0, 32)}`);
  }
  return name;
}

export const postgres: DialectSpec = {
  kind: 'postgres',
  parserDialect: 'Postgresql',
  foldIdentifier: (name) => name.toLowerCase(),
  quoteIdentifier: (name) => `"${assertIdentifier(name).replaceAll('"', '""')}"`,
  pageSql: (sql, page) =>
    `SELECT * FROM (\n${sql}\n) AS ql_page LIMIT ${page.limit} OFFSET ${page.offset}`,
  explainSql: (sql) => [`EXPLAIN (FORMAT JSON) ${sql}`],
  sessionSetup: (timeoutMs) => [
    `SET LOCAL statement_timeout = ${Math.max(1, Math.trunc(timeoutMs))}`,
    'SET LOCAL transaction_read_only = on',
  ],
  wrapperProvidesOrder: false,
};

export const mssql: DialectSpec = {
  kind: 'mssql',
  parserDialect: 'TransactSQL',
  // SQL Server collation is usually case-insensitive; keep the source casing.
  foldIdentifier: (name) => name,
  quoteIdentifier: (name) => `[${assertIdentifier(name).replaceAll(']', ']]')}]`,
  pageSql: (sql, page) =>
    `SELECT * FROM (\n${sql}\n) AS ql_page ORDER BY (SELECT NULL) OFFSET ${page.offset} ROWS FETCH NEXT ${page.limit} ROWS ONLY`,
  // SQL Server needs SET SHOWPLAN_XML ON around the statement, handled in the adapter.
  explainSql: () => [],
  sessionSetup: (timeoutMs) => [`SET LOCK_TIMEOUT ${Math.max(1, Math.trunc(timeoutMs))}`],
  wrapperProvidesOrder: true,
};

export const oracle: DialectSpec = {
  kind: 'oracle',
  parserDialect: 'Postgresql',
  foldIdentifier: (name) => name.toUpperCase(),
  quoteIdentifier: (name) => `"${assertIdentifier(name).replaceAll('"', '""')}"`,
  // 12c+ syntax. Pre-12c would need ROWNUM; documented in the README.
  pageSql: (sql, page) =>
    `SELECT * FROM (\n${sql}\n) ql_page OFFSET ${page.offset} ROWS FETCH NEXT ${page.limit} ROWS ONLY`,
  explainSql: (sql, statementId) => [
    `EXPLAIN PLAN SET STATEMENT_ID = '${statementId.replace(/[^A-Za-z0-9_]/g, '')}' FOR ${sql}`,
  ],
  sessionSetup: () => [],
  wrapperProvidesOrder: false,
};

export const DIALECTS: Record<WarehouseKind, DialectSpec> = {
  postgres,
  mssql,
  oracle,
};

export function dialectFor(kind: WarehouseKind): DialectSpec {
  return DIALECTS[kind];
}

export function statementId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`.slice(0, 30);
}
