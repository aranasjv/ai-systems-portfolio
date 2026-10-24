import type { WarehouseKind, WarehouseConnectionConfig } from './types.js';

export interface ModelConfig {
  provider: 'openai' | 'mock';
  name: string;
  baseUrl: string;
  apiKey: string;
  inputPricePerMillion: number;
  outputPricePerMillion: number;
}

export interface LimitConfig {
  maxRows: number;
  maxEstimatedRows: number;
  maxEstimatedCost: number;
  maxSqlLength: number;
  queryTimeoutMs: number;
  explainTimeoutMs: number;
  maxRepairs: number;
}

export interface BackpressureConfig {
  queueDepthLimit: number;
  tenantConcurrency: number;
  globalConcurrency: number;
}

export interface AppConfig {
  databaseUrl: string | null;
  redisUrl: string;
  warehouse: WarehouseConnectionConfig;
  tenantId: string;
  model: ModelConfig;
  limits: LimitConfig;
  backpressure: BackpressureConfig;
  port: number;
  logLevel: string;
  otelEnabled: boolean;
  evalCassetteDir: string;
}

function num(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function bool(value: string | undefined, fallback = false): boolean {
  if (value === undefined) return fallback;
  return value === '1' || value.toLowerCase() === 'true';
}

function warehouseKind(value: string | undefined): WarehouseKind {
  if (value === 'mssql' || value === 'oracle' || value === 'postgres') return value;
  return 'postgres';
}

function defaultPort(kind: WarehouseKind): number {
  switch (kind) {
    case 'mssql':
      return 1433;
    case 'oracle':
      return 1521;
    default:
      return 5432;
  }
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  // Node 22+ can load .env natively; no dotenv dependency.
  if (env === process.env && typeof process.loadEnvFile === 'function') {
    try {
      process.loadEnvFile();
    } catch {
      // no .env file in cwd; environment variables are authoritative
    }
  }

  const kind = warehouseKind(env.WAREHOUSE_KIND);

  return {
    databaseUrl: env.DATABASE_URL ?? null,
    redisUrl: env.REDIS_URL ?? 'redis://localhost:6379',
    tenantId: env.TENANT_ID ?? 'demo-tenant',
    warehouse: {
      kind,
      host: env.WAREHOUSE_HOST ?? 'localhost',
      port: num(env.WAREHOUSE_PORT, defaultPort(kind)),
      user: env.WAREHOUSE_USER ?? 'queryline_reader',
      password: env.WAREHOUSE_PASSWORD ?? 'queryline_reader',
      database: env.WAREHOUSE_DATABASE ?? 'queryline',
      schema: env.WAREHOUSE_SCHEMA ?? undefined,
      serviceName: env.WAREHOUSE_SERVICE_NAME ?? undefined,
      ssl: bool(env.WAREHOUSE_SSL),
      encrypt: bool(env.WAREHOUSE_ENCRYPT, false),
      trustServerCertificate: bool(env.WAREHOUSE_TRUST_SERVER_CERTIFICATE, true),
    },
    model: {
      provider: env.MODEL_PROVIDER === 'openai' ? 'openai' : 'mock',
      name: env.MODEL_NAME ?? 'gpt-4o-mini',
      baseUrl: env.MODEL_BASE_URL ?? 'https://api.openai.com/v1',
      apiKey: env.MODEL_API_KEY ?? '',
      inputPricePerMillion: num(env.MODEL_INPUT_PRICE, 0.15),
      outputPricePerMillion: num(env.MODEL_OUTPUT_PRICE, 0.6),
    },
    limits: {
      maxRows: num(env.MAX_ROWS, 1000),
      maxEstimatedRows: num(env.MAX_ESTIMATED_ROWS, 5_000_000),
      maxEstimatedCost: num(env.MAX_ESTIMATED_COST, 250_000),
      maxSqlLength: num(env.MAX_SQL_LENGTH, 20_000),
      queryTimeoutMs: num(env.QUERY_TIMEOUT_MS, 8_000),
      explainTimeoutMs: num(env.EXPLAIN_TIMEOUT_MS, 2_000),
      maxRepairs: num(env.MAX_REPAIRS, 2),
    },
    backpressure: {
      queueDepthLimit: num(env.QUEUE_DEPTH_LIMIT, 200),
      tenantConcurrency: num(env.TENANT_CONCURRENCY, 3),
      globalConcurrency: num(env.GLOBAL_CONCURRENCY, 12),
    },
    port: num(env.PORT, 3000),
    logLevel: env.LOG_LEVEL ?? 'info',
    otelEnabled: bool(env.OTEL_ENABLED, false),
    evalCassetteDir: env.EVAL_CASSETTE_DIR ?? 'evals/cassettes',
  };
}
