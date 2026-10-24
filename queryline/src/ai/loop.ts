import { SpanStatusCode, trace, type Span } from '@opentelemetry/api';
import { z } from 'zod';
import { checkAdmission, DEFAULT_ADMISSION, type AdmissionPolicy } from '../admission.js';
import { validateSql } from '../guard.js';
import type {
  AnswerResult,
  ChartSpec,
  Page,
  RefusalReason,
  ResultSet,
  SchemaCatalog,
  Usage,
  WarehouseAdapter,
} from '../types.js';
import type { CompletionRequest, ModelClient, ModelMessage } from './model.js';
import { renderCatalog, retrieveContext, type FewShot } from './retrieve.js';

const tracer = trace.getTracer('queryline');

const ChartSchema = z.object({
  type: z.enum(['bar', 'line', 'table', 'number']),
  x: z.string().nullable().default(null),
  y: z.array(z.string()).default([]),
});

const ModelOutput = z.object({
  kind: z.enum(['sql', 'refusal']),
  sql: z.string().nullable().optional(),
  explanation: z.string().nullable().optional(),
  chart: ChartSchema.nullable().optional(),
  confidence: z.number().min(0).max(1).optional(),
  refusal: z
    .object({ reason: z.string(), detail: z.string() })
    .nullable()
    .optional(),
});

export interface AskOptions {
  question: string;
  tenantId: string;
  catalog: SchemaCatalog;
  adapter: WarehouseAdapter;
  model: ModelClient;
  page?: Page;
  policy?: AdmissionPolicy;
  maxRepairs?: number;
  maxRows?: number;
  maxSqlLength?: number;
  timeoutMs?: number;
  explainTimeoutMs?: number;
  fewShots?: FewShot[];
  maxCostUsd?: number;
}

const SYSTEM_RULES = `You are Queryline, an analytics copilot.
You translate one business question into exactly one read-only SQL SELECT statement.

Hard rules:
- Return ONE statement. SELECT or WITH only, never DML or DDL.
- Use only the tables and columns listed in the catalog.
- Never project protected columns. Never use SELECT * on a table with protected columns.
- Tables marked tenant-scoped must be filtered: <table>.tenant_id = '<tenant>'.
- Do not add a trailing semicolon. The runtime wraps your query to cap rows.
- If the question is ambiguous, asks for protected data, or cannot be answered from
  the catalog, return a refusal instead of guessing.

Respond with JSON only, no prose:
{
  "kind": "sql" | "refusal",
  "sql": string | null,
  "explanation": string,
  "chart": { "type": "bar"|"line"|"table"|"number", "x": string|null, "y": string[] } | null,
  "confidence": number,
  "refusal": { "reason": "pii"|"out_of_scope"|"ambiguous", "detail": string } | null
}`;

function systemPrompt(options: AskOptions, catalogText: string, pii: string[]): string {
  const dialect = options.adapter.kind;
  return [
    SYSTEM_RULES,
    `Dialect: ${dialect}`,
    `Tenant: ${options.tenantId}`,
    `Protected columns: ${pii.length > 0 ? pii.join(', ') : 'none'}`,
    `Catalog:\n${catalogText}`,
  ].join('\n\n');
}

function initialMessages(
  options: AskOptions,
  catalogText: string,
  pii: string[],
  fewShots: FewShot[],
): ModelMessage[] {
  const messages: ModelMessage[] = [
    { role: 'system', content: systemPrompt(options, catalogText, pii) },
  ];

  for (const shot of fewShots) {
    messages.push({ role: 'user', content: shot.question });
    messages.push({
      role: 'assistant',
      content: JSON.stringify({
        kind: 'sql',
        sql: shot.sql,
        explanation: 'Verified example.',
        chart: null,
        confidence: 1,
        refusal: null,
      }),
    });
  }

  messages.push({ role: 'user', content: options.question });
  return messages;
}

