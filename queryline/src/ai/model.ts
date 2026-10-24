import type { ModelConfig } from '../config.js';
import type { Usage } from '../types.js';

export interface ModelMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface CompletionRequest {
  messages: ModelMessage[];
  temperature?: number;
  maxTokens?: number;
  json?: boolean;
}

export interface CompletionResponse {
  text: string;
  model: string;
  usage: Usage;
}

export interface ModelClient {
  readonly model: string;
  complete(request: CompletionRequest): Promise<CompletionResponse>;
}

export function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

export function priceUsage(config: ModelConfig, inputTokens: number, outputTokens: number): Usage {
  const costUsd =
    (inputTokens / 1_000_000) * config.inputPricePerMillion +
    (outputTokens / 1_000_000) * config.outputPricePerMillion;
  return { inputTokens, outputTokens, costUsd: Number(costUsd.toFixed(6)) };
}

export class MockModelClient implements ModelClient {
  readonly model = 'mock';

  constructor(
    private readonly responder: (request: CompletionRequest) => string | Promise<string>,
    private readonly config?: ModelConfig,
  ) {}

  async complete(request: CompletionRequest): Promise<CompletionResponse> {
    const text = await this.responder(request);
    const inputTokens = estimateTokens(request.messages.map((message) => message.content).join('\n'));
    const outputTokens = estimateTokens(text);
    return {
      text,
      model: this.model,
      usage: this.config ? priceUsage(this.config, inputTokens, outputTokens) : {
        inputTokens,
        outputTokens,
        costUsd: 0,
      },
    };
  }
}

const TRANSIENT_STATUS = new Set([408, 409, 425, 429, 500, 502, 503, 504]);

export class OpenAIModelClient implements ModelClient {
  readonly model: string;

  constructor(private readonly config: ModelConfig) {
    this.model = config.name;
  }

  async complete(request: CompletionRequest): Promise<CompletionResponse> {
    if (!this.config.apiKey) {
      throw new Error('MODEL_API_KEY is required when MODEL_PROVIDER=openai');
    }

    const payload = {
      model: this.model,
      messages: request.messages,
      temperature: request.temperature ?? 0,
      max_tokens: request.maxTokens ?? 900,
      ...(request.json ? { response_format: { type: 'json_object' } } : {}),
    };

    let lastError: Error | null = null;

    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const response = await fetch(`${this.config.baseUrl.replace(/\/$/, '')}/chat/completions`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${this.config.apiKey}`,
          },
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(30_000),
        });

        if (!response.ok) {
          const body = await response.text();
          const retryable = TRANSIENT_STATUS.has(response.status);
          const error = new Error(`Model returned ${response.status}: ${body.slice(0, 400)}`);
          if (!retryable || attempt === 2) throw error;
          lastError = error;
          await sleep(backoff(attempt, response.headers.get('retry-after')));
          continue;
        }

        const data = (await response.json()) as {
          choices?: { message?: { content?: string } }[];
          usage?: { prompt_tokens?: number; completion_tokens?: number };
        };

        const text = data.choices?.[0]?.message?.content ?? '';
        const inputTokens = data.usage?.prompt_tokens ?? estimateTokens(
          request.messages.map((message) => message.content).join('\n'),
        );
        const outputTokens = data.usage?.completion_tokens ?? estimateTokens(text);

        return {
          text,
          model: this.model,
          usage: priceUsage(this.config, inputTokens, outputTokens),
        };
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        if (attempt === 2) throw lastError;
        await sleep(backoff(attempt, null));
      }
    }

    throw lastError ?? new Error('Model call failed');
  }
}

function backoff(attempt: number, retryAfter: string | null): number {
  const header = Number(retryAfter);
  if (Number.isFinite(header) && header > 0) return Math.min(header * 1000, 10_000);
  const base = 250 * 2 ** attempt;
  return Math.round(base + Math.random() * base);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function createModelClient(config: ModelConfig): ModelClient {
  if (config.provider === 'openai') return new OpenAIModelClient(config);

  return new MockModelClient(
    () =>
      JSON.stringify({
        kind: 'refusal',
        sql: null,
        explanation: 'Mock model provider is active. Set MODEL_PROVIDER=openai for real generation.',
        chart: null,
        confidence: 0,
        refusal: { reason: 'out_of_scope', detail: 'No model provider configured.' },
      }),
    config,
  );
}
