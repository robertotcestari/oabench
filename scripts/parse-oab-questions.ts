import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const TOTAL_QUESTIONS = 80;
const PIPELINE_VERSION = "extractor-1.0.0";

type DownloadedFile = {
  url: string;
  label: string;
  localPath: string;
};

type DownloadedExam = {
  examId: string;
  examName: string;
  examPageUrl: string;
  prova: DownloadedFile;
  gabarito: DownloadedFile;
};

type LatestRun = {
  runId: string;
  ranAt: string;
  selectedExams: DownloadedExam[];
};

type ParsedChoice = {
  label: "A" | "B" | "C" | "D";
  text: string;
};

type ParsedQuestion = {
  number: number;
  stem: string;
  choices: ParsedChoice[];
};

type OutputQuestion = {
  schema_version: "1.0";
  qid: string;
  exam: {
    program: "OAB";
    edition: number;
    phase: 1;
    date: string;
    organizer: string;
  };
  number: number;
  language: "pt-BR";
  area: null;
  stem: string;
  choices: ParsedChoice[];
  modality: {
    requires_image: boolean;
    assets: Array<{
      id: string;
      type: "image" | "table" | "pdf_crop";
      sha256: string;
      page?: number | null;
      bbox?: [number, number, number, number] | null;
    }>;
  };
  source: {
    prova: {
      url: string;
      sha256: string;
      pages: number[];
    };
    gabarito: {
      url: string;
      sha256: string;
      kind: "preliminar" | "definitivo";
    };
  };
  status: {
    question: "active" | "annulled" | "dropped";
  };
  extraction: {
    pipeline_version: string;
    extracted_at: string;
  };
};

type AnswerKeyEntry = {
  qid: string;
  correct: "A" | "B" | "C" | "D" | null;
  status: "definitivo" | "preliminar" | "anulada";
};

const IGNORED_LINE_PATTERNS = [
  /^Tipo Branca/i,
  /^EXAME DO ORDEM UNIFICADO$/i,
  /^[0-9]+o EXAME DO ORDEM UNIFICADO$/i,
  /^Ordem dos Advogados do Brasil$/i,
  /^Realização$/i,
];

function toPosix(filePath: string): string {
  return filePath.split(path.sep).join("/");
}

async function runCommand(command: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync(command, args, {
    maxBuffer: 1024 * 1024 * 64,
  });

  return stdout;
}

async function extractPdfTextRaw(pdfPath: string, page?: number): Promise<string> {
  const args = page
    ? ["-raw", "-f", String(page), "-l", String(page), pdfPath, "-"]
    : ["-raw", pdfPath, "-"];
  return runCommand("pdftotext", args);
}

async function extractPdfPageCount(pdfPath: string): Promise<number> {
  const output = await runCommand("pdfinfo", [pdfPath]);
  const match = output.match(/Pages:\s+(\d+)/i);
  if (!match) {
    throw new Error(`Nao foi possivel obter total de paginas de ${pdfPath}.`);
  }
  return Number.parseInt(match[1], 10);
}

async function sha256File(filePath: string): Promise<string> {
  const content = await readFile(filePath);
  return createHash("sha256").update(content).digest("hex");
}

function normalizeLine(line: string): string {
  return line.replace(/\s+/g, " ").trim();
}

function normalizeMultilineText(lines: string[]): string {
  return lines
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .join("\n")
    .trim();
}

function normalizePdfLines(rawText: string): string[] {
  return rawText
    .replace(/\r/g, "\n")
    .replace(/\f/g, "\n")
    .split("\n")
    .map(normalizeLine)
    .filter(
      (line) =>
        line.length > 0 &&
        !IGNORED_LINE_PATTERNS.some((pattern) => pattern.test(line)),
    );
}

function isQuestionStartAt(lines: string[], index: number, questionNumber: number): boolean {
  if (lines[index] !== String(questionNumber)) {
    return false;
  }

  const maxLookahead = Math.min(lines.length - 1, index + 220);
  let hasA = false;
  let hasD = false;

  for (let i = index + 1; i <= maxLookahead; i += 1) {
    const line = lines[i];
    if (/^\(A\)\s*/.test(line)) {
      hasA = true;
    }
    if (/^\(D\)\s*/.test(line)) {
      hasD = true;
    }
    if (hasA && hasD) {
      return true;
    }
  }

  return false;
}

