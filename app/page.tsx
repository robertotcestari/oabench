// ── Benchmark data (hardcoded, updated manually after runs) ─────────────────

type Edition = {
  edition: number;
  score: number;
  total: number;
};

type ModelResult = {
  name: string;
  provider: "google" | "openai" | "anthropic" | "xai" | "deepseek";
  accuracy: number;
  score: number;
  total: number;
  cost: string;
  latency: string;
  note?: string;
  editions: Edition[];
};

const MODELS: ModelResult[] = [
  {
    name: "Gemini 3 Flash",
    provider: "google",
    accuracy: 97.9,
    score: 235,
    total: 240,
    cost: "$0.05",
    latency: "2.2s",
    editions: [
      { edition: 43, score: 79, total: 80 },
      { edition: 44, score: 76, total: 80 },
      { edition: 45, score: 80, total: 80 },
    ],
  },
  {
    name: "GPT 5.2",
    provider: "openai",
    accuracy: 95.4,
    score: 229,
    total: 240,
    cost: "$1.03",
    latency: "6.9s",
    note: "reasoning: medium",
    editions: [
      { edition: 43, score: 78, total: 80 },
      { edition: 44, score: 76, total: 80 },
      { edition: 45, score: 75, total: 80 },
    ],
  },
  {
    name: "Gemini 3.1 Pro",
    provider: "google",
    accuracy: 94.6,
    score: 227,
    total: 240,
    cost: "$1.57",
    latency: "12.5s",
    editions: [
      { edition: 43, score: 72, total: 80 },
      { edition: 44, score: 77, total: 80 },
      { edition: 45, score: 78, total: 80 },
    ],
  },
  {
    name: "Claude Opus 4.6",
    provider: "anthropic",
    accuracy: 91.7,
    score: 220,
    total: 240,
    cost: "$0.58",
    latency: "2.0s",
    editions: [
      { edition: 43, score: 75, total: 80 },
      { edition: 44, score: 73, total: 80 },
      { edition: 45, score: 72, total: 80 },
    ],
  },
  {
    name: "Gemini 3.1 Flash Lite",
    provider: "google",
    accuracy: 87.5,
    score: 210,
    total: 240,
    cost: "$0.02",
    latency: "2.2s",
    editions: [
      { edition: 43, score: 68, total: 80 },
      { edition: 44, score: 70, total: 80 },
      { edition: 45, score: 72, total: 80 },
    ],
  },
  {
    name: "Claude Sonnet 4.6",
    provider: "anthropic",
    accuracy: 86.7,
    score: 208,
    total: 240,
    cost: "$0.35",
    latency: "1.4s",
    editions: [
      { edition: 43, score: 75, total: 80 },
      { edition: 44, score: 67, total: 80 },
      { edition: 45, score: 66, total: 80 },
    ],
  },
  {
    name: "Grok 4.1 Fast",
    provider: "xai",
    accuracy: 85.0,
    score: 204,
    total: 240,
    cost: "$0.18",
    latency: "17.6s",
    editions: [
      { edition: 43, score: 70, total: 80 },
      { edition: 44, score: 66, total: 80 },
      { edition: 45, score: 68, total: 80 },
    ],
  },
  {
    name: "GPT-5 Mini",
    provider: "openai",
    accuracy: 78.3,
    score: 188,
    total: 240,
    cost: "$0.44",
    latency: "17.0s",
    editions: [
      { edition: 43, score: 63, total: 80 },
      { edition: 44, score: 61, total: 80 },
      { edition: 45, score: 64, total: 80 },
    ],
  },
  {
    name: "Claude Haiku 4.5",
    provider: "anthropic",
    accuracy: 76.3,
    score: 183,
    total: 240,
    cost: "$0.12",
    latency: "1.5s",
    editions: [
      { edition: 43, score: 66, total: 80 },
      { edition: 44, score: 62, total: 80 },
      { edition: 45, score: 55, total: 80 },
    ],
  },
  {
    name: "Gemini 2.5 Flash Lite",
    provider: "google",
    accuracy: 75.8,
    score: 182,
    total: 240,
    cost: "$0.01",
    latency: "1.0s",
    editions: [
      { edition: 43, score: 63, total: 80 },
      { edition: 44, score: 59, total: 80 },
      { edition: 45, score: 60, total: 80 },
    ],
  },
  {
    name: "DeepSeek V3.2",
    provider: "deepseek",
    accuracy: 73.3,
    score: 176,
    total: 240,
    cost: "$0.05",
    latency: "9.8s",
    editions: [
      { edition: 43, score: 63, total: 80 },
      { edition: 44, score: 52, total: 80 },
      { edition: 45, score: 61, total: 80 },
    ],
  },
];

