const VALID_LETTERS = new Set(["A", "B", "C", "D"]);

/**
 * Strict parsing: only accepts a bare letter A/B/C/D (possibly with trailing punctuation).
 */
export function parseStrict(raw: string): string | null {
  const trimmed = raw.trim().toUpperCase();
  if (VALID_LETTERS.has(trimmed)) return trimmed;
  // Accept single letter with trailing period/parenthesis: "A." or "A)"
  const match = trimmed.match(/^([A-D])[.)]\s*$/);
  return match ? match[1] : null;
}

/**
 * Lenient parsing: extracts the answer using multiple strategies in priority order.
 *
 * 1. FINAL_ANSWER: X  pattern (deliberativo protocol)
 * 2. "Resposta: X" or "Alternativa X" patterns
 * 3. Standalone letter on the last non-empty line
 * 4. First standalone A/B/C/D occurrence in the text
 */
export function parseLenient(raw: string): string | null {
  if (!raw || !raw.trim()) return null;

  // Strategy 1: FINAL_ANSWER: X
  const finalAnswerMatch = raw.match(/FINAL_ANSWER:\s*([A-Da-d])/i);
  if (finalAnswerMatch) return finalAnswerMatch[1].toUpperCase();

  // Strategy 2: Common patterns — "Resposta: X", "Alternativa X", "Letra X"
  const patternMatch = raw.match(
    /(?:resposta|alternativa|letra|answer|opção|opcao)[\s:]*([A-Da-d])\b/i,
  );
  if (patternMatch) return patternMatch[1].toUpperCase();

  // Strategy 3: Last non-empty line is a single letter
  const lines = raw.trim().split("\n").filter((l) => l.trim());
  if (lines.length > 0) {
    const lastLine = lines[lines.length - 1].trim();
    const lastLineMatch = lastLine.match(/^([A-Da-d])[.):\s]*$/);
    if (lastLineMatch) return lastLineMatch[1].toUpperCase();
  }

  // Strategy 4: First standalone letter (word boundary on both sides)
  const firstMatch = raw.match(/\b([A-Da-d])\b/);
  if (firstMatch) return firstMatch[1].toUpperCase();

  return null;
}

/**
 * Parse a raw model response using both strict and lenient strategies.
 */
export function parseResponse(raw: string): {
  strict: string | null;
  lenient: string | null;
} {
  return {
    strict: parseStrict(raw),
    lenient: parseLenient(raw),
  };
}
