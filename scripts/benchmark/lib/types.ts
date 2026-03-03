// ── Data types (from existing questions.json / answer_key.json schema) ──────

export type Choice = {
  label: "A" | "B" | "C" | "D";
  text: string;
};

export type Question = {
  schema_version: string;
  qid: string;
  exam: {
    program: string;
    edition: number;
    phase: number;
    date: string;
    organizer: string;
  };
  number: number;
  language: string;
  area: string | null;
  stem: string;
  choices: Choice[];
  modality: {
    requires_image: boolean;
    assets: string[];
  };
  source: {
    prova: { url: string; sha256: string; pages: number[] };
    gabarito: { url: string; sha256: string; kind: string };
  };
  status: { question: "active" | "annulled" | "dropped" };
  extraction: { pipeline_version: string; extracted_at: string };
};

export type AnswerKeyEntry = {
  qid: string;
  correct: "A" | "B" | "C" | "D" | null;
  status: "definitivo" | "preliminar" | "anulada";
};

// ── Benchmark configuration ────────────────────────────────────────────────

export type Protocol = "direto" | "deliberativo";
export type ReasoningMode = "none" | "instructed" | "native";

export type RunConfig = {
  runId: string;
  model: string;
  protocol: Protocol;
  reasoningMode: ReasoningMode;
  editions: number[];
  temperature: number;
  topP: number;
  maxTokens: number | undefined;
  seed: number | undefined;
  reasoningEffort: "low" | "medium" | "high" | undefined;
  delayMs: number;
  concurrency: number;
  dryRun: boolean;
  resumeRunId: string | undefined;
};

// ── Inference record (1 line in inferences.jsonl) ──────────────────────────

export type InferenceRecord = {
  qid: string;
  edition: number;
  questionNumber: number;
  model: string;
  provider: string;
  protocol: Protocol;
  reasoningMode: ReasoningMode;
  parameters: {
    temperature: number;
    top_p: number;
    max_tokens: number;
    seed?: number;
  };
  timestamp: string;
  rawResponse: string;
  reasoning?: string;
  parsedAnswer: { strict: string | null; lenient: string | null };
  latencyMs: number;
  tokenUsage: {
    promptTokens: number;
    completionTokens: number;
    reasoningTokens: number;
    totalTokens: number;
  } | null;
  cost?: number;
  error: string | null;
  skipped: boolean;
};

// ── Scored record (1 line in scored.jsonl) ─────────────────────────────────

export type ScoredRecord = {
  qid: string;
  edition: number;
  questionNumber: number;
  status: "active" | "annulled";
  correctAnswer: string | null;
  modelAnswer: string | null;
  modelAnswerStrict: string | null;
  isCorrectOfficial: boolean;
  isCorrectTechnical: boolean | null;
  isValid: boolean;
};

// ── Summary types ──────────────────────────────────────────────────────────

export type EditionSummary = {
  edition: number;
  total: number;
  annulled: number;
  active: number;
  correct: number;
  incorrect: number;
  invalid: number;
  officialScore: number;
  officialTotal: number;
  officialAccuracy: number;
  technicalScore: number;
  technicalTotal: number;
  technicalAccuracy: number;
  passed: boolean;
  strictComplianceRate: number;
};

export type RunSummary = {
  runId: string;
  model: string;
  protocol: Protocol;
  reasoningMode: ReasoningMode;
  completedAt: string;
  editions: EditionSummary[];
  aggregate: {
    totalQuestions: number;
    totalAnnulled: number;
    officialScore: number;
    officialAccuracy: number;
    technicalScore: number;
    technicalTotal: number;
    technicalAccuracy: number;
    invalidCount: number;
    invalidRate: number;
    strictComplianceRate: number;
    passedCount: number;
    passedAll: boolean;
  };
  cost: {
    totalPromptTokens: number;
    totalCompletionTokens: number;
    totalReasoningTokens: number;
    totalTokens: number;
    totalLatencyMs: number;
    avgLatencyMs: number;
    actualCostUsd?: number;
  };
  pricing?: {
    source: string;
    fetchedAt: string;
    promptPricePerToken: number;
    completionPricePerToken: number;
    estimatedCostUsd: number;
  };
};

// ── latest-run.json structure ──────────────────────────────────────────────

export type DownloadedFile = {
  url: string;
  label: string;
  localPath: string;
  bytes?: number;
};

export type DownloadedExam = {
  examId: string;
  examName: string;
  examPageUrl: string;
  prova: DownloadedFile;
  gabarito: DownloadedFile;
};

export type LatestRun = {
  runId: string;
  ranAt: string;
  source: string;
  selectedExams: DownloadedExam[];
};