const PROVIDER_COLORS: Record<string, { bar: string; label: string; dot: string }> = {
  google:    { bar: "bg-blue-500 dark:bg-blue-400",       label: "Google",    dot: "bg-blue-500" },
  openai:    { bar: "bg-emerald-500 dark:bg-emerald-400", label: "OpenAI",    dot: "bg-emerald-500" },
  anthropic: { bar: "bg-orange-500 dark:bg-orange-400",   label: "Anthropic", dot: "bg-orange-500" },
  xai:       { bar: "bg-rose-500 dark:bg-rose-400",       label: "xAI",       dot: "bg-rose-500" },
  deepseek:  { bar: "bg-violet-500 dark:bg-violet-400",   label: "DeepSeek",  dot: "bg-violet-500" },
};

function accuracyColor(acc: number): string {
  if (acc >= 90) return "text-emerald-600 dark:text-emerald-400";
  if (acc >= 80) return "text-amber-600 dark:text-amber-400";
  return "text-zinc-600 dark:text-zinc-400";
}

// ── Page ────────────────────────────────────────────────────────────────────

export default function Home() {
  const providers = [...new Set(MODELS.map((m) => m.provider))];

  return (
    <div className="min-h-screen bg-zinc-50 text-zinc-900 dark:bg-zinc-950 dark:text-zinc-100">
      <main className="mx-auto flex w-full max-w-5xl flex-col gap-14 px-6 py-14 sm:px-10">
        {/* ── A. Hero ──────────────────────────────────────────────────── */}
        <section className="space-y-5">
          <p className="inline-flex rounded-full bg-emerald-100 px-3 py-1 text-sm font-medium text-emerald-800 dark:bg-emerald-900/50 dark:text-emerald-200">
            Benchmark de IA para a OAB
          </p>
          <h1 className="text-4xl font-bold tracking-tight sm:text-5xl">
            OABench
          </h1>
          <p className="max-w-3xl text-lg text-zinc-700 dark:text-zinc-300">
            Avaliamos modelos de IA nas{" "}
            <strong>3 provas mais recentes</strong> da 1a fase da OAB para
            medir acurácia em múltiplas estratégias de resposta. Todos os
            modelos passariam no exame.
          </p>
          <p className="text-sm text-zinc-500 dark:text-zinc-400">
            Março 2026 · Protocolo direto · 240 questões · {MODELS.length}{" "}
            modelos
          </p>
        </section>

        {/* ── B. Stat cards ────────────────────────────────────────────── */}
        <section className="grid gap-4 sm:grid-cols-3">
          {[
            {
              value: String(MODELS.length),
              label: "Modelos avaliados",
              sub: `de ${providers.length} provedores`,
            },
            {
              value: `${MODELS[0].accuracy}%`,
              label: "Melhor acurácia",
              sub: MODELS[0].name,
            },
            {
              value: "240",
              label: "Questões por modelo",
              sub: "3 edições (43o, 44o, 45o)",
            },
          ].map((stat) => (
            <div
              key={stat.label}
              className="rounded-2xl border border-zinc-200 bg-white p-6 dark:border-zinc-800 dark:bg-zinc-900"
            >
              <p className="text-3xl font-bold">{stat.value}</p>
              <p className="mt-1 text-sm font-medium text-zinc-700 dark:text-zinc-300">
                {stat.label}
              </p>
              <p className="text-xs text-zinc-500 dark:text-zinc-400">
                {stat.sub}
              </p>
            </div>
          ))}
        </section>

        {/* ── C. Bar chart ─────────────────────────────────────────────── */}
        <section className="space-y-4">
          <h2 className="text-2xl font-semibold">Ranking por Acurácia</h2>

          <div className="rounded-2xl border border-zinc-200 bg-white p-6 dark:border-zinc-800 dark:bg-zinc-900">
            <div className="space-y-2.5">
              {MODELS.map((m, i) => (
                <div key={m.name} className="flex items-center gap-3">
                  {/* label */}
                  <span className="w-40 shrink-0 text-right sm:w-48">
                    <span className="block truncate text-sm font-medium">{m.name}</span>
                    {m.note && (
                      <span className="block text-[10px] text-zinc-400">
                        {m.note}
                      </span>
                    )}
                  </span>
                  {/* bar track */}
                  <div className="relative h-7 flex-1 overflow-hidden rounded bg-zinc-100 dark:bg-zinc-800">
                    {/* 50% threshold line */}
                    <div
                      className="absolute top-0 h-full w-px border-l border-dashed border-zinc-300 dark:border-zinc-600"
                      style={{ left: "50%" }}
                    />
                    {/* filled bar */}
                    <div
                      className={`h-full rounded ${PROVIDER_COLORS[m.provider].bar} transition-all`}
                      style={{ width: `${m.accuracy}%` }}
                    />
                  </div>
                  {/* accuracy label outside */}
                  <span className="w-14 shrink-0 text-right text-xs font-semibold tabular-nums">
                    {m.accuracy}%
                  </span>
                </div>
              ))}
            </div>

            {/* legend */}
            <div className="mt-5 flex flex-wrap items-center gap-x-5 gap-y-1 border-t border-zinc-100 pt-4 text-xs text-zinc-500 dark:border-zinc-800 dark:text-zinc-400">
              {providers.map((p) => (
                <span key={p} className="flex items-center gap-1.5">
                  <span
                    className={`inline-block h-2.5 w-2.5 rounded-full ${PROVIDER_COLORS[p].dot}`}
                  />
                  {PROVIDER_COLORS[p].label}
                </span>
              ))}
              <span className="ml-auto text-[10px] text-zinc-400">
                Linha tracejada = 50% (nota de corte OAB)
              </span>
            </div>
          </div>
        </section>

        {/* ── D. Leaderboard table ─────────────────────────────────────── */}
        <section className="space-y-4">
          <h2 className="text-2xl font-semibold">Leaderboard Completo</h2>

          <div className="overflow-x-auto rounded-2xl border border-zinc-200 dark:border-zinc-800">
            <table className="w-full border-collapse text-left text-sm">
              <thead className="bg-zinc-100 text-zinc-600 dark:bg-zinc-900 dark:text-zinc-400">
                <tr>
                  <th className="px-4 py-3 text-center font-semibold">#</th>
                  <th className="px-4 py-3 font-semibold">Modelo</th>
                  <th className="px-4 py-3 text-center font-semibold">
                    43o Exame
                  </th>
                  <th className="px-4 py-3 text-center font-semibold">
                    44o Exame
                  </th>
                  <th className="px-4 py-3 text-center font-semibold">
                    45o Exame
                  </th>
                  <th className="px-4 py-3 text-center font-semibold">
                    Total
                  </th>
                  <th className="px-4 py-3 text-right font-semibold">Custo</th>
                  <th className="px-4 py-3 text-right font-semibold">
                    Latência
                  </th>
                </tr>
              </thead>
              <tbody className="bg-white dark:bg-zinc-950">
                {MODELS.map((m, i) => (
                  <tr
                    key={m.name}
                    className={`border-t border-zinc-100 dark:border-zinc-800 ${
                      i === 0
                        ? "bg-emerald-50/60 dark:bg-emerald-950/20"
                        : "hover:bg-zinc-50 dark:hover:bg-zinc-900/50"
                    }`}
                  >
                    <td className="px-4 py-3 text-center font-medium text-zinc-400">
                      {i + 1}
                    </td>
                    <td className="whitespace-nowrap px-4 py-3 font-medium">
                      <span className="flex items-center gap-2">
                        <span
                          className={`inline-block h-2 w-2 rounded-full ${PROVIDER_COLORS[m.provider].dot}`}
                        />
                        <span className="flex flex-col">
                          <span>{m.name}</span>
                          {m.note && (
                            <span className="text-[10px] font-normal text-zinc-500 dark:text-zinc-400">
                              {m.note}
                            </span>
                          )}
                        </span>
                      </span>
                    </td>
                    {m.editions.map((e) => (
                      <td
                        key={e.edition}
                        className={`px-4 py-3 text-center tabular-nums ${accuracyColor((e.score / e.total) * 100)}`}
                      >
                        {e.score}/{e.total}
                      </td>
                    ))}
                    <td
                      className={`px-4 py-3 text-center font-semibold tabular-nums ${accuracyColor(m.accuracy)}`}
                    >
                      {m.score}/{m.total}{" "}
                      <span className="text-xs font-normal">
                        ({m.accuracy}%)
                      </span>
                    </td>
                    <td className="px-4 py-3 text-right tabular-nums text-zinc-600 dark:text-zinc-400">
                      {m.cost}
                    </td>
                    <td className="px-4 py-3 text-right tabular-nums text-zinc-600 dark:text-zinc-400">
                      {m.latency}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <p className="text-xs text-zinc-500 dark:text-zinc-400">
            Custo estimado via OpenRouter. Latência média por questão. Todos os
            modelos usaram protocolo direto (resposta = apenas a letra) com
            temperatura 0.
          </p>
        </section>

        {/* ── E. Methodology ───────────────────────────────────────────── */}
        <hr className="border-zinc-200 dark:border-zinc-800" />

        <section className="space-y-8">
          <h2 className="text-2xl font-semibold">Metodologia</h2>

          <div className="grid gap-4 rounded-2xl border border-zinc-200 bg-white p-6 dark:border-zinc-800 dark:bg-zinc-900 sm:grid-cols-2">
            <article className="rounded-xl bg-zinc-100 p-4 dark:bg-zinc-800/60">
              <h3 className="text-sm font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
                Escopo
              </h3>
              <p className="mt-2">
                Questões objetivas das últimas 3 edições da 1a fase da OAB.
              </p>
            </article>
            <article className="rounded-xl bg-zinc-100 p-4 dark:bg-zinc-800/60">
              <h3 className="text-sm font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
                Métrica principal
              </h3>
              <p className="mt-2">
                <strong>Taxa de acerto</strong> = questões corretas / total de
                questões.
              </p>
            </article>
          </div>

          <div className="space-y-3 rounded-2xl border border-zinc-200 bg-white p-6 dark:border-zinc-800 dark:bg-zinc-900">
            <h3 className="text-xl font-semibold">
              Como o benchmark é calculado
            </h3>
            <ol className="list-decimal space-y-2 pl-5 text-zinc-700 dark:text-zinc-300">
              <li>
                Rodamos cada modelo nas 3 provas, para cada combinação da
                matriz.
              </li>
              <li>
                Extraímos a alternativa final (A, B, C ou D) por questão.
              </li>
              <li>Comparamos com o gabarito oficial da OAB.</li>
              <li>Agregamos os acertos por prova, cenário e modelo.</li>
            </ol>
            <p className="text-sm text-zinc-600 dark:text-zinc-400">
              Detalhes operacionais completos em{" "}
              <code className="rounded bg-zinc-100 px-1.5 py-0.5 text-xs dark:bg-zinc-800">
                BENCHMARK_PIPELINE.md
              </code>
              .
            </p>
          </div>
        </section>
      </main>
    </div>
  );
}
