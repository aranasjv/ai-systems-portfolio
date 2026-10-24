import { dialectFor } from './dialect.js';
import { sqlParser } from './sql-parser.js';
import type {
  GuardRequest,
  GuardResult,
  RefusalReason,
  SchemaCatalog,
  TableMeta,
  WarehouseKind,
} from './types.js';

const COMMON_FORBIDDEN = [
  'insert',
  'update',
  'delete',
  'merge',
  'drop',
  'alter',
  'create',
  'truncate',
  'grant',
  'revoke',
  'call',
  'exec',
  'execute',
  'declare',
  'begin',
  'commit',
  'rollback',
  'savepoint',
  'vacuum',
  'analyze',
  'copy',
  'into',
  'attach',
  'detach',
  'pragma',
  'load',
  'outfile',
  'dumpfile',
  'shutdown',
  'kill',
  'reconfigure',
  'backup',
  'restore',
  'waitfor',
];

const DIALECT_FORBIDDEN: Record<WarehouseKind, string[]> = {
  postgres: ['pg_read_file', 'pg_ls_dir', 'lo_import', 'lo_export', 'dblink', 'pg_sleep'],
  mssql: ['openrowset', 'openquery', 'opendatasource', 'xp_cmdshell', 'bulk'],
  oracle: ['dbms_', 'utl_', 'execute immediate'],
};

type AnyNode = Record<string, unknown>;

