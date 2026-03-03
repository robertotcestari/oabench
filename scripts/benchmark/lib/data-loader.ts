import { readFile } from "node:fs/promises";
import path from "node:path";
import type { AnswerKeyEntry, LatestRun, Question } from "./types.js";

const DATA_ROOT = path.resolve(import.meta.dir, "../../../data/oab");

export type ExamData = {
  edition: number;
  examId: string;
  examName: string;
  questions: Question[];
  answerKey: AnswerKeyEntry[];
};

/**
 * Parse edition number from exam folder name like "16773-43-exame-de-ordem-unificado"
 */
function parseEdition(folderName: string): number | null {
  const match = folderName.match(/^\d+-(\d+)-exame-de-ordem-unificado$/);
  return match ? parseInt(match[1], 10) : null;
}

/**
 * Load all exam data, optionally filtering by edition numbers.
 */
export async function loadExamData(
  editions?: number[],
): Promise<Map<number, ExamData>> {
  const latestRunPath = path.join(DATA_ROOT, "latest-run.json");
  const latestRun: LatestRun = JSON.parse(
    await readFile(latestRunPath, "utf-8"),
  );

  const result = new Map<number, ExamData>();

  for (const exam of latestRun.selectedExams) {
    const folderName = path.basename(
      path.dirname(exam.prova.localPath),
    );
    const edition = parseEdition(folderName);
    if (edition === null) {
      console.warn(`  ⚠ Could not parse edition from folder: ${folderName}`);
      continue;
    }

    if (editions && !editions.includes(edition)) continue;

    const examDir = path.join(DATA_ROOT, "exams", folderName);
    const questions: Question[] = JSON.parse(
      await readFile(path.join(examDir, "questions.json"), "utf-8"),
    );
    const answerKey: AnswerKeyEntry[] = JSON.parse(
      await readFile(path.join(examDir, "answer_key.json"), "utf-8"),
    );

    result.set(edition, {
      edition,
      examId: exam.examId,
      examName: exam.examName,
      questions,
      answerKey,
    });
  }

  return result;
}
