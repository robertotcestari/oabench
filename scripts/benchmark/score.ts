import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import type {
  InferenceRecord,
  ScoredRecord,
  EditionSummary,
  RunSummary,
  RunConfig,
} from "./lib/types.js";
import { loadExamData } from "./lib/data-loader.js";

// ── CLI parsing ────────────────────────────────────────────────────────────

function resolveRunDir(): string {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      run: { type: "string" },
      "run-dir": { type: "string" },
    },
    strict: true,
  });

  if (values["run-dir"]) {
    return path.resolve(values["run-dir"]);
  }
  if (values.run) {
    return path.resolve(import.meta.dir, "../../results/runs", values.run);
  }

  console.error("Error: provide --run <run_id> or --run-dir <path>");
  process.exit(1);
}

// ── Load inferences ────────────────────────────────────────────────────────

/**
 * Load inferences, keeping only the last record per qid
 * (retries from --resume append new lines for the same qid).
 */
async function loadInferences(filePath: string): Promise<InferenceRecord[]> {
  const content = await readFile(filePath, "utf-8");
  const all = content
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as InferenceRecord);

  // Keep last occurrence of each qid (later entries = retries)
  const byQid = new Map<string, InferenceRecord>();
  for (const record of all) {
    byQid.set(record.qid, record);
  }
  return [...byQid.values()];
}

// ── Fetch pricing from OpenRouter ────────────────────────────────────────

async function fetchModelPricing(
  model: string,
): Promise<{ prompt: number; completion: number } | null> {
  try {
    const res = await fetch("https://openrouter.ai/api/v1/models");
    const data = (await res.json()) as {
      data: Array<{
        id: string;
        pricing?: { prompt?: string; completion?: string };
      }>;
    };
    const m = data.data.find((x) => x.id === model);
    if (m?.pricing) {
      return {
        prompt: parseFloat(m.pricing.prompt ?? "0"),
        completion: parseFloat(m.pricing.completion ?? "0"),
      };
    }
  } catch {
    console.warn("  ⚠ Could not fetch pricing from OpenRouter.");
  }
  return null;
}

// ── Scoring ────────────────────────────────────────────────────────────────

