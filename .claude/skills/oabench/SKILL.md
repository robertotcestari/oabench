---
name: oabench
description: >
  Run OABench benchmark evaluations of AI models on OAB (Brazilian Bar Exam) questions.
  Use when the user asks to: run a benchmark, test a model on OAB, evaluate a model,
  score results, check benchmark results, compare models, "rodar benchmark", "testar modelo",
  "avaliar modelo na OAB", "pontuar resultados", "ver resultados do benchmark", "rodar OABench".
  Covers the full pipeline: run inference, auto-retry failures, score, and display results.
---

# OABench Benchmark Runner

Project root: `/Users/robertotcestari/Programming/projetos/tritri/oabench`

All commands run from project root.

## Quick Reference

```bash
# Run benchmark (default: all 3 editions, concurrency 4)
bun scripts/benchmark/run.ts --model <model_id> --protocol <direto|deliberativo> [options]

# Score results
bun scripts/benchmark/score.ts --run <run_id>
```

## CLI Options

| Flag | Default | Notes |
|------|---------|-------|
| `--model` | required | OpenRouter model ID: `openai/gpt-5-mini`, `anthropic/claude-sonnet-4`, etc. |
| `--protocol` | required | `direto` (letter only) or `deliberativo` (step-by-step) |
| `--reasoning` | `instructed` | For deliberativo: `instructed` or `native` |
| `--editions` | `43,44,45` | Comma-separated |
| `--concurrency` | `4` | Parallel requests. 20 is safe for most models. |
| `--temperature` | `0` | |
| `--max-tokens` | unlimited | **Never set** unless user explicitly asks. Reasoning models need unlimited. |
| `--resume` | — | Run ID to resume (retries only failed/missing items) |
| `--dry-run` | false | Preview without API calls |

## Full Workflow (run + retry + score)

### Step 1: Run

```bash
bun scripts/benchmark/run.ts --model "openai/gpt-5-mini" --protocol direto --concurrency 20
```

Note the run ID printed at the end.

### Step 2: Check for failures and auto-retry

After the run, check and retry any failed items (empty responses, errors):

```python
# Run this from project root — replace <RUN_ID> with actual run ID
python3 -c "
import json, sys
path = 'results/runs/<RUN_ID>/inferences.jsonl'
with open(path) as f:
    lines = [json.loads(l) for l in f if l.strip()]
failed = []
for r in lines:
    if r['skipped']: continue
    if r['error'] is not None or r['rawResponse'] == '':
        failed.append(r)
if not failed:
    print('0 failures — all good!')
    sys.exit(0)
print(f'{len(failed)} failures found, marking for retry...')
for r in lines:
    if r['skipped']: continue
    if r['rawResponse'] == '' and r['error'] is None:
        r['error'] = 'empty_response_retry'
with open(path, 'w') as f:
    for r in lines: f.write(json.dumps(r) + '\n')
print('Done. Now resume the run.')
"
```

Then resume:

```bash
bun scripts/benchmark/run.ts --model "openai/gpt-5-mini" --protocol direto --concurrency 20 --resume "<RUN_ID>"
```

Repeat steps 2 until 0 failures.

### Step 3: Score

```bash
bun scripts/benchmark/score.ts --run "<RUN_ID>"
```

Scorer deduplicates by qid (keeps last record), so retries are handled correctly.
Scorer also fetches live pricing from OpenRouter and saves it in `summary.json`.

### Step 4: Leaderboard

```bash
bun scripts/benchmark/leaderboard.ts
```

Shows all completed runs ranked by accuracy, with cost estimates.
Auto-discovers runs, merges partial runs for the same model, fetches live pricing.

## Critical Rules

- **Never set --max-tokens** unless user explicitly asks. Reasoning models consume tokens internally. Capping causes empty responses (`content: null`).
- **OPENROUTER_API_KEY** must be in `.env` at project root (Bun auto-loads).
- **Annulled questions** are auto-skipped (no API call). Official score gives automatic point.
- **Results** saved to `results/runs/<run_id>/` with: `config.json`, `inferences.jsonl`, `scored.jsonl`, `summary.json` (includes pricing snapshot).

## Finding Model IDs on OpenRouter

**Always search before running** — model IDs change and new ones appear frequently.

```bash
# Search by keyword (replace KEYWORD: gpt-5, claude, gemini, llama, etc.)
curl -s https://openrouter.ai/api/v1/models | python3 -c "
import json,sys
kw = 'KEYWORD'.lower()
for m in json.load(sys.stdin)['data']:
    if kw in m['id'].lower():
        print(f\"{m['id']:50s}  {m.get('name','')}\")" 2>/dev/null
```

Common model ID patterns:
- `openai/gpt-5-mini`, `openai/gpt-4o`, `openai/o3-mini`
- `anthropic/claude-sonnet-4`, `anthropic/claude-haiku-4`
- `google/gemini-2.5-pro`, `google/gemini-2.5-flash-lite`
- `meta-llama/llama-4-scout`
