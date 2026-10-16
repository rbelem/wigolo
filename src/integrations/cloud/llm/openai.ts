import OpenAI from 'openai';
import type { LLMCallOpts, LLMExtractResult } from './types.js';

const DEFAULT_MODEL = 'gpt-4o-mini';

/** Extra headers for the OpenAI client (e.g. Zen gateway session routing).
 * Parsed from WIGOLO_OPENAI_EXTRA_HEADERS as a JSON object; defaults to {}.
 */
export function openAIExtraHeaders(): Record<string, string> {
  const raw = process.env.WIGOLO_OPENAI_EXTRA_HEADERS;
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, string>;
    }
  } catch {
    // Tolerate malformed JSON — fall through to {}.
  }
  return {};
}

export async function callOpenAI(
  opts: LLMCallOpts,
  apiKey: string,
): Promise<LLMExtractResult> {
  const client = new OpenAI({ apiKey, defaultHeaders: openAIExtraHeaders() });
  const model = opts.modelOverride ?? DEFAULT_MODEL;
  const start = Date.now();

  const response = await client.chat.completions.create(
    {
      model,
      messages: [{ role: 'user', content: opts.prompt }],
      response_format: {
        type: 'json_schema',
        json_schema: {
          name: 'extract',
          schema: opts.jsonSchema,
          strict: true,
        },
      },
    },
    { signal: opts.signal },
  );

  const content = response.choices?.[0]?.message?.content;
  if (!content) {
    throw new Error('openai: empty content in response');
  }

  let values: Record<string, unknown>;
  try {
    values = JSON.parse(content);
  } catch (e) {
    throw new Error(`openai: invalid JSON in response: ${(e as Error).message}`);
  }

  return {
    values,
    provider: 'openai',
    model: response.model ?? model,
    cached: false,
    latencyMs: Date.now() - start,
  };
}
