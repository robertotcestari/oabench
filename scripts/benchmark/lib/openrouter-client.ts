import OpenAI from "openai";
import type { RunConfig, Question, InferenceRecord } from "./types.js";
import {
  buildDirectPrompt,
  buildDeliberativeInstructedPrompt,
  buildDeliberativeNativePrompt,
} from "./prompts.js";
import { parseResponse } from "./parser.js";

/**
 * Create an OpenAI client pointing to OpenRouter.
 */
export function createClient(): OpenAI {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    throw new Error(
      "OPENROUTER_API_KEY not set. Create a .env file or export it.",
    );
  }
  return new OpenAI({
    baseURL: "https://openrouter.ai/api/v1",
    apiKey,
    defaultHeaders: {
      "HTTP-Referer": "https://oabench.com.br",
      "X-Title": "OABench",
    },
  });
}

function buildPrompt(
  config: RunConfig,
  question: Question,
): { system: string; user: string } {
  if (config.protocol === "direto") {
    return buildDirectPrompt(question);
  }
  if (config.reasoningMode === "native") {
    return buildDeliberativeNativePrompt(question);
  }
  return buildDeliberativeInstructedPrompt(question);
}

/**
 * Run a single inference for one question.
 */
export async function runInference(
  client: OpenAI,
  config: RunConfig,
  question: Question,
): Promise<InferenceRecord> {
  const { system, user } = buildPrompt(config, question);

  const requestBody: OpenAI.ChatCompletionCreateParams = {
    model: config.model,
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
    temperature: config.temperature,
    top_p: config.topP,
    ...(config.maxTokens !== undefined ? { max_tokens: config.maxTokens } : {}),
    ...(config.seed !== undefined ? { seed: config.seed } : {}),
    ...(config.reasoningEffort !== undefined ? { reasoning: { effort: config.reasoningEffort } } as any : {}),
  };

  const startMs = performance.now();
  const completion = await client.chat.completions.create(requestBody);
  const latencyMs = Math.round(performance.now() - startMs);

  const message = completion.choices?.[0]?.message as any;
  const rawResponse = message?.content ?? "";
  const reasoning = message?.reasoning ?? undefined;
  const parsed = parseResponse(rawResponse);
  const usage = completion.usage as any;

  // OpenRouter returns reasoning_tokens in completion_tokens_details
  const reasoningTokens =
    usage?.completion_tokens_details?.reasoning_tokens ?? 0;
  // OpenRouter returns per-request cost
  const requestCost = typeof usage?.cost === "number" ? usage.cost : undefined;

  return {
    qid: question.qid,
    edition: question.exam.edition,
    questionNumber: question.number,
    model: config.model,
    provider: "openrouter",
    protocol: config.protocol,
    reasoningMode: config.reasoningMode,
    parameters: {
      temperature: config.temperature,
      top_p: config.topP,
      max_tokens: config.maxTokens,
      seed: config.seed,
    },
    timestamp: new Date().toISOString(),
    rawResponse,
    reasoning,
    parsedAnswer: parsed,
    latencyMs,
    tokenUsage: usage
      ? {
          promptTokens: usage.prompt_tokens ?? 0,
          completionTokens: usage.completion_tokens ?? 0,
          reasoningTokens,
          totalTokens: usage.total_tokens ?? 0,
        }
      : null,
    cost: requestCost,
    error: null,
    skipped: false,
  };
}
