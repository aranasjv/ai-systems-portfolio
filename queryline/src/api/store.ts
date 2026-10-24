import pg from 'pg';
import type { AnswerResult } from '../types.js';

export type QueryStatus = 'queued' | 'running' | 'succeeded' | 'refused' | 'failed';

export interface QueryRecord {
  id: string;
  tenantId: string;
  question: string;
  status: QueryStatus;
  result: AnswerResult | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ListOptions {
  cursor: string | null;
  limit: number;
}

export interface ListResult {
  items: QueryRecord[];
  nextCursor: string | null;
}

export interface RowPage {
  columns: string[];
  rows: unknown[][];
  truncated: boolean;
}

export interface QueryStore {
  create(input: { id: string; tenantId: string; question: string }): Promise<QueryRecord>;
  get(id: string, tenantId: string): Promise<QueryRecord | null>;
  update(
    id: string,
    patch: { status?: QueryStatus; result?: AnswerResult | null; error?: string | null },
  ): Promise<QueryRecord | null>;
  list(tenantId: string, options: ListOptions): Promise<ListResult>;
  pageRows(id: string, tenantId: string, limit: number, offset: number): Promise<RowPage | null>;
}

function now(): string {
  return new Date().toISOString();
}

export class MemoryQueryStore implements QueryStore {
  private readonly records = new Map<string, QueryRecord>();

  async create(input: { id: string; tenantId: string; question: string }): Promise<QueryRecord> {
    const timestamp = now();
    const record: QueryRecord = {
      ...input,
      status: 'queued',
      result: null,
      error: null,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    this.records.set(record.id, record);
    return record;
  }

  async get(id: string, tenantId: string): Promise<QueryRecord | null> {
    const record = this.records.get(id);
    return record && record.tenantId === tenantId ? record : null;
  }

  async update(
    id: string,
    patch: { status?: QueryStatus; result?: AnswerResult | null; error?: string | null },
  ): Promise<QueryRecord | null> {
    const record = this.records.get(id);
    if (!record) return null;
    const updated = { ...record, ...patch, updatedAt: now() };
    this.records.set(id, updated);
    return updated;
  }

  async list(tenantId: string, options: ListOptions): Promise<ListResult> {
    const cursor = decodeCursor(options.cursor);
    const rows = [...this.records.values()]
      .filter((record) => record.tenantId === tenantId)
      .sort((a, b) => (a.createdAt === b.createdAt ? b.id.localeCompare(a.id) : b.createdAt.localeCompare(a.createdAt)))
      .filter((record) => {
        if (!cursor) return true;
        return (
          record.createdAt < cursor.createdAt ||
          (record.createdAt === cursor.createdAt && record.id < cursor.id)
        );
      });

    const items = rows.slice(0, options.limit);
    const last = items.at(-1);
    return {
      items,
      nextCursor: rows.length > options.limit && last ? encodeCursor(last) : null,
    };
  }

  async pageRows(
    id: string,
    tenantId: string,
    limit: number,
    offset: number,
  ): Promise<RowPage | null> {
    const record = await this.get(id, tenantId);
    if (!record?.result) return null;
    const rows = record.result.rows.slice(offset, offset + limit);
    return {
      columns: record.result.columns,
      rows,
      truncated: offset + limit < record.result.rows.length,
    };
  }
}

interface QueryRow {
  id: string;
  tenant_id: string;
  question: string;
  status: QueryStatus;
  result: AnswerResult | null;
  error: string | null;
  created_at: Date;
  updated_at: Date;
}

export class PgQueryStore implements QueryStore {
  constructor(private readonly pool: pg.Pool) {}

  private map(row: QueryRow): QueryRecord {
    return {
      id: row.id,
      tenantId: row.tenant_id,
      question: row.question,
      status: row.status,
      result: row.result,
      error: row.error,
      createdAt: row.created_at.toISOString(),
      updatedAt: row.updated_at.toISOString(),
    };
  }

  async create(input: { id: string; tenantId: string; question: string }): Promise<QueryRecord> {
    const result = await this.pool.query<QueryRow>(
      `INSERT INTO queries (id, tenant_id, question, status)
       VALUES ($1, $2, $3, 'queued')
       RETURNING *`,
      [input.id, input.tenantId, input.question],
    );
    return this.map(result.rows[0]!);
  }

  async get(id: string, tenantId: string): Promise<QueryRecord | null> {
    const result = await this.pool.query<QueryRow>(
      `SELECT * FROM queries WHERE id = $1 AND tenant_id = $2`,
      [id, tenantId],
    );
    const row = result.rows[0];
    return row ? this.map(row) : null;
  }

  async update(
    id: string,
    patch: { status?: QueryStatus; result?: AnswerResult | null; error?: string | null },
  ): Promise<QueryRecord | null> {
    const result = await this.pool.query<QueryRow>(
      `UPDATE queries
          SET status = COALESCE($2, status),
              result = COALESCE($3, result),
              error = COALESCE($4, error),
              updated_at = now()
        WHERE id = $1
        RETURNING *`,
      [id, patch.status ?? null, patch.result === undefined ? null : patch.result, patch.error ?? null],
    );
    const row = result.rows[0];
    return row ? this.map(row) : null;
  }

  async list(tenantId: string, options: ListOptions): Promise<ListResult> {
    const cursor = decodeCursor(options.cursor);
    const result = await this.pool.query<QueryRow>(
      `SELECT * FROM queries
        WHERE tenant_id = $1
          AND ($2::timestamptz IS NULL OR (created_at, id) < ($2, $3))
        ORDER BY created_at DESC, id DESC
        LIMIT $4`,
      [tenantId, cursor?.createdAt ?? null, cursor?.id ?? null, options.limit + 1],
    );

    const rows = result.rows.slice(0, options.limit).map((row) => this.map(row));
    const last = rows.at(-1);
    return {
      items: rows,
      nextCursor: result.rows.length > options.limit && last ? encodeCursor(last) : null,
    };
  }

  async pageRows(
    id: string,
    tenantId: string,
    limit: number,
    offset: number,
  ): Promise<RowPage | null> {
    const record = await this.get(id, tenantId);
    if (!record?.result) return null;
    const rows = record.result.rows.slice(offset, offset + limit);
    return {
      columns: record.result.columns,
      rows,
      truncated: offset + limit < record.result.rows.length,
    };
  }
}

function encodeCursor(record: QueryRecord): string {
  return Buffer.from(JSON.stringify({ createdAt: record.createdAt, id: record.id })).toString(
    'base64url',
  );
}

function decodeCursor(cursor: string | null): { createdAt: string; id: string } | null {
  if (!cursor) return null;
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as {
      createdAt?: unknown;
      id?: unknown;
    };
    if (typeof parsed.createdAt === 'string' && typeof parsed.id === 'string') {
      return { createdAt: parsed.createdAt, id: parsed.id };
    }
    return null;
  } catch {
    return null;
  }
}
