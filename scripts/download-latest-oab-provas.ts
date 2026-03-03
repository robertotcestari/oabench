import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";

const BASE_URL = "https://examedeordem.oab.org.br";
const EXAMS_LIST_URL = `${BASE_URL}/EditaisProvas?NumeroExame=0`;
const TARGET_COUNT = 3;
const OUTPUT_ROOT = path.resolve(process.cwd(), "data", "oab");
const EXAMS_DIR = path.join(OUTPUT_ROOT, "exams");
const RUNS_DIR = path.join(OUTPUT_ROOT, "runs");

type ExamOption = {
  examId: string;
  examName: string;
  pageUrl: string;
};

type PdfLink = {
  url: string;
  label: string;
};

type DownloadedFile = {
  url: string;
  label: string;
  localPath: string;
  bytes: number;
};

type DownloadedExam = {
  examId: string;
  examName: string;
  examPageUrl: string;
  prova: DownloadedFile;
  gabarito: DownloadedFile;
};

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&#(\d+);/g, (_, decimal: string) =>
      String.fromCodePoint(Number.parseInt(decimal, 10)),
    )
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex: string) =>
      String.fromCodePoint(Number.parseInt(hex, 16)),
    )
    .replace(/&([a-zA-Z]+);/g, (fullMatch: string, name: string) => {
      return NAMED_ENTITIES[name] ?? fullMatch;
    });
}

