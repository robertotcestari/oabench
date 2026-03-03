import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const TOTAL_QUESTIONS = 80;
const QID_PATTERN = /^oab-(\d+)-1f-q(\d+)$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/i;
const VALIDATOR_VERSION = "validator-1.1.0";

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
  source: string;
  selectedExams: DownloadedExam[];
};

type ValidationContext = {
  errors: string[];
  warnings: string[];
};

type ExamValidationSummary = {
  exam_id: string;
  exam_name: string;
  exam_folder: string;
  questions_count: number;
  answer_key_count: number;
  annulled_count: number;
  error_count: number;
  warning_count: number;
  errors: string[];
  warnings: string[];
};

type QuestionRecord = Record<string, unknown>;
type AnswerKeyRecord = Record<string, unknown>;

function pushError(ctx: ValidationContext, message: string): void {
  ctx.errors.push(message);
}

function pushWarning(ctx: ValidationContext, message: string): void {
  ctx.warnings.push(message);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function isIsoDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return false;
  }
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().startsWith(value);
}

async function sha256File(filePath: string): Promise<string> {
  const content = await readFile(filePath);
  return createHash("sha256").update(content).digest("hex");
}

function parseQid(qid: string): { edition: number; number: number } | null {
  const match = qid.match(QID_PATTERN);
  if (!match) {
    return null;
  }

  return {
    edition: Number.parseInt(match[1], 10),
    number: Number.parseInt(match[2], 10),
  };
}

function validateChoice(
  choice: unknown,
  expectedLabel: "A" | "B" | "C" | "D",
  pathPrefix: string,
  ctx: ValidationContext,
): void {
  if (!isObject(choice)) {
    pushError(ctx, `${pathPrefix} precisa ser objeto.`);
    return;
  }

  const label = asString(choice.label);
  const text = asString(choice.text);

  if (label !== expectedLabel) {
    pushError(ctx, `${pathPrefix}.label deve ser "${expectedLabel}".`);
  }
  if (!text || text.trim().length === 0) {
    pushError(ctx, `${pathPrefix}.text deve ser string nao vazia.`);
  }
}

