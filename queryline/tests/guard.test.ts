import { describe, expect, it } from 'vitest';
import { validateSql } from '../src/guard.js';
import type { SchemaCatalog } from '../src/types.js';

const catalog: SchemaCatalog = {
  kind: 'postgres',
  tables: [
    {
      schema: 'warehouse',
      name: 'orders',
      columns: [
        { name: 'id', dataType: 'bigint', nullable: false },
        { name: 'tenant_id', dataType: 'text', nullable: false },
        { name: 'customer_id', dataType: 'bigint', nullable: false },
        { name: 'total_cents', dataType: 'bigint', nullable: false },
        { name: 'ordered_at', dataType: 'timestamptz', nullable: false },
      ],
      tenantScoped: true,
      piiColumns: [],
    },
    {
      schema: 'warehouse',
      name: 'customers',
      columns: [
        { name: 'id', dataType: 'bigint', nullable: false },
        { name: 'tenant_id', dataType: 'text', nullable: false },
        { name: 'name', dataType: 'text', nullable: false },
        { name: 'email', dataType: 'text', nullable: false },
        { name: 'phone', dataType: 'text', nullable: true },
      ],
      tenantScoped: true,
      piiColumns: ['email', 'phone'],
    },
    {
      schema: 'warehouse',
      name: 'products',
      columns: [
        { name: 'id', dataType: 'bigint', nullable: false },
        { name: 'tenant_id', dataType: 'text', nullable: false },
        { name: 'name', dataType: 'text', nullable: false },
        { name: 'price_cents', dataType: 'bigint', nullable: false },
      ],
      tenantScoped: true,
      piiColumns: [],
    },
  ],
};

function check(sql: string, overrides: Partial<Parameters<typeof validateSql>[0]> = {}) {
  return validateSql({
    sql,
    dialect: 'postgres',
    catalog,
    tenantId: 'demo-tenant',
    ...overrides,
  });
}

describe('validateSql: allow path', () => {
  it('accepts a tenant-filtered select', () => {
    const result = check(
      `SELECT id, total_cents FROM warehouse.orders WHERE tenant_id = 'demo-tenant'`,
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.tables).toEqual(['orders']);
      expect(result.validation).toBe('ast');
      expect(result.hasOrderBy).toBe(false);
    }
  });

  it('tracks ORDER BY for pagination', () => {
    const result = check(
      `SELECT id FROM warehouse.orders WHERE tenant_id = 'demo-tenant' ORDER BY ordered_at DESC`,
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.hasOrderBy).toBe(true);
  });

  it('ignores forbidden words inside string literals', () => {
    const result = check(
      `SELECT 'drop table orders' AS note, id FROM warehouse.orders WHERE tenant_id = 'demo-tenant'`,
    );
    expect(result.ok).toBe(true);
  });

  it('resolves tables inside a CTE', () => {
    const result = check(
      `WITH recent AS (SELECT id, total_cents FROM warehouse.orders WHERE tenant_id = 'demo-tenant' AND ordered_at > CURRENT_DATE - INTERVAL '7 days')
       SELECT SUM(total_cents) AS revenue FROM recent`,
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.tables).toEqual(['orders']);
  });

  it('resolves tables inside a subquery', () => {
    const result = check(
      `SELECT COUNT(*) FROM (SELECT id FROM warehouse.orders WHERE tenant_id = 'demo-tenant') inner_q`,
    );
    expect(result.ok).toBe(true);
  });

  it('allows SELECT * when the table has no protected columns', () => {
    const result = check(
      `SELECT * FROM warehouse.products WHERE tenant_id = 'demo-tenant'`,
    );
    expect(result.ok).toBe(true);
  });
});

describe('validateSql: refusal path', () => {
  it('rejects DML', () => {
    const result = check(`DELETE FROM warehouse.orders WHERE id = 1`);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('forbidden_keyword');
      expect(result.repairable).toBe(false);
    }
  });

  it('rejects DDL hidden behind a CTE-looking prefix', () => {
    const result = check(`WITH x AS (SELECT 1) DROP TABLE warehouse.orders`);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.repairable).toBe(false);
  });

  it('rejects multiple statements', () => {
    const result = check(
      `SELECT id FROM warehouse.orders WHERE tenant_id = 'demo-tenant'; SELECT 1`,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('multiple_statements');
  });

  it('rejects unknown tables', () => {
    const result = check(`SELECT id FROM warehouse.secrets WHERE tenant_id = 'demo-tenant'`);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('unknown_table');
      expect(result.repairable).toBe(true);
    }
  });

  it('rejects explicit protected columns', () => {
    const result = check(
      `SELECT email FROM warehouse.customers WHERE tenant_id = 'demo-tenant'`,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('pii_column');
  });

  it('rejects SELECT * over a table with protected columns', () => {
    const result = check(`SELECT * FROM warehouse.customers WHERE tenant_id = 'demo-tenant'`);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('wildcard_pii');
      expect(result.repairable).toBe(true);
    }
  });

  it('requires the tenant predicate on tenant-scoped tables', () => {
    const result = check(`SELECT id FROM warehouse.orders`);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('missing_tenant_predicate');
  });

  it('rejects a tenant predicate for a different tenant', () => {
    const result = check(
      `SELECT id FROM warehouse.orders WHERE tenant_id = 'other-tenant'`,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('missing_tenant_predicate');
  });

  it('rejects locking reads', () => {
    const result = check(
      `SELECT id FROM warehouse.orders WHERE tenant_id = 'demo-tenant' FOR UPDATE`,
    );
    expect(result.ok).toBe(false);
  });

  it('rejects oversized statements', () => {
    const result = check(`SELECT id FROM warehouse.orders WHERE tenant_id = 'demo-tenant'`, {
      maxSqlLength: 10,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('too_long');
  });
});

describe('validateSql: dialect specifics', () => {
  it('parses T-SQL TOP as a select', () => {
    const result = check(
      `SELECT TOP (5) id FROM warehouse.orders WHERE tenant_id = 'demo-tenant'`,
      { dialect: 'mssql' },
    );
    expect(result.ok).toBe(true);
  });

  it('falls back to lexical validation when the Oracle statement cannot be parsed', () => {
    const result = check(
      `SELECT id FROM orders WHERE tenant_id = 'demo-tenant' CONNECT BY PRIOR id = customer_id`,
      { dialect: 'oracle' },
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.validation).toBe('lexical');
      expect(result.tables).toEqual(['orders']);
    }
  });

  it('still enforces the tenant rule in lexical mode', () => {
    const result = check(`SELECT id FROM orders CONNECT BY PRIOR id = customer_id`, {
      dialect: 'oracle',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('missing_tenant_predicate');
  });
});
