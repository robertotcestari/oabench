import type { Question } from "./types.js";

function formatChoices(question: Question): string {
  return question.choices.map((c) => `${c.label}) ${c.text}`).join("\n");
}

/**
 * Protocol 1: Direct (sem reasoning).
 * Short prompt, asks for just the letter.
 */
export function buildDirectPrompt(question: Question): {
  system: string;
  user: string;
} {
  const system = [
    "Você é um assistente especializado em direito brasileiro.",
    "Responda à questão da prova da OAB com APENAS a letra da alternativa correta: A, B, C ou D.",
    "Não forneça explicações, justificativas ou qualquer outro texto.",
  ].join(" ");

  const user = [
    `Questão ${question.number}:`,
    "",
    question.stem,
    "",
    formatChoices(question),
  ].join("\n");

  return { system, user };
}

/**
 * Protocol 2: Deliberative with instructed reasoning.
 * Asks the model to think step by step and output FINAL_ANSWER: <letter>.
 */
export function buildDeliberativeInstructedPrompt(question: Question): {
  system: string;
  user: string;
} {
  const system = [
    "Você é um assistente especializado em direito brasileiro.",
    "Analise a questão da prova da OAB com cuidado.",
    "Raciocine passo a passo sobre cada alternativa antes de dar sua resposta final.",
    "Ao final do seu raciocínio, indique sua resposta no formato exato:",
    "",
    "FINAL_ANSWER: <letra>",
    "",
    "onde <letra> é A, B, C ou D.",
  ].join("\n");

  const user = [
    `Questão ${question.number}:`,
    "",
    question.stem,
    "",
    formatChoices(question),
  ].join("\n");

  return { system, user };
}

/**
 * Protocol 2: Deliberative with native reasoning.
 * Uses the same simple prompt as direct — the reasoning happens via
 * model-native parameters (reasoning_effort, etc.) set in the API call.
 */
export function buildDeliberativeNativePrompt(question: Question): {
  system: string;
  user: string;
} {
  return buildDirectPrompt(question);
}
