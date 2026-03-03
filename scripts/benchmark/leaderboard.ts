import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import type { RunSummary, EditionSummary } from "./lib/types.js";

// ── CLI ─────────────────────────────────────────────────────────────────────

const { values } = parseArgs({
  args: process.argv.slice(2),
  options: {
    merge: { type: "string", multiple: true }, // --merge "runA,runB" merges runs for same model
    json: { type: "boolean", default: false },
  },
  strict: true,
});

// ── Fetch pricing from OpenRouter ───────────────────────────────────────────

type ModelPricing = { prompt: number; completion: number }; // $/token

async function fetchPricing(): Promise<Map<string, ModelPricing>> {
  const res = await fetch("https://openrouter.ai/api/v1/models");
  const data = (await res.json()) as {
    data: Array<{ id: string; pricing?: { prompt?: string; completion?: string } }>;
  };
  const map = new Map<string, ModelPricing>();
  for (const m of data.data) {
    const p = m.pricing;
    if (p) {
      map.set(m.id, {
        prompt: parseFloat(p.prompt ?? "0"),
        completion: parseFloat(p.completion ?? "0"),
      });
    }
  }
  return map;
}

// ── Load runs ───────────────────────────────────────────────────────────────

const resultsRoot = path.resolve(import.meta.dir, "../../results/runs");

async function loadSummary(runId: string): Promise<RunSummary | null> {
  try {
    const summaryPath = path.join(resultsRoot, runId, "summary.json");
    return JSON.parse(await readFile(summaryPath, "utf-8")) as RunSummary;
  } catch {
    return null;
  }
}

/**
 * Merge multiple summaries for the same model (e.g. split runs across editions).
 * Combines edition arrays, token counts, and recomputes aggregates.
 */
function mergeSummaries(summaries: RunSummary[]): RunSummary {
  if (summaries.length === 1) return summaries[0];

  // Collect all editions (deduplicate by edition number, keep latest)
  const editionMap = new Map<number, EditionSummary>();
  for (const s of summaries) {
    for (const e of s.editions) {
      editionMap.set(e.edition, e);
    }
  }
  const editions = [...editionMap.values()].sort((a, b) => a.edition - b.edition);

  // Aggregate
  const totalQuestions = editions.reduce((s, e) => s + e.total, 0);
  const totalAnnulled = editions.reduce((s, e) => s + e.annulled, 0);
  const totalCorrect = editions.reduce((s, e) => s + e.correct, 0);
  const totalInvalid = editions.reduce((s, e) => s + e.invalid, 0);
  const totalActive = totalQuestions - totalAnnulled;
  const officialScore = totalCorrect + totalAnnulled;
  const technicalTotal = totalQuestions - totalAnnulled;
  const totalStrictValid = editions.reduce(
    (s, e) => s + Math.round(e.strictComplianceRate * e.active),
    0,
  );

  // Sum cost across all runs
  const totalPromptTokens = summaries.reduce((s, r) => s + r.cost.totalPromptTokens, 0);
  const totalCompletionTokens = summaries.reduce(
    (s, r) => s + r.cost.totalCompletionTokens,
    0,
  );
  const totalReasoningTokens = summaries.reduce(
    (s, r) => s + (r.cost.totalReasoningTokens ?? 0),
    0,
  );
  const totalLatencyMs = summaries.reduce((s, r) => s + r.cost.totalLatencyMs, 0);
  const nonSkippedQuestions = totalQuestions - totalAnnulled;
  // Sum actual costs if all runs have them
  const allHaveActualCost = summaries.every((s) => s.cost.actualCostUsd !== undefined);
  const actualCostUsd = allHaveActualCost
    ? summaries.reduce((s, r) => s + (r.cost.actualCostUsd ?? 0), 0)
    : undefined;

  const base = summaries[0];
  return {
    runId: summaries.map((s) => s.runId).join(" + "),
    model: base.model,
    protocol: base.protocol,
    reasoningMode: base.reasoningMode,
    completedAt: summaries[summaries.length - 1].completedAt,
    editions,
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
      strictComplianceRate: totalActive > 0 ? totalStrictValid / totalActive : 0,
      passedCount: editions.filter((e) => e.passed).length,
      passedAll: editions.every((e) => e.passed),
    },
    cost: {
      totalPromptTokens,
      totalCompletionTokens,
      totalReasoningTokens,
      totalTokens: totalPromptTokens + totalCompletionTokens,
      totalLatencyMs,
      actualCostUsd,
      avgLatencyMs:
        nonSkippedQuestions > 0 ? Math.round(totalLatencyMs / nonSkippedQuestions) : 0,
    },
  };
}