function validateQuestion(
  question: unknown,
  index: number,
  expectedEdition: number,
  examDate: string,
  ctx: ValidationContext,
): QuestionRecord | null {
  const prefix = `questions[${index}]`;
  if (!isObject(question)) {
    pushError(ctx, `${prefix} precisa ser objeto.`);
    return null;
  }

  const schemaVersion = asString(question.schema_version);
  const qid = asString(question.qid);
  const number = asNumber(question.number);
  const language = asString(question.language);
  const stem = asString(question.stem);

  if (schemaVersion !== "1.0") {
    pushError(ctx, `${prefix}.schema_version deve ser "1.0".`);
  }

  const parsedQid = qid ? parseQid(qid) : null;
  if (!parsedQid) {
    pushError(ctx, `${prefix}.qid invalido.`);
  }

  if (!Number.isInteger(number) || (number ?? 0) < 1 || (number ?? 0) > TOTAL_QUESTIONS) {
    pushError(ctx, `${prefix}.number deve estar entre 1 e ${TOTAL_QUESTIONS}.`);
  }

  if (parsedQid && number !== parsedQid.number) {
    pushError(ctx, `${prefix}.number difere do numero do qid.`);
  }

  if (language !== "pt-BR") {
    pushError(ctx, `${prefix}.language deve ser "pt-BR".`);
  }

  if (!stem || stem.trim().length === 0) {
    pushError(ctx, `${prefix}.stem deve ser nao vazio.`);
  }

  if (!("area" in question) || !(typeof question.area === "string" || question.area === null)) {
    pushError(ctx, `${prefix}.area deve ser string ou null.`);
  }

  const exam = question.exam;
  if (!isObject(exam)) {
    pushError(ctx, `${prefix}.exam precisa ser objeto.`);
  } else {
    if (exam.program !== "OAB") {
      pushError(ctx, `${prefix}.exam.program deve ser "OAB".`);
    }
    if (exam.phase !== 1) {
      pushError(ctx, `${prefix}.exam.phase deve ser 1.`);
    }
    if (asString(exam.organizer)?.trim().length === 0) {
      pushError(ctx, `${prefix}.exam.organizer deve ser nao vazio.`);
    }

    const edition = asNumber(exam.edition);
    if (!Number.isInteger(edition) || (edition ?? 0) < 1) {
      pushError(ctx, `${prefix}.exam.edition invalido.`);
    } else {
      if (edition !== expectedEdition) {
        pushError(ctx, `${prefix}.exam.edition difere do exame esperado.`);
      }
      if (parsedQid && parsedQid.edition !== edition) {
        pushError(ctx, `${prefix}.qid difere de exam.edition.`);
      }
    }

    const date = asString(exam.date);
    if (!date || !isIsoDate(date)) {
      pushError(ctx, `${prefix}.exam.date invalida (YYYY-MM-DD).`);
    } else if (date !== examDate) {
      pushWarning(ctx, `${prefix}.exam.date (${date}) difere da data da prova (${examDate}).`);
    }
  }

  const choices = question.choices;
  if (!Array.isArray(choices) || choices.length !== 4) {
    pushError(ctx, `${prefix}.choices deve ter 4 itens.`);
  } else {
    validateChoice(choices[0], "A", `${prefix}.choices[0]`, ctx);
    validateChoice(choices[1], "B", `${prefix}.choices[1]`, ctx);
    validateChoice(choices[2], "C", `${prefix}.choices[2]`, ctx);
    validateChoice(choices[3], "D", `${prefix}.choices[3]`, ctx);
  }

  const modality = question.modality;
  if (!isObject(modality)) {
    pushError(ctx, `${prefix}.modality precisa ser objeto.`);
  } else {
    if (typeof modality.requires_image !== "boolean") {
      pushError(ctx, `${prefix}.modality.requires_image deve ser boolean.`);
    }
    if (!Array.isArray(modality.assets)) {
      pushError(ctx, `${prefix}.modality.assets deve ser array.`);
    } else {
      modality.assets.forEach((asset, assetIndex) => {
        if (!isObject(asset)) {
          pushError(ctx, `${prefix}.modality.assets[${assetIndex}] invalido.`);
          return;
        }

        if (!asString(asset.id)) {
          pushError(ctx, `${prefix}.modality.assets[${assetIndex}].id obrigatorio.`);
        }
        if (!["image", "table", "pdf_crop"].includes(String(asset.type))) {
          pushError(ctx, `${prefix}.modality.assets[${assetIndex}].type invalido.`);
        }

        const assetSha = asString(asset.sha256);
        if (!assetSha || !SHA256_PATTERN.test(assetSha)) {
          pushError(ctx, `${prefix}.modality.assets[${assetIndex}].sha256 invalido.`);
        }
      });
    }
  }

  const source = question.source;
  if (!isObject(source)) {
    pushError(ctx, `${prefix}.source precisa ser objeto.`);
  } else {
    const prova = source.prova;
    const gabarito = source.gabarito;

    if (!isObject(prova)) {
      pushError(ctx, `${prefix}.source.prova precisa ser objeto.`);
    } else {
      const url = asString(prova.url);
      const sha = asString(prova.sha256);

      if (!url) {
        pushError(ctx, `${prefix}.source.prova.url obrigatorio.`);
      }
      if (!sha || !SHA256_PATTERN.test(sha)) {
        pushError(ctx, `${prefix}.source.prova.sha256 invalido.`);
      }
      if (!Array.isArray(prova.pages) || prova.pages.length === 0) {
        pushError(ctx, `${prefix}.source.prova.pages deve ter ao menos 1 pagina.`);
      } else {
        prova.pages.forEach((page, pageIndex) => {
          if (!Number.isInteger(page) || (page as number) < 0) {
            pushError(ctx, `${prefix}.source.prova.pages[${pageIndex}] invalida.`);
          }
        });
      }
    }

    if (!isObject(gabarito)) {
      pushError(ctx, `${prefix}.source.gabarito precisa ser objeto.`);
    } else {
      const url = asString(gabarito.url);
      const sha = asString(gabarito.sha256);
      const kind = asString(gabarito.kind);

      if (!url) {
        pushError(ctx, `${prefix}.source.gabarito.url obrigatorio.`);
      }
      if (!sha || !SHA256_PATTERN.test(sha)) {
        pushError(ctx, `${prefix}.source.gabarito.sha256 invalido.`);
      }
      if (kind !== "definitivo" && kind !== "preliminar") {
        pushError(ctx, `${prefix}.source.gabarito.kind invalido.`);
      }
    }
  }

  const status = question.status;
  if (!isObject(status)) {
    pushError(ctx, `${prefix}.status precisa ser objeto.`);
  } else if (!["active", "annulled", "dropped"].includes(String(status.question))) {
    pushError(ctx, `${prefix}.status.question invalido.`);
  }

  if ("extraction" in question && !isObject(question.extraction)) {
    pushError(ctx, `${prefix}.extraction deve ser objeto quando presente.`);
  }

  return question;
}