function findQuestionStartIndices(lines: string[]): Map<number, number> {
  const starts = new Map<number, number>();
  let cursor = 0;

  for (let question = 1; question <= TOTAL_QUESTIONS; question += 1) {
    let foundIndex = -1;

    for (let i = cursor; i < lines.length; i += 1) {
      if (isQuestionStartAt(lines, i, question)) {
        foundIndex = i;
        break;
      }
    }

    if (foundIndex < 0) {
      throw new Error(`Nao foi possivel localizar o inicio da questao ${question}.`);
    }

    starts.set(question, foundIndex);
    cursor = foundIndex + 1;
  }

  return starts;
}

function parseQuestionBlock(questionNumber: number, blockLines: string[]): ParsedQuestion {
  const indexA = blockLines.findIndex((line) => /^\(A\)\s*/.test(line));
  const indexB = blockLines.findIndex((line) => /^\(B\)\s*/.test(line));
  const indexC = blockLines.findIndex((line) => /^\(C\)\s*/.test(line));
  const indexD = blockLines.findIndex((line) => /^\(D\)\s*/.test(line));

  if (
    indexA < 0 ||
    indexB < 0 ||
    indexC < 0 ||
    indexD < 0 ||
    !(indexA < indexB && indexB < indexC && indexC < indexD)
  ) {
    throw new Error(`Nao foi possivel parsear alternativas da questao ${questionNumber}.`);
  }

  const stem = normalizeMultilineText(blockLines.slice(0, indexA));

  const choiceA = normalizeMultilineText([
    blockLines[indexA].replace(/^\(A\)\s*/, ""),
    ...blockLines.slice(indexA + 1, indexB),
  ]);
  const choiceB = normalizeMultilineText([
    blockLines[indexB].replace(/^\(B\)\s*/, ""),
    ...blockLines.slice(indexB + 1, indexC),
  ]);
  const choiceC = normalizeMultilineText([
    blockLines[indexC].replace(/^\(C\)\s*/, ""),
    ...blockLines.slice(indexC + 1, indexD),
  ]);
  const choiceD = normalizeMultilineText([
    blockLines[indexD].replace(/^\(D\)\s*/, ""),
    ...blockLines.slice(indexD + 1),
  ]);

  if (!stem || !choiceA || !choiceB || !choiceC || !choiceD) {
    throw new Error(`Questao ${questionNumber} com texto vazio apos parse.`);
  }

  return {
    number: questionNumber,
    stem,
    choices: [
      { label: "A", text: choiceA },
      { label: "B", text: choiceB },
      { label: "C", text: choiceC },
      { label: "D", text: choiceD },
    ],
  };
}

function parseQuestionsFromProvaText(rawText: string): ParsedQuestion[] {
  const lines = normalizePdfLines(rawText);
  const startIndices = findQuestionStartIndices(lines);
  const questionnaireIndex = lines.findIndex((line) =>
    /Question[áa]rio de percep/i.test(line),
  );

  const questions: ParsedQuestion[] = [];

  for (let question = 1; question <= TOTAL_QUESTIONS; question += 1) {
    const start = startIndices.get(question);
    if (start === undefined) {
      throw new Error(`Indice de inicio ausente para questao ${question}.`);
    }

    const nextStart = startIndices.get(question + 1);
    const endExclusive =
      nextStart !== undefined
        ? nextStart
        : questionnaireIndex > start
          ? questionnaireIndex
          : lines.length;
    const blockLines = lines.slice(start + 1, endExclusive);

    questions.push(parseQuestionBlock(question, blockLines));
  }

  return questions;
}

function parseDateFromLabel(label: string): string {
  const match = label.match(/(\d{2})\/(\d{2})\/(\d{4})/);
  if (!match) {
    throw new Error(`Nao foi possivel extrair data da label: ${label}`);
  }
  const [, day, month, year] = match;
  return `${year}-${month}-${day}`;
}

function parseEditionFromExamName(examName: string): number {
  const match = examName.match(/^(\d+)/);
  if (!match) {
    throw new Error(`Nao foi possivel extrair edicao do exame: ${examName}`);
  }
  return Number.parseInt(match[1], 10);
}