async function main() {
  const runDir = resolveRunDir();
  console.log(`Scoring run: ${path.basename(runDir)}\n`);

  // Load inferences
  const inferencesPath = path.join(runDir, "inferences.jsonl");
  const inferences = await loadInferences(inferencesPath);
  console.log(`  Loaded ${inferences.length} inference records.`);

  // Load run config
  let runConfig: RunConfig | null = null;
  try {
    runConfig = JSON.parse(
      await readFile(path.join(runDir, "config.json"), "utf-8"),
    ) as RunConfig;
  } catch {
    console.warn("  ⚠ Could not load config.json — using defaults from inferences.");
  }

  // Determine editions from inferences
  const editions = [...new Set(inferences.map((i) => i.edition))].sort();
  console.log(`  Editions: ${editions.join(", ")}`);

  // Load answer keys
  const examData = await loadExamData(editions);

  // Build lookups
  const answerKeyMap = new Map<string, { correct: string | null; status: string }>();
  const questionStatusMap = new Map<string, string>();

  for (const [, data] of examData) {
    for (const entry of data.answerKey) {
      answerKeyMap.set(entry.qid, {
        correct: entry.correct,
        status: entry.status,
      });
    }
    for (const q of data.questions) {
      questionStatusMap.set(q.qid, q.status.question);
    }
  }

  // Score each inference
  const scored: ScoredRecord[] = [];

  for (const inf of inferences) {
    const ak = answerKeyMap.get(inf.qid);
    const qStatus = questionStatusMap.get(inf.qid) ?? "active";
    const isAnnulled = qStatus === "annulled";
    const correctAnswer = ak?.correct ?? null;
    const modelAnswer = inf.parsedAnswer.lenient;
    const modelAnswerStrict = inf.parsedAnswer.strict;
    const isValid = !inf.skipped && modelAnswer !== null;

    scored.push({
      qid: inf.qid,
      edition: inf.edition,
      questionNumber: inf.questionNumber,
      status: isAnnulled ? "annulled" : "active",
      correctAnswer,
      modelAnswer,
      modelAnswerStrict,
      isCorrectOfficial: isAnnulled ? true : modelAnswer === correctAnswer,
      isCorrectTechnical: isAnnulled ? null : modelAnswer === correctAnswer,
      isValid,
    });
  }

  // Write scored.jsonl
  const scoredPath = path.join(runDir, "scored.jsonl");
  await writeFile(
    scoredPath,
    scored.map((r) => JSON.stringify(r)).join("\n") + "\n",
  );
  console.log(`  Wrote ${scored.length} scored records.`);

  // Generate summary
  const editionSummaries: EditionSummary[] = editions.map((edition) => {
    const edScored = scored.filter((s) => s.edition === edition);
    const total = edScored.length;
    const annulled = edScored.filter((s) => s.status === "annulled").length;
    const active = edScored.filter((s) => s.status === "active");
    const activeCount = active.length;
    const correct = active.filter((s) => s.isCorrectTechnical === true).length;
    const invalid = active.filter((s) => !s.isValid).length;
    const incorrect = activeCount - correct;
    const strictValid = active.filter((s) => s.modelAnswerStrict !== null).length;

    const officialScore = correct + annulled;
    const technicalTotal = total - annulled;

    return {
      edition,
      total,
      annulled,
      active: activeCount,
      correct,
      incorrect,
      invalid,
      officialScore,
      officialTotal: total,
      officialAccuracy: total > 0 ? officialScore / total : 0,
      technicalScore: correct,
      technicalTotal,
      technicalAccuracy: technicalTotal > 0 ? correct / technicalTotal : 0,
      passed: officialScore >= 40,
      strictComplianceRate:
        activeCount > 0 ? strictValid / activeCount : 0,
    };
  });

  // Aggregate
  const totalQuestions = scored.length;
  const totalAnnulled = scored.filter((s) => s.status === "annulled").length;
  const totalActive = totalQuestions - totalAnnulled;
  const totalCorrect = scored.filter(
    (s) => s.status === "active" && s.isCorrectTechnical === true,
  ).length;
  const totalInvalid = scored.filter(
    (s) => s.status === "active" && !s.isValid,
  ).length;
  const totalStrictValid = scored.filter(
    (s) => s.status === "active" && s.modelAnswerStrict !== null,
  ).length;
  const officialScore = totalCorrect + totalAnnulled;
  const technicalTotal = totalQuestions - totalAnnulled;

  // Cost aggregation from inferences
  const totalPromptTokens = inferences.reduce(
    (s, i) => s + (i.tokenUsage?.promptTokens ?? 0),
    0,
  );
  const totalCompletionTokens = inferences.reduce(
    (s, i) => s + (i.tokenUsage?.completionTokens ?? 0),
    0,
  );
  const totalReasoningTokens = inferences.reduce(
    (s, i) => s + (i.tokenUsage?.reasoningTokens ?? 0),
    0,
  );
  const totalLatencyMs = inferences.reduce((s, i) => s + i.latencyMs, 0);
  const nonSkippedCount = inferences.filter((i) => !i.skipped).length;
  // Actual cost reported by OpenRouter (sum of per-request costs)
  const actualCostUsd = inferences.reduce((s, i) => s + (i.cost ?? 0), 0) || undefined;

  const summary: RunSummary = {
    runId: runConfig?.runId ?? path.basename(runDir),
    model: runConfig?.model ?? inferences[0]?.model ?? "unknown",
    protocol: runConfig?.protocol ?? inferences[0]?.protocol ?? "direto",
    reasoningMode:
      runConfig?.reasoningMode ?? inferences[0]?.reasoningMode ?? "none",
    completedAt: new Date().toISOString(),
    editions: editionSummaries,
    aggregate: {
      totalQuestions,
      totalAnnulled,
      officialScore,
      officialAccuracy: totalQuestions > 0 ? officialScore / totalQuestions : 0,
      technicalScore: totalCorrect,
      technicalTotal,
      technicalAccuracy: technicalTotal > 0 ? totalCorrect / technicalTotal : 0,
      invalidCount: totalInvalid,
      invalidRate: totalActive > 0 ? totalInvalid / totalActive : 0,
      strictComplianceRate:
        totalActive > 0 ? totalStrictValid / totalActive : 0,
      passedCount: editionSummaries.filter((e) => e.passed).length,
      passedAll: editionSummaries.every((e) => e.passed),
    },
    cost: {
      totalPromptTokens,
      totalCompletionTokens,
      totalReasoningTokens,
      totalTokens: totalPromptTokens + totalCompletionTokens,
      totalLatencyMs,
      avgLatencyMs:
        nonSkippedCount > 0 ? Math.round(totalLatencyMs / nonSkippedCount) : 0,
      actualCostUsd,
    },
  };

  // Fetch and attach pricing
  const modelId = summary.model;
  console.log(`  Fetching pricing for ${modelId}...`);
  const modelPricing = await fetchModelPricing(modelId);
  if (modelPricing) {
    const estimatedCost =
      totalPromptTokens * modelPricing.prompt +
      totalCompletionTokens * modelPricing.completion;
    summary.pricing = {
      source: "openrouter",
      fetchedAt: new Date().toISOString(),
      promptPricePerToken: modelPricing.prompt,
      completionPricePerToken: modelPricing.completion,
      estimatedCostUsd: estimatedCost,
    };
    console.log(`  Estimated cost: $${estimatedCost.toFixed(4)}`);
  }

  // Write summary
  await writeFile(
    path.join(runDir, "summary.json"),
    JSON.stringify(summary, null, 2) + "\n",
  );

  // Print results table
  const pct = (n: number) => (n * 100).toFixed(1);
  const pad = (s: string, len: number) => s.padEnd(len);

  console.log(
    `\n╔══════════════════════════════════════════════════════════════╗`,
  );
  console.log(
    `║  OABench Results: ${summary.model}`,
  );
  console.log(
    `║  Protocol: ${summary.protocol}${summary.reasoningMode !== "none" ? ` (${summary.reasoningMode})` : ""}`,
  );
  console.log(
    `╠══════════════════════════════════════════════════════════════╣`,
  );
  console.log(
    `║ Edition │ Official       │ Technical      │ Passed │ Inv.  ║`,
  );
  console.log(
    `║─────────┼────────────────┼────────────────┼────────┼───────║`,
  );

  for (const ed of editionSummaries) {
    const official = `${ed.officialScore}/${ed.officialTotal} (${pct(ed.officialAccuracy)}%)`;
    const technical = `${ed.technicalScore}/${ed.technicalTotal} (${pct(ed.technicalAccuracy)}%)`;
    const passed = ed.passed ? " YES " : " NO  ";
    const inv = `${ed.invalid}`;
    console.log(
      `║  ${pad(String(ed.edition), 6)}│ ${pad(official, 15)}│ ${pad(technical, 15)}│${passed} │ ${pad(inv, 5)}║`,
    );
  }

  console.log(
    `║─────────┼────────────────┼────────────────┼────────┼───────║`,
  );

  const aggOfficial = `${summary.aggregate.officialScore}/${summary.aggregate.totalQuestions} (${pct(summary.aggregate.officialAccuracy)}%)`;
  const aggTechnical = `${summary.aggregate.technicalScore}/${summary.aggregate.technicalTotal} (${pct(summary.aggregate.technicalAccuracy)}%)`;
  const passedAll = `${summary.aggregate.passedCount}/${editionSummaries.length}`;
  const aggInv = `${summary.aggregate.invalidCount}`;
  console.log(
    `║  ${pad("Total", 6)}│ ${pad(aggOfficial, 15)}│ ${pad(aggTechnical, 15)}│ ${pad(passedAll, 5)}│ ${pad(aggInv, 5)}║`,
  );

  console.log(
    `╠══════════════════════════════════════════════════════════════╣`,
  );
  console.log(
    `║  Strict compliance: ${pct(summary.aggregate.strictComplianceRate)}%`,
  );
  console.log(
    `║  Avg latency:       ${summary.cost.avgLatencyMs}ms`,
  );
  console.log(
    `║  Total tokens:      ${summary.cost.totalTokens.toLocaleString()} (${summary.cost.totalReasoningTokens.toLocaleString()} reasoning)`,
  );
  if (summary.cost.actualCostUsd) {
    console.log(
      `║  Actual cost:       $${summary.cost.actualCostUsd.toFixed(4)} (reported by OpenRouter)`,
    );
  }
  if (summary.pricing) {
    console.log(
      `║  Estimated cost:    $${summary.pricing.estimatedCostUsd.toFixed(4)}`,
    );
  }
  console.log(
    `╚══════════════════════════════════════════════════════════════╝`,
  );

  // List wrong answers per edition
  console.log(`\nWrong answers by edition:`);
  for (const edition of editions) {
    const wrong = scored
      .filter(
        (s) =>
          s.edition === edition &&
          s.status === "active" &&
          s.isCorrectTechnical === false,
      )
      .map((s) => `Q${s.questionNumber}`)
      .join(", ");
    if (wrong) {
      console.log(`  ${edition}º: ${wrong}`);
    } else {
      console.log(`  ${edition}º: (none)`);
    }
  }

  console.log(`\nSummary written to: ${path.join(runDir, "summary.json")}`);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
