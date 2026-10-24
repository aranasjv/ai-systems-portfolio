import type { SchemaCatalog, TableMeta } from '../types.js';

export interface FewShot {
  question: string;
  sql: string;
  schema: string;
}

export interface RetrievedContext {
  tables: TableMeta[];
  fewShots: FewShot[];
  piiColumns: string[];
}

const STOP_WORDS = new Set([
  'the',
  'a',
  'an',
  'of',
  'for',
  'to',
  'in',
  'on',
  'and',
  'or',
  'by',
  'with',
  'how',
  'many',
  'much',
  'what',
  'which',
  'show',
  'me',
  'give',
  'list',
  'per',
  'last',
  'this',
  'that',
  'are',
  'is',
  'was',
  'were',
  'total',
]);

export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, ' ')
    .split(/\s+/)
    .filter((token) => token.length > 1 && !STOP_WORDS.has(token));
}

function scoreTable(questionTokens: Set<string>, table: TableMeta): number {
  let score = 0;
  for (const token of tokenize(table.name)) {
    if (questionTokens.has(token)) score += 4;
  }
  for (const column of table.columns) {
    for (const token of tokenize(column.name)) {
      if (questionTokens.has(token)) score += 1;
    }
  }
  return score;
}

/**
 * Lexical retrieval keeps the demo deterministic and dependency-free. The
 * control-plane schema in sql/control-plane.sql has the pgvector tables for
 * swapping this for embedding retrieval without touching the loop.
 */
export function retrieveContext(
  question: string,
  catalog: SchemaCatalog,
  fewShots: FewShot[],
  options: { maxTables?: number; maxFewShots?: number; schema?: string } = {},
): RetrievedContext {
  const maxTables = options.maxTables ?? 6;
  const maxFewShots = options.maxFewShots ?? 4;
  const questionTokens = new Set(tokenize(question));

  const candidates = catalog.tables.filter(
    (table) => !options.schema || table.schema === options.schema,
  );

  const ranked = candidates
    .map((table) => ({ table, score: scoreTable(questionTokens, table) }))
    .sort((a, b) => b.score - a.score || a.table.name.localeCompare(b.table.name));

  const chosen = ranked.filter((entry) => entry.score > 0).slice(0, maxTables);
  const tables =
    chosen.length > 0
      ? chosen.map((entry) => entry.table)
      : ranked.slice(0, Math.min(3, ranked.length)).map((entry) => entry.table);

  const shots = fewShots
    .map((shot) => ({
      shot,
      score: jaccard(questionTokens, new Set(tokenize(shot.question))),
    }))
    .sort((a, b) => b.score - a.score || a.shot.question.localeCompare(b.shot.question))
    .filter((entry) => entry.score > 0 || fewShots.length <= maxFewShots)
    .slice(0, maxFewShots)
    .map((entry) => entry.shot);

  const piiColumns = [...new Set(tables.flatMap((table) => table.piiColumns))];

  return { tables, fewShots: shots, piiColumns };
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const item of a) if (b.has(item)) intersection += 1;
  return intersection / (a.size + b.size - intersection);
}

export function renderCatalog(tables: TableMeta[]): string {
  return tables
    .map((table) => {
      const columns = table.columns
        .map((column) => `${column.name} ${column.dataType}${column.nullable ? '' : ' NOT NULL'}`)
        .join(', ');
      const flags = [
        table.tenantScoped ? 'tenant-scoped' : null,
        table.piiColumns.length > 0 ? `protected: ${table.piiColumns.join(', ')}` : null,
      ]
        .filter(Boolean)
        .join('; ');
      return `- ${table.schema}.${table.name} (${columns})${flags ? ` [${flags}]` : ''}`;
    })
    .join('\n');
}
