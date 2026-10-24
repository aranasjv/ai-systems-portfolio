import { createRequire } from 'node:module';

export interface AstifyOptions {
  database?: string;
}

export interface SqlParser {
  astify(sql: string, options?: AstifyOptions): unknown;
  sqlify(ast: unknown): string;
}

/**
 * node-sql-parser is CommonJS and Node's ESM named-export detection does not
 * see `Parser`, so a plain `import { Parser }` works in Vitest but fails under
 * `node`/`tsx`. createRequire is the reliable path in both.
 */
const require = createRequire(import.meta.url);
const parserModule = require('node-sql-parser') as { Parser: new () => SqlParser };

export const sqlParser = new parserModule.Parser();
