import { describe, expect, it } from 'vitest';
import { dialectFor, statementId } from '../src/dialect.js';

describe('identifier handling', () => {
  it('quotes and folds per dialect', () => {
    expect(dialectFor('postgres').quoteIdentifier('order')).toBe('"order"');
    expect(dialectFor('mssql').quoteIdentifier('order')).toBe('[order]');
    expect(dialectFor('oracle').quoteIdentifier('order')).toBe('"order"');
  });

  it('escapes the quote character', () => {
    expect(dialectFor('postgres').quoteIdentifier('we"ird')).toBe('"we""ird"');
    expect(dialectFor('mssql').quoteIdentifier('we]ird')).toBe('[we]]ird]');
  });

  it('folds identifiers the way each engine does', () => {
    expect(dialectFor('postgres').foldIdentifier('Orders')).toBe('orders');
    expect(dialectFor('oracle').foldIdentifier('Orders')).toBe('ORDERS');
    expect(dialectFor('mssql').foldIdentifier('Orders')).toBe('Orders');
  });
});

describe('pagination wrappers', () => {
  const sql = 'SELECT id FROM orders WHERE tenant_id = 1';

  it('uses LIMIT/OFFSET for Postgres', () => {
    expect(dialectFor('postgres').pageSql(sql, { limit: 50, offset: 100 })).toContain(
      'LIMIT 50 OFFSET 100',
    );
  });

  it('adds ORDER BY (SELECT NULL) for SQL Server OFFSET', () => {
    const wrapped = dialectFor('mssql').pageSql(sql, { limit: 50, offset: 100 });
    expect(wrapped).toContain('ORDER BY (SELECT NULL)');
    expect(wrapped).toContain('OFFSET 100 ROWS FETCH NEXT 50 ROWS ONLY');
  });

  it('uses OFFSET/FETCH for Oracle 12c+', () => {
    expect(dialectFor('oracle').pageSql(sql, { limit: 50, offset: 100 })).toContain(
      'OFFSET 100 ROWS FETCH NEXT 50 ROWS ONLY',
    );
  });

  it('always wraps the user query as a subquery', () => {
    for (const kind of ['postgres', 'mssql', 'oracle'] as const) {
      const wrapped = dialectFor(kind).pageSql(sql, { limit: 10, offset: 0 });
      expect(wrapped.startsWith('SELECT * FROM (')).toBe(true);
    }
  });
});

describe('plan statements', () => {
  it('explains in Postgres with EXPLAIN JSON', () => {
    expect(dialectFor('postgres').explainSql('SELECT 1', 'x')[0]).toBe(
      'EXPLAIN (FORMAT JSON) SELECT 1',
    );
  });

  it('has no inline explain for SQL Server (adapter uses SHOWPLAN_XML)', () => {
    expect(dialectFor('mssql').explainSql('SELECT 1', 'x')).toEqual([]);
  });

  it('explains in Oracle with a sanitized statement id', () => {
    const statement = dialectFor('oracle').explainSql('SELECT 1', "x'; DROP TABLE t; --")[0];
    expect(statement).toContain('EXPLAIN PLAN SET STATEMENT_ID =');
    expect(statement).not.toContain('DROP TABLE');
  });

  it('generates compact statement ids', () => {
    expect(statementId('QL')).toMatch(/^QL_[a-z0-9_]+$/);
    expect(statementId('QL').length).toBeLessThanOrEqual(30);
  });
});
