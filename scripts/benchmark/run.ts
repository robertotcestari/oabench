import { mkdir, readFile, writeFile, appendFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import type { InferenceRecord, Protocol, ReasoningMode, RunConfig } from "./lib/types.js";
import { loadExamData } from "./lib/data-loader.js";
import { createClient, runInference } from "./lib/openrouter-client.js";
import { buildDirectPrompt, buildDeliberativeInstructedPrompt } from "./lib/prompts.js";
import { withRetry } from "./lib/retry.js";

// ── CLI argument parsing ───────────────────────────────────────────────────

function parseCliArgs(): RunConfig {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      model: { type: "string" },
      protocol: { type: "string" },
      reasoning: { type: "string", default: "instructed" },
      editions: { type: "string", default: "43,44,45" },
      temperature: { type: "string", default: "0" },
      "top-p": { type: "string", default: "1" },
      "max-tokens": { type: "string" },
      seed: { type: "string" },
      "reasoning-effort": { type: "string" },
      resume: { type: "string" },
      "dry-run": { type: "boolean", default: false },
      "delay-ms": { type: "string", default: "200" },
      concurrency: { type: "string", default: "4" },
    },
    strict: true,
  });

  if (!values.model) {
    console.error("Error: --model is required (e.g. --model openai/gpt-4o-mini)");
    process.exit(1);
  }
  if (!values.protocol || !["direto", "deliberativo"].includes(values.protocol)) {
    console.error("Error: --protocol must be 'direto' or 'deliberativo'");
    process.exit(1);
  }

  const protocol = values.protocol as Protocol;
  let reasoningMode: ReasoningMode = "none";
  if (protocol === "deliberativo") {
    if (!["native", "instructed"].includes(values.reasoning!)) {
      console.error("Error: --reasoning must be 'native' or 'instructed' for deliberativo protocol");
      process.exit(1);
    }
    reasoningMode = values.reasoning as ReasoningMode;
  }

  const editions = values.editions!.split(",").map((s) => parseInt(s.trim(), 10));
  // No default max_tokens — let the model use as many tokens as it needs.
  // Reasoning models consume tokens internally, so capping can cause empty responses.
  const defaultMaxTokens = undefined;

  return {
    runId: "", // set below
    model: values.model,
    protocol,
    reasoningMode,
    editions,
    temperature: parseFloat(values.temperature!),
    topP: parseFloat(values["top-p"]!),
    maxTokens: values["max-tokens"]
      ? parseInt(values["max-tokens"], 10)
      : undefined,
    seed: values.seed ? parseInt(values.seed, 10) : undefined,
    reasoningEffort: values["reasoning-effort"] as RunConfig["reasoningEffort"],
    delayMs: parseInt(values["delay-ms"]!, 10),
    concurrency: parseInt(values.concurrency!, 10),
    dryRun: values["dry-run"]!,
    resumeRunId: values.resume,
  };
}

// ── Run ID generation ──────────────────────────────────────────────────────

