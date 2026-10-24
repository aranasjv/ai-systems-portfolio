import type { WarehouseAdapter, WarehouseConnectionConfig } from '../types.js';
import { MssqlAdapter } from './mssql.js';
import { OracleAdapter } from './oracle.js';
import { PostgresAdapter } from './postgres.js';

export { MssqlAdapter, OracleAdapter, PostgresAdapter };

export function createWarehouseAdapter(config: WarehouseConnectionConfig): WarehouseAdapter {
  switch (config.kind) {
    case 'postgres':
      return new PostgresAdapter(config);
    case 'mssql':
      return new MssqlAdapter(config);
    case 'oracle':
      return new OracleAdapter(config);
    default: {
      const exhaustive: never = config.kind;
      throw new Error(`Unsupported warehouse kind: ${String(exhaustive)}`);
    }
  }
}