function validateAnswerKeyEntry(
  entry: unknown,
  index: number,
  expectedEdition: number,
  ctx: ValidationContext,
): AnswerKeyRecord | null {
  const prefix = `answer_key[${index}]`;
  if (!isObject(entry)) {
    pushError(ctx, `${prefix} precisa ser objeto.`);
    return null;
  }

  const qid = asString(entry.qid);
  const status = asString(entry.status);
  const correct = entry.correct;

  const parsedQid = qid ? parseQid(qid) : null;
  if (!parsedQid) {
    pushError(ctx, `${prefix}.qid invalido.`);
  } else if (parsedQid.edition !== expectedEdition) {
    pushError(ctx, `${prefix}.qid com edicao incorreta.`);
  }

  const correctIsValid =
    correct === null ||
    correct === "A" ||
    correct === "B" ||
    correct === "C" ||
    correct === "D";
  if (!correctIsValid) {
    pushError(ctx, `${prefix}.correct deve ser A|B|C|D|null.`);
  }

  if (!["definitivo", "preliminar", "anulada"].includes(String(status))) {
    pushError(ctx, `${prefix}.status invalido.`);
  }

  if (correct === null && status !== "anulada") {
    pushError(ctx, `${prefix} com correct null deve ter status "anulada".`);
  }

  if (correct !== null && status === "anulada") {
    pushError(ctx, `${prefix} com correct preenchido nao pode ter status "anulada".`);
  }

  return entry;
}

function parseDateFromLabel(label: string): string | null {
  const match = label.match(/(\d{2})\/(\d{2})\/(\d{4})/);
  if (!match) {
    return null;
  }
  return `${match[3]}-${match[2]}-${match[1]}`;
}

function parseEditionFromExamName(examName: string): number | null {
  const match = examName.match(/^(\d+)/);
  if (!match) {
    return null;
  }
  return Number.parseInt(match[1], 10);
}