function stripTags(value: string): string {
  return decodeHtmlEntities(value.replace(/<[^>]*>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
}

function slugify(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function toPosix(filePath: string): string {
  return filePath.split(path.sep).join("/");
}

function parseExamOptions(listPageHtml: string): ExamOption[] {
  const selectMatch = listPageHtml.match(
    /<select[^>]*id="cmb-edital"[\s\S]*?<\/select>/i,
  );

  if (!selectMatch) {
    throw new Error("Nao foi possivel localizar o seletor de exames no HTML.");
  }

  const options: ExamOption[] = [];
  const optionRegex = /<option\s+value="(\d+)"[^>]*>([\s\S]*?)<\/option>/gi;

  for (
    let optionMatch = optionRegex.exec(selectMatch[0]);
    optionMatch;
    optionMatch = optionRegex.exec(selectMatch[0])
  ) {
    const examId = optionMatch[1];

    if (examId === "0") {
      continue;
    }

    const examName = stripTags(optionMatch[2]);
    options.push({
      examId,
      examName,
      pageUrl: `${BASE_URL}/EditaisProvas?NumeroExame=${examId}`,
    });
  }

  return options;
}

function scorePdfLabel(label: string): number {
  const normalized = label.toLowerCase();
  let score = 0;

  if (/caderno de prova/.test(normalized)) {
    score += 80;
  }
  if (/tipo\s*1/.test(normalized)) {
    score += 60;
  }
  if (/prova objetiva/.test(normalized)) {
    score += 40;
  }
  if (/gabarito/.test(normalized)) {
    score -= 120;
  }
  if (/resultado|edital|comunicado|padr[aã]o de respostas/.test(normalized)) {
    score -= 200;
  }

  return score;
}

function scoreGabaritoLabel(label: string): number {
  const normalized = label.toLowerCase();
  let score = 0;

  if (/gabarito/.test(normalized)) {
    score += 120;
  }
  if (/definitiv/.test(normalized)) {
    score += 50;
  }
  if (/preliminar/.test(normalized)) {
    score += 20;
  }
  if (/prova objetiva/.test(normalized)) {
    score += 20;
  }
  if (/caderno de prova/.test(normalized)) {
    score -= 90;
  }
  if (/resultado|edital|comunicado|padr[aã]o de respostas/.test(normalized)) {
    score -= 200;
  }

  return score;
}

function pickFirstPhaseFiles(examPageHtml: string): {
  prova: PdfLink | null;
  gabarito: PdfLink | null;
} {
  const tableRegex =
    /<table[^>]*>[\s\S]*?<th>\s*([\s\S]*?)\s*<\/th>[\s\S]*?<tbody>([\s\S]*?)<\/tbody>[\s\S]*?<\/table>/gi;

  for (
    let tableMatch = tableRegex.exec(examPageHtml);
    tableMatch;
    tableMatch = tableRegex.exec(examPageHtml)
  ) {
    const heading = stripTags(tableMatch[1]).toLowerCase();
    const isFirstPhaseObjectiveSection =
      /1.? fase/.test(heading) && /prova objetiva/.test(heading);

    if (!isFirstPhaseObjectiveSection) {
      continue;
    }

    const links: PdfLink[] = [];
    const linkRegex = /<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;

    for (
      let linkMatch = linkRegex.exec(tableMatch[2]);
      linkMatch;
      linkMatch = linkRegex.exec(tableMatch[2])
    ) {
      const href = decodeHtmlEntities(linkMatch[1]);
      if (!href.toLowerCase().endsWith(".pdf")) {
        continue;
      }

      const label = stripTags(linkMatch[2]);
      links.push({
        url: new URL(href, BASE_URL).toString(),
        label,
      });
    }

    if (links.length === 0) {
      return { prova: null, gabarito: null };
    }

    const rankedProvas = [...links].sort(
      (a, b) => scorePdfLabel(b.label) - scorePdfLabel(a.label),
    );
    const rankedGabaritos = [...links].sort(
      (a, b) => scoreGabaritoLabel(b.label) - scoreGabaritoLabel(a.label),
    );

    const bestProva =
      scorePdfLabel(rankedProvas[0].label) > 0 ? rankedProvas[0] : null;
    const bestGabarito =
      scoreGabaritoLabel(rankedGabaritos[0].label) > 0
        ? rankedGabaritos[0]
        : null;

    return { prova: bestProva, gabarito: bestGabarito };
  }

  return { prova: null, gabarito: null };
}

async function fetchHtml(url: string): Promise<string> {
  const response = await fetch(url, {
    headers: {
      "user-agent": "oabench-downloader/1.0",
    },
  });

  if (!response.ok) {
    throw new Error(`Falha ao buscar ${url} (HTTP ${response.status}).`);
  }

  return response.text();
}

async function downloadPdf(url: string, destination: string): Promise<number> {
  const response = await fetch(url, {
    headers: {
      "user-agent": "oabench-downloader/1.0",
    },
  });

  if (!response.ok) {
    throw new Error(`Falha ao baixar PDF ${url} (HTTP ${response.status}).`);
  }

  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength === 0) {
    throw new Error(`PDF vazio em ${url}.`);
  }

  await mkdir(path.dirname(destination), { recursive: true });
  await writeFile(destination, bytes);

  return bytes.byteLength;
}

async function main(): Promise<void> {
  const startedAt = new Date();
  console.log(
    "Baixando as 3 provas objetivas mais recentes da OAB que tenham gabarito...",
  );

  const listPageHtml = await fetchHtml(EXAMS_LIST_URL);
  const examOptions = parseExamOptions(listPageHtml);

  if (examOptions.length === 0) {
    throw new Error("Nenhum exame foi encontrado na pagina principal.");
  }

  await mkdir(RUNS_DIR, { recursive: true });
  await rm(EXAMS_DIR, { recursive: true, force: true });
  await mkdir(EXAMS_DIR, { recursive: true });

  const downloadedExams: DownloadedExam[] = [];

  for (const exam of examOptions) {
    if (downloadedExams.length >= TARGET_COUNT) {
      break;
    }

    console.log(`Analisando ${exam.examName} (${exam.examId})...`);
    const examPageHtml = await fetchHtml(exam.pageUrl);
    const selectedFiles = pickFirstPhaseFiles(examPageHtml);

    if (!selectedFiles.prova || !selectedFiles.gabarito) {
      console.log("  - Sem prova+gabarito da 1a fase. Pulando.");
      continue;
    }

    const examFolder = `${exam.examId}-${slugify(exam.examName)}`;
    const provaRelativePath = path.join(
      "data",
      "oab",
      "exams",
      examFolder,
      "prova-objetiva-tipo1.pdf",
    );
    const gabaritoRelativePath = path.join(
      "data",
      "oab",
      "exams",
      examFolder,
      "gabarito.pdf",
    );
    const provaAbsolutePath = path.resolve(process.cwd(), provaRelativePath);
    const gabaritoAbsolutePath = path.resolve(process.cwd(), gabaritoRelativePath);
    const provaBytes = await downloadPdf(selectedFiles.prova.url, provaAbsolutePath);
    const gabaritoBytes = await downloadPdf(
      selectedFiles.gabarito.url,
      gabaritoAbsolutePath,
    );

    downloadedExams.push({
      examId: exam.examId,
      examName: exam.examName,
      examPageUrl: exam.pageUrl,
      prova: {
        url: selectedFiles.prova.url,
        label: selectedFiles.prova.label,
        localPath: toPosix(provaRelativePath),
        bytes: provaBytes,
      },
      gabarito: {
        url: selectedFiles.gabarito.url,
        label: selectedFiles.gabarito.label,
        localPath: toPosix(gabaritoRelativePath),
        bytes: gabaritoBytes,
      },
    });

    console.log(`  - Baixados: ${provaRelativePath} + ${gabaritoRelativePath}`);
  }

  if (downloadedExams.length < TARGET_COUNT) {
    throw new Error(
      `Foram encontrados ${downloadedExams.length} exames com prova+gabarito; o minimo esperado e ${TARGET_COUNT}.`,
    );
  }

  const runId = startedAt.toISOString().replace(/[:.]/g, "-");
  const runMetadata = {
    runId,
    ranAt: startedAt.toISOString(),
    source: EXAMS_LIST_URL,
    selectedExams: downloadedExams,
  };

  const runMetadataPath = path.join(RUNS_DIR, `run-${runId}.json`);
  const latestMetadataPath = path.join(OUTPUT_ROOT, "latest-run.json");

  await writeFile(runMetadataPath, `${JSON.stringify(runMetadata, null, 2)}\n`);
  await writeFile(latestMetadataPath, `${JSON.stringify(runMetadata, null, 2)}\n`);

  console.log("Concluido com sucesso.");
  console.log(`Metadata do run: ${toPosix(path.relative(process.cwd(), runMetadataPath))}`);
}

main().catch((error: unknown) => {
  const message =
    error instanceof Error ? error.message : "Erro desconhecido durante o download.";
  console.error(message);
  process.exit(1);
});
