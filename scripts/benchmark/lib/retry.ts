import OpenAI from "openai";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryableError(error: unknown): boolean {
  if (error instanceof OpenAI.APIError) {
    return [429, 500, 502, 503, 504].includes(error.status);
  }
  // Network errors
  if (error instanceof TypeError && error.message.includes("fetch")) {
    return true;
  }
  return false;
}

function extractRetryAfterMs(error: unknown): number | null {
  if (error instanceof OpenAI.APIError) {
    const retryAfter = error.headers?.["retry-after"];
    if (retryAfter) {
      const seconds = parseFloat(retryAfter);
      if (!Number.isNaN(seconds)) return seconds * 1000;
    }
  }
  return null;
}

/**
 * Retry a function with exponential backoff. Retries on 429, 5xx, and network errors.
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  options: {
    maxRetries?: number;
    baseDelayMs?: number;
    maxDelayMs?: number;
  } = {},
): Promise<T> {
  const maxRetries = options.maxRetries ?? 3;
  const baseDelayMs = options.baseDelayMs ?? 2000;
  const maxDelayMs = options.maxDelayMs ?? 60_000;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      if (!isRetryableError(error) || attempt === maxRetries) throw error;

      const retryAfterMs = extractRetryAfterMs(error);
      const exponentialDelay =
        baseDelayMs * Math.pow(2, attempt) + Math.random() * 1000;
      const waitMs = retryAfterMs
        ? Math.max(retryAfterMs, 1000)
        : Math.min(exponentialDelay, maxDelayMs);

      const status =
        error instanceof OpenAI.APIError ? ` (${error.status})` : "";
      console.log(
        `  ↻ Retry ${attempt + 1}/${maxRetries}${status} — waiting ${Math.round(waitMs)}ms...`,
      );
      await sleep(waitMs);
    }
  }
  throw new Error("Unreachable");
}

/**
 * Simple sequential rate limiter that enforces a minimum interval between calls.
 */
export class RateLimiter {
  private lastRequestMs = 0;

  constructor(private minIntervalMs: number = 500) {}

  async wait(): Promise<void> {
    const now = Date.now();
    const elapsed = now - this.lastRequestMs;
    if (elapsed < this.minIntervalMs) {
      await sleep(this.minIntervalMs - elapsed);
    }
    this.lastRequestMs = Date.now();
  }
}