function isNode(value: unknown): value is AnyNode {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Remove string literals, quoted identifiers, and comments so keyword checks
 * cannot be fooled by `SELECT 'drop table x'`, and so quoted identifiers named
 * after keywords do not trigger false positives.
 */
export function stripLiteralsAndComments(sql: string): string {
  let out = '';
  let i = 0;

  while (i < sql.length) {
    const ch = sql[i]!;
    const next = sql[i + 1];

    if (ch === '-' && next === '-') {
      while (i < sql.length && sql[i] !== '\n') i += 1;
      continue;
    }

    if (ch === '/' && next === '*') {
      i += 2;
      while (i < sql.length && !(sql[i] === '*' && sql[i + 1] === '/')) i += 1;
      i += 2;
      out += ' ';
      continue;
    }

    if (ch === "'") {
      i += 1;
      while (i < sql.length) {
        if (sql[i] === "'" && sql[i + 1] === "'") {
          i += 2;
          continue;
        }
        if (sql[i] === "'") {
          i += 1;
          break;
        }
        i += 1;
      }
      out += ' ';
      continue;
    }

    // Postgres dollar-quoted strings: $tag$ ... $tag$
    if (ch === '$') {
      const match = /^\$[A-Za-z0-9_]*\$/.exec(sql.slice(i));
      if (match) {
        const tag = match[0];
        const end = sql.indexOf(tag, i + tag.length);
        i = end === -1 ? sql.length : end + tag.length;
        out += ' ';
        continue;
      }
    }

    if (ch === '"') {
      i += 1;
      while (i < sql.length) {
        if (sql[i] === '"' && sql[i + 1] === '"') {
          i += 2;
          continue;
        }
        if (sql[i] === '"') {
          i += 1;
          break;
        }
        i += 1;
      }
      out += ' ';
      continue;
    }

    // SQL Server bracketed identifier
    if (ch === '[') {
      i += 1;
      while (i < sql.length) {
        if (sql[i] === ']' && sql[i + 1] === ']') {
          i += 2;
          continue;
        }
        if (sql[i] === ']') {
          i += 1;
          break;
        }
        i += 1;
      }
      out += ' ';
      continue;
    }

    out += ch;
    i += 1;
  }

  return out;
}

function hasWord(text: string, word: string): boolean {
  const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^a-z0-9_])${escaped}([^a-z0-9_]|$)`, 'i').test(text);
}

function forbiddenKeyword(text: string, dialect: WarehouseKind): string | null {
  for (const word of COMMON_FORBIDDEN) {
    if (hasWord(text, word)) return word;
  }
  for (const word of DIALECT_FORBIDDEN[dialect]) {
    if (word.endsWith('_')) {
      if (text.toLowerCase().includes(word)) return word;
    } else if (hasWord(text, word)) {
      return word;
    }
  }
  return null;
}

function walk(node: unknown, visit: (node: AnyNode) => void): void {
  if (Array.isArray(node)) {
    for (const item of node) walk(item, visit);
    return;
  }
  if (!isNode(node)) return;
  visit(node);
  for (const value of Object.values(node)) walk(value, visit);
}

function columnName(ref: AnyNode): string | null {
  if (ref.type !== 'column_ref') return null;
  const column = ref.column;
  if (typeof column === 'string') return column;
  if (isNode(column)) {
    if (typeof column.value === 'string') return column.value;
    // node-sql-parser wraps plain column names as { expr: { value } }
    if (isNode(column.expr) && typeof column.expr.value === 'string') {
      return column.expr.value;
    }
    if (column.type === 'column_ref' && typeof column.column === 'string') return column.column;
  }
  return null;
}

function literalValue(node: unknown): string | null {
  if (!isNode(node)) return null;
  if (typeof node.value === 'string' || typeof node.value === 'number') {
    return String(node.value);
  }
  return null;
}

function collectTables(node: unknown, out: Set<string>): void {
  if (Array.isArray(node)) {
    for (const item of node) collectTables(item, out);
    return;
  }
  if (!isNode(node)) return;

  if (typeof node.table === 'string') out.add(node.table);
  if (isNode(node.table) && typeof node.table.value === 'string') out.add(node.table.value);

  if (Array.isArray(node.from)) collectTables(node.from, out);

  if (isNode(node.expr)) {
    const inner = isNode(node.expr.ast) ? node.expr.ast : node.expr;
    if (isNode(inner)) {
      if (Array.isArray(inner.from)) collectTables(inner.from, out);
      if (Array.isArray(inner._next)) collectTables(inner._next, out);
    }
  }

  if (Array.isArray(node._next)) collectTables(node._next, out);
}

function collectCteNames(ast: unknown): Set<string> {
  const names = new Set<string>();
  if (!isNode(ast) || !Array.isArray(ast.with)) return names;
  for (const cte of ast.with) {
    if (!isNode(cte)) continue;
    if (isNode(cte.name) && typeof cte.name.value === 'string') names.add(cte.name.value);
  }
  return names;
}

function normalize(name: string, dialect: WarehouseKind): string {
  return dialectFor(dialect).foldIdentifier(name).toLowerCase();
}

function catalogIndex(catalog: SchemaCatalog): Map<string, TableMeta> {
  const index = new Map<string, TableMeta>();
  for (const table of catalog.tables) {
    index.set(table.name.toLowerCase(), table);
    index.set(`${table.schema}.${table.name}`.toLowerCase(), table);
  }
  return index;
}

function findTable(name: string, catalog: SchemaCatalog): TableMeta | null {
  const lower = name.toLowerCase();
  for (const table of catalog.tables) {
    if (table.name.toLowerCase() === lower) return table;
    if (`${table.schema}.${table.name}`.toLowerCase() === lower) return table;
    if (`${table.schema.toLowerCase()}.${table.name.toLowerCase()}` === lower) return table;
  }
  return null;
}

function tenantPredicatePresent(ast: unknown, tenantId: string): boolean {
  let found = false;
  walk(ast, (node) => {
    if (node.type !== 'binary_expr' || node.operator !== '=') return;
    const left = isNode(node.left) ? node.left : null;
    const right = isNode(node.right) ? node.right : null;
    if (!left || !right) return;

    const leftColumn = columnName(left);
    const rightColumn = columnName(right);

    if (leftColumn?.toLowerCase() === 'tenant_id' && literalValue(right) === tenantId) {
      found = true;
    }
    if (rightColumn?.toLowerCase() === 'tenant_id' && literalValue(left) === tenantId) {
      found = true;
    }
  });
  return found;
}

function refusal(reason: RefusalReason, detail: string, repairable: boolean): GuardResult {
  return { ok: false, reason, detail, repairable };
}

export function validateSql(request: GuardRequest): GuardResult {
  const maxLength = request.maxSqlLength ?? 20_000;
  const raw = request.sql.trim().replace(/;\s*$/, '');

  if (!raw) return refusal('empty', 'The model produced an empty statement.', true);
  if (raw.length > maxLength) {
    return refusal('too_long', `SQL exceeds the ${maxLength} character limit.`, false);
  }

  const stripped = stripLiteralsAndComments(raw);

  if (stripped.includes(';')) {
    return refusal('multiple_statements', 'Only one statement may be executed.', false);
  }

  const forbidden = forbiddenKeyword(stripped, request.dialect);
  if (forbidden) {
    return refusal(
      'forbidden_keyword',
      `Statement contains a forbidden construct: ${forbidden}.`,
      false,
    );
  }

  if (/\bfor\s+update\b/i.test(stripped)) {
    return refusal('forbidden_keyword', 'Locking reads (FOR UPDATE) are not allowed.', false);
  }

  const dialect = dialectFor(request.dialect);
  const index = catalogIndex(request.catalog);

  let ast: unknown;
  let validation: 'ast' | 'lexical' = 'ast';

  try {
    const parsed = sqlParser.astify(raw, { database: dialect.parserDialect });
    if (Array.isArray(parsed)) {
      return refusal('multiple_statements', 'Only one statement may be executed.', false);
    }
    ast = parsed;
  } catch (error) {
    if (request.dialect === 'oracle') {
      validation = 'lexical';
      ast = null;
    } else {
      return refusal(
        'parse_error',
        `SQL did not parse: ${error instanceof Error ? error.message : String(error)}`,
        true,
      );
    }
  }

  let tables: Set<string>;
  let hasOrderBy: boolean;

  if (validation === 'ast' && ast) {
    const node = ast as AnyNode;
    if (node.type !== 'select') {
      return refusal('not_select', `Only SELECT statements are allowed (got ${String(node.type)}).`, false);
    }

    const ctes = collectCteNames(ast);
    tables = new Set<string>();
    collectTables(node.from, tables);
    // CTE bodies may reference real tables too.
    if (Array.isArray(node.with)) {
      for (const cte of node.with) {
        if (!isNode(cte) || !isNode(cte.stmt)) continue;
        const inner = isNode(cte.stmt.ast) ? cte.stmt.ast : cte.stmt;
        if (isNode(inner) && Array.isArray(inner.from)) {
          collectTables(inner.from, tables);
        }
      }
    }
    for (const cte of ctes) {
      tables.delete(cte);
      tables.delete(cte.toLowerCase());
    }

    hasOrderBy = Boolean(node.orderby);
  } else {
    // Oracle fallback: node-sql-parser could not parse it. Extract table names
    // conservatively and require that every reference is allowlisted.
    if (!/^\s*(select|with)\b/i.test(stripped)) {
      return refusal('not_select', 'Only SELECT statements are allowed.', false);
    }
    tables = new Set<string>();
    const regex = /\b(?:from|join)\s+([a-z0-9_$#."]+)/gi;
    let match: RegExpExecArray | null;
    while ((match = regex.exec(stripped)) !== null) {
      const name = match[1]!.replaceAll('"', '');
      if (name.toLowerCase() === 'select') continue;
      tables.add(name);
    }
    hasOrderBy = /\border\s+by\b/i.test(stripped);

    if (tables.size === 0) {
      return refusal(
        'parse_error',
        'The statement could not be verified against the catalog.',
        true,
      );
    }
  }

  const resolved: TableMeta[] = [];
  for (const table of tables) {
    const meta = index.get(normalize(table, request.dialect)) ?? findTable(table, request.catalog);
    if (!meta) {
      return refusal('unknown_table', `Table is not in the allowlist: ${table}.`, true);
    }
    resolved.push(meta);
  }

  // Wildcard projection over a table containing PII would leak the column.
  const piiColumns = new Set<string>();
  for (const table of resolved) {
    for (const column of table.piiColumns) piiColumns.add(column.toLowerCase());
  }

  if (validation === 'ast' && ast) {
    let selectsWildcard = false;
    walk(ast, (node) => {
      if (columnName(node) === '*') selectsWildcard = true;
      if (node.type === 'star') selectsWildcard = true;
      if (isNode(node.column) && node.column.value === '*') selectsWildcard = true;
    });

    if (selectsWildcard && piiColumns.size > 0) {
      return refusal(
        'wildcard_pii',
        `SELECT * would expose protected columns (${[...piiColumns].join(', ')}). Select explicit columns.`,
        true,
      );
    }

    for (const node of walkColumns(ast)) {
      if (piiColumns.has(node.toLowerCase())) {
        return refusal('pii_column', `Column is protected: ${node}.`, false);
      }
    }
  } else if (/\bselect\s+\*/i.test(stripped) && piiColumns.size > 0) {
    return refusal(
      'wildcard_pii',
      `SELECT * would expose protected columns (${[...piiColumns].join(', ')}).`,
      true,
    );
  }

  const tenantScoped = resolved.filter((table) => table.tenantScoped);
  if (tenantScoped.length > 0) {
    const satisfied =
      validation === 'ast' && ast
        ? tenantPredicatePresent(ast, request.tenantId)
        : // `stripped` has literals removed, so the lexical check must use
          // the original statement to see the tenant value.
          stripped.toLowerCase().includes('tenant_id') &&
          raw.includes(`'${request.tenantId}'`);

    if (!satisfied) {
      return refusal(
        'missing_tenant_predicate',
        `Tenant-scoped tables require tenant_id = '${request.tenantId}': ${tenantScoped
          .map((table) => table.name)
          .join(', ')}.`,
        false,
      );
    }
  }

  return {
    ok: true,
    sql: raw,
    tables: resolved.map((table) => table.name),
    validation,
    hasOrderBy,
  };
}

function walkColumns(ast: unknown): string[] {
  const columns: string[] = [];
  walk(ast, (node) => {
    const name = columnName(node);
    if (name && name !== '*') columns.push(name);
    // Column refs are sometimes nested under `column` as an object.
    if (node.type === 'column_ref' && isNode(node.column)) {
      const inner = node.column;
      if (typeof inner.value === 'string') columns.push(inner.value);
    }
  });
  return columns;
}