function parseModelOutput(text: string): z.infer<typeof ModelOutput> | null {
  const cleaned = text
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '')
    .trim();

  try {
    const parsed = ModelOutput.safeParse(JSON.parse(cleaned));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

function refusal(
  reason: RefusalReason,
  detail: string,
  extra: Partial<AnswerResult> = {},
): AnswerResult {
  return {
    outcome: 'refused',
    sql: null,
    explanation: null,
    columns: [],
    rows: [],
    truncated: false,
    chart: null,
    refusal: { reason, detail },
    degraded: [],
    repairAttempts: 0,
    validation: null,
    usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
    latencyMs: 0,
    ...extra,
  };
}

async function withSpan<T>(
  name: string,
  attributes: Record<string, string | number | boolean>,
  fn: (span: Span) => Promise<T>,
): Promise<T> {
  return tracer.startActiveSpan(name, async (span) => {
    span.setAttributes(attributes);
    try {
      return await fn(span);
    } catch (error) {
      span.recordException(error instanceof Error ? error : String(error));
      span.setStatus({ code: SpanStatusCode.ERROR });
      throw error;
    } finally {
      span.end();
    }
  });
}

function isTransient(error: unknown): boolean {
  const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  if (
    /statement timeout|canceling statement due to statement timeout|callTimeout|ORA-01013|timeout expired/i.test(
      message,
    )
  ) {
    return false;
  }
  return /deadlock|ORA-00060|40001|40P01|ECONNRESET|ECONNREFUSED|socket hang up|server closed|connection terminated|08S01|TDS/i.test(
    message,
  );
}

async function executeWithRetry(
  adapter: WarehouseAdapter,
  sql: string,
  options: { limit: number; offset: number; timeoutMs: number },
): Promise<ResultSet> {
  let lastError: unknown;

  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await adapter.execute(sql, options);
    } catch (error) {
      lastError = error;
      if (!isTransient(error) || attempt === 2) throw error;
      await new Promise((resolve) => setTimeout(resolve, 100 * 3 ** attempt));
    }
  }

  throw lastError ?? new Error('Query execution failed');
}

function addUsage(total: Usage, delta: Usage): Usage {
  return {
    inputTokens: total.inputTokens + delta.inputTokens,
    outputTokens: total.outputTokens + delta.outputTokens,
    costUsd: Number((total.costUsd + delta.costUsd).toFixed(6)),
  };
}