function generateRunId(config: RunConfig): string {
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const slug = config.model.replace(/\//g, "--");
  const suffix = config.reasoningEffort
    ? `${config.protocol}_reasoning-${config.reasoningEffort}`
    : config.protocol;
  return `${ts}_${slug}_${suffix}`;
}

// ── Resume: load already-completed qids ────────────────────────────────────

async function loadCompletedQids(inferencesPath: string): Promise<Set<string>> {
  const completed = new Set<string>();
  try {
    const content = await readFile(inferencesPath, "utf-8");
    for (const line of content.split("\n").filter(Boolean)) {
      const record = JSON.parse(line) as InferenceRecord;
      if (record.error === null) {
        completed.add(record.qid);
      }
    }
  } catch {
    // File doesn't exist yet — starting fresh
  }
  return completed;
}

// ── Main ───────────────────────────────────────────────────────────────────

async function main() {
  const config = parseCliArgs();

  // Load exam data
  console.log(`Loading exam data for editions: ${config.editions.join(", ")}...`);
  const examData = await loadExamData(config.editions);

  if (examData.size === 0) {
    console.error("No exam data found for the specified editions.");
    process.exit(1);
  }

  // Setup run directory
  const resultsRoot = path.resolve(import.meta.dir, "../../results/runs");
  let runDir: string;

  if (config.resumeRunId) {
    runDir = path.join(resultsRoot, config.resumeRunId);
    config.runId = config.resumeRunId;
    console.log(`Resuming run: ${config.resumeRunId}`);
  } else {
    config.runId = generateRunId(config);
    runDir = path.join(resultsRoot, config.runId);
    await mkdir(runDir, { recursive: true });
  }

  // Load completed qids if resuming
  const inferencesPath = path.join(runDir, "inferences.jsonl");
  const completedQids = config.resumeRunId
    ? await loadCompletedQids(inferencesPath)
    : new Set<string>();

  if (completedQids.size > 0) {
    console.log(`  Found ${completedQids.size} already-completed questions.`);
  }

  // Build question queue (skip completed + skip annulled)
  type QueueItem = { qid: string; edition: number; number: number; annulled: boolean };
  const allQuestions: QueueItem[] = [];
  const queue: QueueItem[] = [];

  for (const [edition, data] of [...examData.entries()].sort((a, b) => a[0] - b[0])) {
    for (const q of data.questions) {
      const item: QueueItem = {
        qid: q.qid,
        edition,
        number: q.number,
        annulled: q.status.question === "annulled",
      };
      allQuestions.push(item);
      if (!completedQids.has(q.qid)) {
        queue.push(item);
      }
    }
  }

  const totalAll = allQuestions.length;
  const annulledCount = allQuestions.filter((q) => q.annulled).length;
  const toProcess = queue.filter((q) => !q.annulled).length;
  const toSkip = queue.filter((q) => q.annulled).length;

  // Summary
  console.log(`\n╭─ OABench Runner ─────────────────────────────╮`);
  console.log(`│ Model:     ${config.model}`);
  console.log(`│ Protocol:  ${config.protocol}${config.reasoningMode !== "none" ? ` (${config.reasoningMode})` : ""}`);
  console.log(`│ Editions:  ${config.editions.join(", ")}`);
  console.log(`│ Questions: ${totalAll} total, ${annulledCount} annulled`);
  console.log(`│ To call:   ${toProcess} API calls`);
  console.log(`│ To skip:   ${toSkip} annulled + ${completedQids.size} already done`);
  console.log(`│ Concurr.:  ${config.concurrency} parallel requests`);
  console.log(`│ Temp:      ${config.temperature}`);
  console.log(`│ Max tokens: ${config.maxTokens}`);
  console.log(`│ Run ID:    ${config.runId}`);
  console.log(`╰──────────────────────────────────────────────╯\n`);

  // Dry run
  if (config.dryRun) {
    console.log("DRY RUN — showing sample prompt:\n");
    const sampleQ = [...examData.values()][0].questions.find(
      (q) => q.status.question === "active",
    );
    if (sampleQ) {
      const prompt =
        config.protocol === "direto"
          ? buildDirectPrompt(sampleQ)
          : buildDeliberativeInstructedPrompt(sampleQ);
      console.log("SYSTEM:", prompt.system);
      console.log("\nUSER:", prompt.user.substring(0, 500));
      if (prompt.user.length > 500) console.log("  ...(truncated)");
    }
    console.log("\nNo API calls were made.");
    process.exit(0);
  }

  // Save config snapshot
  await writeFile(
    path.join(runDir, "config.json"),
    JSON.stringify(config, null, 2) + "\n",
  );

  // Create client
  const client = createClient();

  // Build a lookup for Question objects
  const questionLookup = new Map<string, import("./lib/types.js").Question>();
  for (const [, data] of examData) {
    for (const q of data.questions) {
      questionLookup.set(q.qid, q);
    }
  }

  // Write lock for append-safe JSONL writes
  let writeQueue = Promise.resolve();
  function safeAppend(filePath: string, data: string): Promise<void> {
    writeQueue = writeQueue.then(() => appendFile(filePath, data));
    return writeQueue;
  }

  // Process with concurrency semaphore
  let processed = completedQids.size;
  const total = totalAll;
  let apiCalls = 0;
  let errors = 0;

  // First, handle annulled questions synchronously (instant, no API)
  const annulledItems = queue.filter((q) => q.annulled);
  const apiItems = queue.filter((q) => !q.annulled);

  for (const item of annulledItems) {
    processed++;
    const record: InferenceRecord = {
      qid: item.qid,
      edition: item.edition,
      questionNumber: item.number,
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
      rawResponse: "",
      parsedAnswer: { strict: null, lenient: null },
      latencyMs: 0,
      tokenUsage: null,
      error: null,
      skipped: true,
    };
    await safeAppend(inferencesPath, JSON.stringify(record) + "\n");
    console.log(`  [${processed}/${total}] ${item.qid} — SKIPPED (annulled)`);
  }

  // Concurrent processing of API items
  const concurrency = config.concurrency;
  let running = 0;
  let itemIndex = 0;

  async function processItem(item: QueueItem): Promise<void> {
    const question = questionLookup.get(item.qid)!;
    apiCalls++;

    try {
      const record = await withRetry(() => runInference(client, config, question));
      await safeAppend(inferencesPath, JSON.stringify(record) + "\n");

      processed++;
      const answer = record.parsedAnswer.lenient ?? "INVALID";
      console.log(
        `  [${processed}/${total}] ${item.qid} → ${answer} (${record.latencyMs}ms)`,
      );
    } catch (err) {
      errors++;
      processed++;
      const errorRecord: InferenceRecord = {
        qid: item.qid,
        edition: item.edition,
        questionNumber: item.number,
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
        rawResponse: "",
        parsedAnswer: { strict: null, lenient: null },
        latencyMs: 0,
        tokenUsage: null,
        error: String(err),
        skipped: false,
      };
      await safeAppend(inferencesPath, JSON.stringify(errorRecord) + "\n");
      console.error(`  ✗ ERROR on ${item.qid}: ${String(err)}`);
    }
  }

  // Dynamic pool: always keep `concurrency` requests in flight.
  // When one finishes, the next one starts immediately (no batch stalling).
  await new Promise<void>((resolve, reject) => {
    let nextIdx = 0;
    let inFlight = 0;
    let finished = false;

    function launch() {
      while (inFlight < concurrency && nextIdx < apiItems.length) {
        const item = apiItems[nextIdx++];
        inFlight++;
        processItem(item)
          .then(() => {
            inFlight--;
            if (nextIdx < apiItems.length) {
              launch();
            } else if (inFlight === 0 && !finished) {
              finished = true;
              resolve();
            }
          })
          .catch((err) => {
            inFlight--;
            if (!finished) {
              finished = true;
              reject(err);
            }
          });
      }
      if (apiItems.length === 0 && !finished) {
        finished = true;
        resolve();
      }
    }

    launch();
  });

  // Done
  console.log(`\n╭─ Run Complete ───────────────────────────────╮`);
  console.log(`│ API calls: ${apiCalls}`);
  console.log(`│ Errors:    ${errors}`);
  console.log(`│ Results:   ${runDir}`);
  console.log(`╰──────────────────────────────────────────────╯`);
  console.log(`\nNext: score this run with:`);
  console.log(`  bun scripts/benchmark/score.ts --run ${config.runId}`);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
