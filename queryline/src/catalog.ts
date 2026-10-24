import type { SchemaCatalog } from './types.js';

export interface CatalogPolicy {
  /** Tables that must always be filtered by tenant_id. */
  tenantScopedTables: string[];
  /** table name (or `*`) -> columns that must never leave the warehouse. */
  piiColumns: Record<string, string[]>;
}

export const DEFAULT_POLICY: CatalogPolicy = {
  tenantScopedTables: ['orders', 'order_items', 'customers'],
  piiColumns: {
    customers: ['email', 'phone', 'tax_id'],
    '*': ['password_hash', 'ssn'],
  },
};

/**
 * Attach governance metadata to an introspected catalog. Kept separate from
 * introspection so the same warehouse can be governed differently per tenant.
 */
export function applyCatalogPolicy(
  catalog: SchemaCatalog,
  policy: CatalogPolicy = DEFAULT_POLICY,
): SchemaCatalog {
  const tenantScoped = new Set(policy.tenantScopedTables.map((name) => name.toLowerCase()));
  const wildcard = policy.piiColumns['*'] ?? [];

  return {
    kind: catalog.kind,
    tables: catalog.tables.map((table) => {
      const named = policy.piiColumns[table.name] ?? [];
      const namedLower = policy.piiColumns[table.name.toLowerCase()] ?? [];
      const pii = [...new Set([...wildcard, ...named, ...namedLower])];
      return {
        ...table,
        tenantScoped: table.tenantScoped || tenantScoped.has(table.name.toLowerCase()),
        piiColumns: [...new Set([...table.piiColumns, ...pii])],
      };
    }),
  };
}