export async function ask(options: AskOptions): Promise<AnswerResult> {
  const started = Date.now();
  const page: Page = options.page ?? { limit: options.maxRows ?? 1000, offset: 0 };
  const policy = options.policy ?? DEFAULT_ADMISSION;
  const maxRepairs = options.maxRepairs ?? 2;
  const maxCostUsd = options.maxCostUsd ?? 0.05;

  const context = retrieveContext(options.question, options.catalog, options.fewShots ?? []);
  const catalogText = renderCatalog(context.tables);
  const messages = initialMessages(options, catalogText, context.piiColumns, context.fewShots);

  let usage: Usage = { inputTokens: 0, outputTokens: 0, costUsd: 0 };
  let repairs = 0;
  let lastError = '';
  let lastReason: RefusalReason = 'execution_error';
  const degraded: string[] = [];

  for (let attempt = 0; attempt <= maxRepairs; attempt += 1) {
    const request: CompletionRequest = {
      messages,
      temperature: 0,
      maxTokens: 900,
      json: true,
    };

    const completion = await withSpan(
      'sql.generate',
      {
        'llm.model': options.model.model,
        'llm.attempt': attempt,
        'question.length': options.question.length,
        'catalog.tables': context.tables.length,
      },
      () => options.model.complete(request),
    );

    usage = addUsage(usage, completion.usage);

    if (usage.costUsd > maxCostUsd) {
      return refusal('budget_exceeded', `Per-question cost budget of $${maxCostUsd} exceeded.`, {
        usage,
        repairAttempts: repairs,
        latencyMs: Date.now() - started,
      });
    }

    const parsed = parseModelOutput(completion.text);

    if (!parsed) {
      lastReason = 'parse_error';
      lastError = 'Response was not valid JSON matching the required shape.';
      messages.push({ role: 'assistant', content: completion.text });
      messages.push({
        role: 'user',
        content: `${lastError} Return corrected JSON only.`,
      });
      repairs += 1;
      continue;
    }

    if (parsed.kind === 'refusal') {
      return {
        ...refusal('model_refusal', parsed.refusal?.detail ?? 'The question cannot be answered.'),
        usage,
        repairAttempts: repairs,
        latencyMs: Date.now() - started,
      };
    }

    const sql = parsed.sql?.trim();
    if (!sql) {
      lastError = 'The response contained no SQL.';
      messages.push({ role: 'assistant', content: completion.text });
      messages.push({ role: 'user', content: `${lastError} Provide SQL or a refusal.` });
      repairs += 1;
      continue;
    }

    const guard = await withSpan(
      'sql.validate',
      { 'sql.length': sql.length, dialect: options.adapter.kind },
      async () => validateSql({
        sql,
        dialect: options.adapter.kind,
        catalog: options.catalog,
        tenantId: options.tenantId,
        maxSqlLength: options.maxSqlLength,
      }),
    );

    if (!guard.ok) {
      if (!guard.repairable) {
        return {
          ...refusal(guard.reason, guard.detail),
          usage,
          repairAttempts: repairs,
          latencyMs: Date.now() - started,
        };
      }

      lastReason = guard.reason;
      lastError = `${guard.reason}: ${guard.detail}`;
      messages.push({ role: 'assistant', content: completion.text });
      messages.push({
        role: 'user',
        content: `The SQL was rejected before execution. ${lastError} Return corrected JSON only.`,
      });
      repairs += 1;
      continue;
    }

    if (page.offset > 0 && !guard.hasOrderBy) {
      lastReason = 'pagination_requires_order_by';
      lastError = 'Pagination past the first page requires an ORDER BY in the statement.';
      messages.push({ role: 'assistant', content: completion.text });
      messages.push({ role: 'user', content: `${lastError} Return corrected JSON only.` });
      repairs += 1;
      continue;
    }

    if (guard.validation === 'lexical') degraded.push('lexical_validation');

    const admission = await withSpan(
      'sql.admission',
      { dialect: options.adapter.kind, 'tables.count': guard.tables.length },
      () => checkAdmission(
        options.adapter,
        guard.sql,
        policy,
        options.explainTimeoutMs ?? 2000,
      ),
    );

    if (!admission.admitted) {
      lastReason = 'admission_rejected';
      lastError = admission.reason ?? 'Query rejected by admission control.';
      messages.push({ role: 'assistant', content: completion.text });
      messages.push({
        role: 'user',
        content: `The query was rejected before execution: ${lastError} Propose a cheaper, narrower query. Return corrected JSON only.`,
      });
      repairs += 1;
      continue;
    }

    if (admission.estimate.source === 'unverified') degraded.push('admission_unverified');

    try {
      const result = await withSpan(
        'sql.execute',
        {
          dialect: options.adapter.kind,
          'tenant.id': options.tenantId,
          'tables.count': guard.tables.length,
          'page.limit': page.limit,
          'page.offset': page.offset,
        },
        () => executeWithRetry(options.adapter, guard.sql, {
          limit: page.limit,
          offset: page.offset,
          timeoutMs: options.timeoutMs ?? 8000,
        }),
      );

      const chart: ChartSpec | null = parsed.chart ?? null;

      return {
        outcome: 'answered',
        sql: guard.sql,
        explanation: parsed.explanation ?? null,
        columns: result.columns,
        rows: result.rows,
        truncated: result.truncated,
        chart,
        refusal: null,
        degraded,
        repairAttempts: repairs,
        validation: guard.validation,
        usage,
        latencyMs: Date.now() - started,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      lastReason = 'execution_error';
      lastError = message;
      messages.push({ role: 'assistant', content: completion.text });
      messages.push({
        role: 'user',
        content: `The query failed at execution: ${message}. Fix the SQL. Return corrected JSON only.`,
      });
      repairs += 1;
    }
  }

  return {
    ...refusal(lastReason, lastError || 'Unable to produce a valid query.'),
    usage,
    repairAttempts: repairs,
    latencyMs: Date.now() - started,
    degraded,
  };
}