type LeaderboardEntry = {
  summary: RunSummary;
  merged: boolean;
};

async function discoverEntries(): Promise<LeaderboardEntry[]> {
  const dirs = await readdir(resultsRoot);
  const allSummaries: { runId: string; summary: RunSummary }[] = [];
  for (const dir of dirs) {
    const s = await loadSummary(dir);
    if (s) allSummaries.push({ runId: dir, summary: s });
  }

  // Group by model+protocol+reasoningMode
  const groups = new Map<string, RunSummary[]>();
  for (const { summary } of allSummaries) {
    const key = `${summary.model}|${summary.protocol}|${summary.reasoningMode}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(summary);
  }

  const entries: LeaderboardEntry[] = [];

  for (const [, summaries] of groups) {
    // Check if any single run has all 240 questions
    const completeRun = summaries.find((s) => s.aggregate.totalQuestions >= 240);
    if (completeRun) {
      entries.push({ summary: completeRun, merged: false });
      continue;
    }

    // Try to merge runs to cover all 3 editions
    // Collect all edition numbers across runs
    const editionCoverage = new Map<number, RunSummary>();
    // Sort by runId descending (latest first) so latest run wins per edition
    const sorted = [...summaries].sort((a, b) => b.runId.localeCompare(a.runId));
    for (const s of sorted) {
      for (const e of s.editions) {
        if (!editionCoverage.has(e.edition)) {
          editionCoverage.set(e.edition, s);
        }
      }
    }

    const coveredEditions = [...editionCoverage.keys()].sort();
    if (coveredEditions.length >= 3) {
      // Find the unique summaries needed
      const neededSummaries = [...new Set(editionCoverage.values())];
      const merged = mergeSummaries(neededSummaries);
      entries.push({ summary: merged, merged: true });
    }
    // Else: skip incomplete model (not enough editions)
  }

  return entries;
}

// ── Calculate cost ──────────────────────────────────────────────────────────

function calculateCost(summary: RunSummary, pricing: ModelPricing): number {
  const promptCost = summary.cost.totalPromptTokens * pricing.prompt;
  const completionCost = summary.cost.totalCompletionTokens * pricing.completion;
  return promptCost + completionCost;
}

// ── Format helpers ──────────────────────────────────────────────────────────

function pct(n: number): string {
  return (n * 100).toFixed(1) + "%";
}

function fmtCost(dollars: number): string {
  if (dollars < 0) return "N/A";
  if (dollars < 0.001) return `<$0.001`;
  return `$${dollars.toFixed(4)}`;
}

function pad(s: string, len: number): string {
  return s.padEnd(len);
}

function shortModel(model: string): string {
  const name = model.split("/").pop() ?? model;
  return name
    .replace(/-preview$/, "")
    .replace(/-lite-preview$/, " Lite")
    .replace(/-lite$/, " Lite")
    .split("-")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

function fmtPricePerM(perToken: number): string {
  const perM = perToken * 1e6;
  if (perM < 0.01) return `$${perM.toFixed(4)}`;
  return `$${perM.toFixed(2)}`;
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main() {
  console.log("Fetching model pricing from OpenRouter...\n");
  const pricing = await fetchPricing();
  const entries = await discoverEntries();

  if (entries.length === 0) {
    console.error("No complete runs found.");
    process.exit(1);
  }

  // Handle --merge flags for explicit merging
  if (values.merge) {
    // Not implemented yet in auto mode, but auto-merge handles it
  }

  // Build table rows
  type Row = {
    model: string;
    shortName: string;
    protocol: string;
    editions: { edition: number; score: string; accuracy: number; passed: boolean }[];
    total: string;
    totalAccuracy: number;
    passed: string;
    avgLatency: string;
    cost: string;
    costValue: number;
    promptTokens: number;
    completionTokens: number;
    reasoningTokens: number;
    actualCost?: number;
    merged: boolean;
  };

  const rows: Row[] = [];
  for (const entry of entries) {
    const s = entry.summary;
    const p = pricing.get(s.model);
    // Prefer actual cost from OpenRouter, fallback to estimated
    const actualCost = s.cost.actualCostUsd;
    const estimatedCost = p ? calculateCost(s, p) : -1;
    const cost = actualCost ?? (estimatedCost >= 0 ? estimatedCost : -1);

    rows.push({
      model: s.model,
      shortName: shortModel(s.model),
      protocol: s.protocol + (s.reasoningMode !== "none" ? ` (${s.reasoningMode})` : ""),
      editions: s.editions.map((e) => ({
        edition: e.edition,
        score: `${e.officialScore}/${e.officialTotal}`,
        accuracy: e.officialAccuracy,
        passed: e.passed,
      })),
      total: `${s.aggregate.officialScore}/${s.aggregate.totalQuestions}`,
      totalAccuracy: s.aggregate.officialAccuracy,
      passed: `${s.aggregate.passedCount}/${s.editions.length}`,
      avgLatency: `${(s.cost.avgLatencyMs / 1000).toFixed(1)}s`,
      cost: fmtCost(cost),
      costValue: cost,
      promptTokens: s.cost.totalPromptTokens,
      completionTokens: s.cost.totalCompletionTokens,
      reasoningTokens: s.cost.totalReasoningTokens ?? 0,
      actualCost,
      merged: entry.merged,
    });
  }

  // Sort by total accuracy descending
  rows.sort((a, b) => b.totalAccuracy - a.totalAccuracy);

  if (values.json) {
    console.log(JSON.stringify(rows, null, 2));
    return;
  }

  // Print table
  const W = 115;
  const line = "═".repeat(W);
  const dash = "─";

  console.log(`╔${line}╗`);
  console.log(`║${pad("  OABench Leaderboard — Protocol: direto", W)}║`);
  console.log(`╠${line}╣`);

  const header = ` # │ ${pad("Model", 28)}│ ${pad("43º Exame", 16)}│ ${pad("44º Exame", 16)}│ ${pad("45º Exame", 16)}│ ${pad("Total", 17)}│ ${pad("Latency", 9)}│ ${pad("Cost", 8)}`;
  console.log(`║${pad(header, W)}║`);

  const sep = `${dash.repeat(3)}┼${dash.repeat(29)}┼${dash.repeat(17)}┼${dash.repeat(17)}┼${dash.repeat(17)}┼${dash.repeat(18)}┼${dash.repeat(10)}┼${dash.repeat(9)}`;
  console.log(`║${pad(sep, W)}║`);

  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const rank = `${i + 1}`.padStart(2);
    const name = r.shortName + (r.merged ? " *" : "");
    const ed = (edition: number) => {
      const e = r.editions.find((x) => x.edition === edition);
      return e ? `${e.score} (${pct(e.accuracy)})` : "—";
    };
    const totalStr = `${r.total} (${pct(r.totalAccuracy)})`;
    const row = `${rank} │ ${pad(name, 28)}│ ${pad(ed(43), 16)}│ ${pad(ed(44), 16)}│ ${pad(ed(45), 16)}│ ${pad(totalStr, 17)}│ ${pad(r.avgLatency, 9)}│ ${pad(r.cost, 8)}`;
    console.log(`║${pad(row, W)}║`);
  }

  console.log(`╠${line}╣`);

  // Cost breakdown
  console.log(`║${pad("  Cost & Token Breakdown:", W)}║`);
  console.log(`║${pad("", W)}║`);
  for (const r of rows) {
    const p = pricing.get(r.model);
    const tokensIn = r.promptTokens.toLocaleString();
    const tokensOut = r.completionTokens.toLocaleString();
    const thinkTokens = r.reasoningTokens;
    const thinkStr = thinkTokens > 0 ? ` (${thinkTokens.toLocaleString()} thinking)` : "";
    const priceStr = p
      ? `${fmtPricePerM(p.prompt)}/${fmtPricePerM(p.completion)} per M`
      : "pricing N/A";
    const costSource = r.actualCost !== undefined ? " (actual)" : " (est.)";
    const line1 = `  ${r.shortName}: ${tokensIn} in + ${tokensOut} out${thinkStr}`;
    const line2 = `    ${priceStr} = ${r.cost}${costSource}`;
    console.log(`║${pad(line1, W)}║`);
    console.log(`║${pad(line2, W)}║`);
  }

  const notes: string[] = [];
  if (rows.some((r) => r.merged)) notes.push("* = merged from multiple partial runs");
  if (rows.some((r) => r.actualCost !== undefined)) notes.push("(actual) = cost reported by OpenRouter per-request");
  if (rows.some((r) => r.actualCost === undefined)) notes.push("(est.) = estimated from token count × listed price");
  if (notes.length) {
    console.log(`║${pad("", W)}║`);
    for (const n of notes) console.log(`║${pad(`  ${n}`, W)}║`);
  }

  console.log(`╚${line}╝`);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