async function validateExam(
  workspaceRoot: string,
  exam: DownloadedExam,
  globalCtx: ValidationContext,
): Promise<ExamValidationSummary> {
  const examCtx: ValidationContext = { errors: [], warnings: [] };
  const examFolder = path.dirname(path.resolve(workspaceRoot, exam.prova.localPath));
  const questionsPath = path.join(examFolder, "questions.json");
  const answerKeyPath = path.join(examFolder, "answer_key.json");
  const provaPath = path.resolve(workspaceRoot, exam.prova.localPath);
  const gabaritoPath = path.resolve(workspaceRoot, exam.gabarito.localPath);
  const edition = parseEditionFromExamName(exam.examName);
  const examDate = parseDateFromLabel(exam.prova.label);

  if (!edition) {
    pushError(examCtx, `Nao foi possivel extrair edicao de "${exam.examName}".`);
  }
  if (!examDate) {
    pushError(examCtx, `Nao foi possivel extrair data de "${exam.prova.label}".`);
  }

  let questionsRaw: unknown;
  let answerKeyRaw: unknown;
  let provaSha = "";
  let gabaritoSha = "";

  try {
    questionsRaw = JSON.parse(await readFile(questionsPath, "utf-8"));
  } catch (error) {
    pushError(examCtx, `Falha ao ler ${toPosix(path.relative(workspaceRoot, questionsPath))}: ${String(error)}`);
  }

  try {
    answerKeyRaw = JSON.parse(await readFile(answerKeyPath, "utf-8"));
  } catch (error) {
    pushError(examCtx, `Falha ao ler ${toPosix(path.relative(workspaceRoot, answerKeyPath))}: ${String(error)}`);
  }

  try {
    provaSha = await sha256File(provaPath);
  } catch (error) {
    pushError(examCtx, `Falha ao calcular sha256 da prova: ${String(error)}`);
  }

  try {
    gabaritoSha = await sha256File(gabaritoPath);
  } catch (error) {
    pushError(examCtx, `Falha ao calcular sha256 do gabarito: ${String(error)}`);
  }

  if (!Array.isArray(questionsRaw)) {
    pushError(examCtx, "questions.json precisa ser array.");
  }
  if (!Array.isArray(answerKeyRaw)) {
    pushError(examCtx, "answer_key.json precisa ser array.");
  }

  const questions = Array.isArray(questionsRaw) ? questionsRaw : [];
  const answerKey = Array.isArray(answerKeyRaw) ? answerKeyRaw : [];

  if (questions.length !== TOTAL_QUESTIONS) {
    pushError(examCtx, `questions.json deve ter ${TOTAL_QUESTIONS} itens; recebeu ${questions.length}.`);
  }
  if (answerKey.length !== TOTAL_QUESTIONS) {
    pushError(examCtx, `answer_key.json deve ter ${TOTAL_QUESTIONS} itens; recebeu ${answerKey.length}.`);
  }

  const questionByQid = new Map<string, QuestionRecord>();
  const answerByQid = new Map<string, AnswerKeyRecord>();
  const questionNumbers = new Set<number>();
  const answerNumbers = new Set<number>();

  questions.forEach((question, index) => {
    const validated = validateQuestion(
      question,
      index,
      edition ?? 0,
      examDate ?? "",
      examCtx,
    );
    if (!validated) {
      return;
    }

    const qid = asString(validated.qid);
    const number = asNumber(validated.number);
    if (!qid || number === null) {
      return;
    }

    if (questionByQid.has(qid)) {
      pushError(examCtx, `qid duplicado em questions.json: ${qid}`);
    }
    questionByQid.set(qid, validated);
    questionNumbers.add(number);

    const source = validated.source as Record<string, unknown> | undefined;
    const prova = isObject(source?.prova) ? source.prova : null;
    const gabarito = isObject(source?.gabarito) ? source.gabarito : null;

    if (prova) {
      if (prova.url !== exam.prova.url) {
        pushError(examCtx, `${qid}: source.prova.url difere do latest-run.`);
      }
      if (asString(prova.sha256)?.toLowerCase() !== provaSha.toLowerCase()) {
        pushError(examCtx, `${qid}: source.prova.sha256 difere do arquivo local.`);
      }
    }

    if (gabarito) {
      if (gabarito.url !== exam.gabarito.url) {
        pushError(examCtx, `${qid}: source.gabarito.url difere do latest-run.`);
      }
      if (asString(gabarito.sha256)?.toLowerCase() !== gabaritoSha.toLowerCase()) {
        pushError(examCtx, `${qid}: source.gabarito.sha256 difere do arquivo local.`);
      }
    }
  });

  answerKey.forEach((entry, index) => {
    const validated = validateAnswerKeyEntry(entry, index, edition ?? 0, examCtx);
    if (!validated) {
      return;
    }

    const qid = asString(validated.qid);
    if (!qid) {
      return;
    }

    if (answerByQid.has(qid)) {
      pushError(examCtx, `qid duplicado em answer_key.json: ${qid}`);
    }
    answerByQid.set(qid, validated);

    const parsed = parseQid(qid);
    if (parsed) {
      answerNumbers.add(parsed.number);
    }
  });

  for (let number = 1; number <= TOTAL_QUESTIONS; number += 1) {
    if (!questionNumbers.has(number)) {
      pushError(examCtx, `questions.json sem numero ${number}.`);
    }
    if (!answerNumbers.has(number)) {
      pushError(examCtx, `answer_key.json sem numero ${number}.`);
    }
  }

  const questionQids = new Set(questionByQid.keys());
  const answerQids = new Set(answerByQid.keys());
  for (const qid of questionQids) {
    if (!answerQids.has(qid)) {
      pushError(examCtx, `qid ausente em answer_key.json: ${qid}`);
    }
  }
  for (const qid of answerQids) {
    if (!questionQids.has(qid)) {
      pushError(examCtx, `qid ausente em questions.json: ${qid}`);
    }
  }

  for (const [qid, question] of questionByQid.entries()) {
    const answer = answerByQid.get(qid);
    if (!answer) {
      continue;
    }

    const questionStatus = isObject(question.status)
      ? asString(question.status.question)
      : null;
    const answerStatus = asString(answer.status);
    const answerCorrect = answer.correct;
    const gabaritoKind =
      isObject(question.source) && isObject(question.source.gabarito)
        ? asString(question.source.gabarito.kind)
        : null;

    if (answerCorrect === null) {
      if (questionStatus !== "annulled" && questionStatus !== "dropped") {
        pushError(examCtx, `${qid}: correct null exige status annulled/dropped.`);
      }
      if (answerStatus !== "anulada") {
        pushError(examCtx, `${qid}: correct null exige status anulada no answer_key.`);
      }
    } else {
      if (!["A", "B", "C", "D"].includes(String(answerCorrect))) {
        pushError(examCtx, `${qid}: correct invalido.`);
      }
      if (questionStatus === "annulled") {
        pushError(examCtx, `${qid}: questao annulled nao pode ter resposta preenchida.`);
      }
      if (gabaritoKind && answerStatus && answerStatus !== gabaritoKind) {
        pushError(examCtx, `${qid}: status do answer_key difere de source.gabarito.kind.`);
      }
    }
  }

  const annulledCount = [...questionByQid.values()].filter(
    (question) =>
      isObject(question.status) && asString(question.status.question) === "annulled",
  ).length;

  if (examCtx.errors.length === 0) {
    console.log(
      `OK ${exam.examName}: ${questions.length} questoes, ${answerKey.length} respostas, ${annulledCount} anuladas.`,
    );
  } else {
    console.log(`ERROS ${exam.examName}: ${examCtx.errors.length} problema(s).`);
  }

  examCtx.errors.forEach((error) => pushError(globalCtx, `[${exam.examName}] ${error}`));
  examCtx.warnings.forEach((warning) =>
    pushWarning(globalCtx, `[${exam.examName}] ${warning}`),
  );

  return {
    exam_id: exam.examId,
    exam_name: exam.examName,
    exam_folder: toPosix(path.relative(workspaceRoot, examFolder)),
    questions_count: questions.length,
    answer_key_count: answerKey.length,
    annulled_count: annulledCount,
    error_count: examCtx.errors.length,
    warning_count: examCtx.warnings.length,
    errors: examCtx.errors,
    warnings: examCtx.warnings,
  };
}