function parseGabaritoKind(label: string): "preliminar" | "definitivo" {
  return /preliminar/i.test(label) ? "preliminar" : "definitivo";
}

function parseGabaritoAnswers(rawText: string): Map<number, "A" | "B" | "C" | "D" | null> {
  const sectionMatch = rawText.match(
    /PROVA TIPO 1([\s\S]*?)(?:PROVA TIPO 2|TABELA DE CORRESPOND[ÊE]NCIA|$)/i,
  );

  if (!sectionMatch) {
    throw new Error("Nao foi possivel localizar secao PROVA TIPO 1 no gabarito.");
  }

  const section = sectionMatch[1].replace(/\f/g, "\n");
  const answers = new Map<number, "A" | "B" | "C" | "D" | null>();
  const lines = section
    .split("\n")
    .map(normalizeLine)
    .filter(Boolean);

  let pendingNumbers: number[] | null = null;

  for (const line of lines) {
    const tokens = line.split(/\s+/).filter(Boolean);
    const numbers = tokens
      .filter((token) => /^\d{1,2}$/.test(token))
      .map((token) => Number.parseInt(token, 10))
      .filter((value) => value >= 1 && value <= TOTAL_QUESTIONS);
    const letters = tokens
      .filter((token) => /^[ABCD\*]$/i.test(token))
      .map((token) => token.toUpperCase());

    if (numbers.length >= 10 && letters.length === 0) {
      pendingNumbers = numbers;
      continue;
    }

    if (
      pendingNumbers &&
      letters.length === pendingNumbers.length &&
      pendingNumbers.length > 0
    ) {
      pendingNumbers.forEach((question, index) => {
        const value = letters[index];
        answers.set(question, value === "*" ? null : (value as "A" | "B" | "C" | "D"));
      });
      pendingNumbers = null;
    }
  }

  const allTokens = section.replace(/\s+/g, " ").trim().split(" ");
  for (let index = 0; index < allTokens.length - 1; index += 1) {
    const current = allTokens[index];
    const next = allTokens[index + 1];
    if (!/^\d{1,2}$/.test(current) || !/^[ABCD\*]$/i.test(next)) {
      continue;
    }

    const question = Number.parseInt(current, 10);
    if (question < 1 || question > TOTAL_QUESTIONS || answers.has(question)) {
      continue;
    }

    answers.set(
      question,
      next === "*" ? null : (next.toUpperCase() as "A" | "B" | "C" | "D"),
    );
  }

  if (answers.size !== TOTAL_QUESTIONS) {
    throw new Error(
      `Gabarito incompleto: ${answers.size}/${TOTAL_QUESTIONS} respostas encontradas.`,
    );
  }

  return answers;
}

function detectRequiresImage(question: ParsedQuestion): boolean {
  const text = `${question.stem}\n${question.choices.map((choice) => choice.text).join("\n")}`;
  return /(figura|imagem|gr[áa]fico|tabela|mapa|charge|ilustra[çc][ãa]o|quadrinho)/i.test(
    text,
  );
}

function buildAnswerKey(
  edition: number,
  gabaritoKind: "preliminar" | "definitivo",
  answers: Map<number, "A" | "B" | "C" | "D" | null>,
): AnswerKeyEntry[] {
  const output: AnswerKeyEntry[] = [];

  for (let question = 1; question <= TOTAL_QUESTIONS; question += 1) {
    const answer = answers.get(question);
    if (answer === undefined) {
      throw new Error(`Resposta ausente para questao ${question}.`);
    }

    output.push({
      qid: `oab-${edition}-1f-q${question}`,
      correct: answer,
      status: answer === null ? "anulada" : gabaritoKind,
    });
  }

  return output;
}

async function mapQuestionStartPage(provaPath: string): Promise<Map<number, number>> {
  const pageCount = await extractPdfPageCount(provaPath);
  const pageTexts: string[] = [];

  for (let page = 1; page <= pageCount; page += 1) {
    pageTexts[page] = await extractPdfTextRaw(provaPath, page);
  }

  const mapping = new Map<number, number>();
  let pageCursor = 1;

  for (let question = 1; question <= TOTAL_QUESTIONS; question += 1) {
    let foundPage: number | null = null;

    for (let page = pageCursor; page <= pageCount; page += 1) {
      const lines = normalizePdfLines(pageTexts[page]);
      const index = lines.findIndex((line) => line === String(question));
      if (index < 0) {
        continue;
      }

      if (isQuestionStartAt(lines, index, question)) {
        foundPage = page;
        break;
      }
    }

    if (foundPage === null) {
      foundPage = pageCursor;
    }

    mapping.set(question, foundPage);
    pageCursor = foundPage;
  }

  return mapping;
}

async function main(): Promise<void> {
  const workspaceRoot = process.cwd();
  const latestRunPath = path.resolve(workspaceRoot, "data", "oab", "latest-run.json");
  const latestRunContent = await readFile(latestRunPath, "utf-8");
  const latestRun = JSON.parse(latestRunContent) as LatestRun;

  if (!latestRun.selectedExams || latestRun.selectedExams.length === 0) {
    throw new Error("latest-run.json nao possui selectedExams.");
  }

  const extractedAt = new Date().toISOString();
  console.log("Iniciando parser das provas da OAB...");

  for (const exam of latestRun.selectedExams) {
    const provaPath = path.resolve(workspaceRoot, exam.prova.localPath);
    const gabaritoPath = path.resolve(workspaceRoot, exam.gabarito.localPath);
    const outputDir = path.dirname(provaPath);

    console.log(`Processando ${exam.examName} (${exam.examId})...`);

    const [provaSha, gabaritoSha, provaRawText, gabaritoRawText, pageMap] =
      await Promise.all([
        sha256File(provaPath),
        sha256File(gabaritoPath),
        extractPdfTextRaw(provaPath),
        extractPdfTextRaw(gabaritoPath),
        mapQuestionStartPage(provaPath),
      ]);

    const parsedQuestions = parseQuestionsFromProvaText(provaRawText);
    const gabaritoAnswers = parseGabaritoAnswers(gabaritoRawText);
    const gabaritoKind = parseGabaritoKind(exam.gabarito.label);
    const edition = parseEditionFromExamName(exam.examName);
    const examDate = parseDateFromLabel(exam.prova.label);

    if (parsedQuestions.length !== TOTAL_QUESTIONS) {
      throw new Error(
        `${exam.examId}: esperadas ${TOTAL_QUESTIONS} questoes, encontradas ${parsedQuestions.length}.`,
      );
    }

    const outputQuestions: OutputQuestion[] = parsedQuestions.map((question) => {
      const qid = `oab-${edition}-1f-q${question.number}`;
      const answer = gabaritoAnswers.get(question.number);
      if (answer === undefined) {
        throw new Error(`Resposta ausente para ${qid}.`);
      }

      const page = pageMap.get(question.number) ?? 0;

      return {
        schema_version: "1.0",
        qid,
        exam: {
          program: "OAB",
          edition,
          phase: 1,
          date: examDate,
          organizer: "FGV",
        },
        number: question.number,
        language: "pt-BR",
        area: null,
        stem: question.stem,
        choices: question.choices,
        modality: {
          requires_image: detectRequiresImage(question),
          assets: [],
        },
        source: {
          prova: {
            url: exam.prova.url,
            sha256: provaSha,
            pages: [page],
          },
          gabarito: {
            url: exam.gabarito.url,
            sha256: gabaritoSha,
            kind: gabaritoKind,
          },
        },
        status: {
          question: answer === null ? "annulled" : "active",
        },
        extraction: {
          pipeline_version: PIPELINE_VERSION,
          extracted_at: extractedAt,
        },
      };
    });

    const answerKey = buildAnswerKey(edition, gabaritoKind, gabaritoAnswers);
    const questionsPath = path.join(outputDir, "questions.json");
    const answerKeyPath = path.join(outputDir, "answer_key.json");

    await writeFile(questionsPath, `${JSON.stringify(outputQuestions, null, 2)}\n`);
    await writeFile(answerKeyPath, `${JSON.stringify(answerKey, null, 2)}\n`);

    console.log(
      `  - Gerados: ${toPosix(path.relative(workspaceRoot, questionsPath))} e ${toPosix(path.relative(workspaceRoot, answerKeyPath))}`,
    );
  }

  console.log("Parser concluido com sucesso.");
}

main().catch((error: unknown) => {
  const message =
    error instanceof Error ? error.message : "Erro desconhecido no parser de provas.";
  console.error(message);
  process.exit(1);
});