function toPosix(filePath: string): string {
  return filePath.split(path.sep).join("/");
}

async function main(): Promise<void> {
  const workspaceRoot = process.cwd();
  const ctx: ValidationContext = { errors: [], warnings: [] };
  const latestRunPath = path.resolve(workspaceRoot, "data", "oab", "latest-run.json");
  const runsDir = path.resolve(workspaceRoot, "data", "oab", "runs");

  const latestRunRaw = JSON.parse(await readFile(latestRunPath, "utf-8")) as LatestRun;
  if (!Array.isArray(latestRunRaw.selectedExams)) {
    throw new Error("latest-run.json invalido: selectedExams ausente.");
  }

  if (latestRunRaw.selectedExams.length !== 3) {
    pushError(
      ctx,
      `latest-run.json deve conter 3 exames; recebeu ${latestRunRaw.selectedExams.length}.`,
    );
  }

  const examSummaries: ExamValidationSummary[] = [];
  for (const exam of latestRunRaw.selectedExams) {
    examSummaries.push(await validateExam(workspaceRoot, exam, ctx));
  }

  const summary = {
    summary_version: "1.0",
    validator_version: VALIDATOR_VERSION,
    validated_at: new Date().toISOString(),
    run_id: latestRunRaw.runId,
    run_ran_at: latestRunRaw.ranAt,
    exams_expected: 3,
    exams_validated: latestRunRaw.selectedExams.length,
    ok: ctx.errors.length === 0,
    total_error_count: ctx.errors.length,
    total_warning_count: ctx.warnings.length,
    exams: examSummaries,
    errors: ctx.errors,
    warnings: ctx.warnings,
  };

  await mkdir(runsDir, { recursive: true });
  const summaryPath = path.join(runsDir, `validation-summary-${latestRunRaw.runId}.json`);
  const latestSummaryPath = path.join(runsDir, "latest-validation-summary.json");
  await writeFile(summaryPath, `${JSON.stringify(summary, null, 2)}\n`);
  await writeFile(latestSummaryPath, `${JSON.stringify(summary, null, 2)}\n`);
  console.log(`Resumo salvo em ${toPosix(path.relative(workspaceRoot, summaryPath))}`);

  if (ctx.warnings.length > 0) {
    console.log(`Avisos: ${ctx.warnings.length}`);
    ctx.warnings.forEach((warning) => console.log(`  - ${warning}`));
  }

  if (ctx.errors.length > 0) {
    console.error(`Falha de validacao: ${ctx.errors.length} erro(s).`);
    ctx.errors.forEach((error) => console.error(`  - ${error}`));
    process.exit(1);
  }

  console.log("Validacao concluida com sucesso.");
}

main().catch((error: unknown) => {
  const message =
    error instanceof Error ? error.message : "Erro desconhecido na validacao dos JSONs.";
  console.error(message);
  process.exit(1);
});
