// Auto-grader for the CEO memory benchmark: first-pass LLM judging of every
// answered question against its required/forbidden claims, then rubric-weighted
// scoring into grade.json. Humans still own the final word — see rubric.md;
// this removes the "nobody scores the run" failure mode, not the reviewer.
//
//   node --env-file-if-exists=.env evals/ceo-memory/grade.ts <dir|runRoot> [...more]
//
// <dir> is data/ceo-memory-benchmarks/<timestamp>/<mode> produced by
// benchmark.ts (must contain answers.json). A root containing run-XX/
// subdirectories (benchmark --runs N) is grouped automatically; each group
// additionally gets a comparison.json with per-question variance.
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  benchmarkModelMetadata,
  startServer,
  stopServer,
  sendQuestion,
  type BenchmarkModelMetadata,
  type ServerHandle,
} from "./benchmark.ts";

const ROOT = resolve(fileURLToPath(import.meta.url), "../..");
const FIXTURE = join(ROOT, "evals", "ceo-memory", "v1");

export type Question = {
  id: string;
  checkpoint: string;
  category: string;
  prompt: string;
  critical: boolean;
  expected: {
    required_claims: string[];
    forbidden_claims?: string[];
    source_refs: string[];
  };
};

export type JudgeVerdict = {
  required: { claim: string; present: boolean }[];
  forbidden: { claim: string; appears: boolean }[];
};

export type QuestionGrade = {
  id: string;
  category: string;
  critical: boolean;
  score: 0 | 1 | 2 | null;
  critical_error: boolean;
  verdict: JudgeVerdict | null;
  judge_error?: string;
};

// Rubric category weights (evals/ceo-memory/v1/rubric.md), normalized to 100.
export const CATEGORY_WEIGHTS: Record<string, number> = {
  current_truth: 30,
  commitments: 25,
  temporal_history: 15,
  entity_linking: 10,
  provenance: 10,
  precision: 10,
};

export function buildJudgePrompt(question: Question, reply: string): string {
  return (
    `You are a strict grader for a memory benchmark. Do not use any tools. ` +
    `Output a single JSON object and nothing else. ` +
    `For each REQUIRED claim, present=true only if the candidate answer asserts it ` +
    `(equivalent wording counts; dates must match exactly). ` +
    `For each FORBIDDEN claim, appears=true only if the candidate answer asserts it — ` +
    `a denial or hedged negation of the forbidden claim is NOT an assertion of it.\n\n` +
    `Question: ${question.prompt}\n\n` +
    `Candidate answer:\n"""\n${reply}\n"""\n\n` +
    `Required claims:\n${question.expected.required_claims
      .map((claim, index) => `${index + 1}. ${claim}`)
      .join("\n")}\n\n` +
    `Forbidden claims:\n${
      (question.expected.forbidden_claims ?? [])
        .map((claim, index) => `${index + 1}. ${claim}`)
        .join("\n") || "(none)"
    }\n\n` +
    `JSON shape: {"required":[{"claim":"...","present":true|false}],` +
    `"forbidden":[{"claim":"...","appears":true|false}]}`
  );
}

export function parseJudgeVerdict(
  text: string,
  question: Question,
): JudgeVerdict | string {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return "judge reply contains no JSON object";
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.slice(start, end + 1));
  } catch (error) {
    return `judge reply is not valid JSON: ${
      error instanceof Error ? error.message : String(error)
    }`;
  }
  if (typeof parsed !== "object" || parsed === null) {
    return "judge reply is not an object";
  }
  const required = (parsed as { required?: unknown }).required;
  const forbidden = (parsed as { forbidden?: unknown }).forbidden;
  const expectedForbidden = question.expected.forbidden_claims ?? [];
  if (
    !Array.isArray(required) ||
    required.length !== question.expected.required_claims.length ||
    !Array.isArray(forbidden) ||
    forbidden.length !== expectedForbidden.length
  ) {
    return "judge verdict does not match the claim lists of the question";
  }
  const verdict: JudgeVerdict = { required: [], forbidden: [] };
  for (const item of required) {
    if (
      typeof item !== "object" ||
      item === null ||
      typeof (item as { present?: unknown }).present !== "boolean" ||
      typeof (item as { claim?: unknown }).claim !== "string"
    ) {
      return "judge required claim is malformed";
    }
    verdict.required.push({
      claim: (item as { claim: string }).claim,
      present: (item as { present: boolean }).present,
    });
  }
  for (const item of forbidden) {
    if (
      typeof item !== "object" ||
      item === null ||
      typeof (item as { appears?: unknown }).appears !== "boolean" ||
      typeof (item as { claim?: unknown }).claim !== "string"
    ) {
      return "judge forbidden claim is malformed";
    }
    verdict.forbidden.push({
      claim: (item as { claim: string }).claim,
      appears: (item as { appears: boolean }).appears,
    });
  }
  return verdict;
}

export function scoreQuestion(
  question: Question,
  verdict: JudgeVerdict,
): Pick<QuestionGrade, "score" | "critical_error"> {
  const assertedForbidden = verdict.forbidden.some((item) => item.appears);
  // Rubric critical errors are assertions of a wrong fact, not omissions.
  if (assertedForbidden) {
    return { score: 0, critical_error: question.critical };
  }
  const present = verdict.required.filter((item) => item.present).length;
  if (present === verdict.required.length) {
    return { score: 2, critical_error: false };
  }
  if (present > 0) return { score: 1, critical_error: false };
  return { score: 0, critical_error: false };
}

export type RunGrade = {
  model: BenchmarkModelMetadata;
  questions: QuestionGrade[];
  categories: Record<string, number>;
  total: number;
  critical_errors: number;
  ungraded: number;
  verdict: "pass" | "needs_review" | "fail";
};

export function aggregateRun(
  grades: QuestionGrade[],
  model: ReturnType<typeof benchmarkModelMetadata>,
): RunGrade {
  const byCategory = new Map<string, number[]>();
  for (const grade of grades) {
    if (grade.score === null) continue;
    const bucket = byCategory.get(grade.category) ?? [];
    bucket.push(grade.score);
    byCategory.set(grade.category, bucket);
  }
  const categories: Record<string, number> = {};
  let total = 0;
  for (const [category, scores] of byCategory) {
    const mean = scores.reduce((sum, score) => sum + score, 0) / scores.length;
    const weight = CATEGORY_WEIGHTS[category] ?? 0;
    const points = (mean / 2) * weight;
    categories[category] = Math.round(points * 10) / 10;
    total += points;
  }
  const criticalErrors = grades.filter((grade) => grade.critical_error).length;
  const ungraded = grades.filter((grade) => grade.score === null).length;
  if (grades.length === 0) {
    return {
      model,
      questions: grades,
      categories: {},
      total: 0,
      critical_errors: 0,
      ungraded: 0,
      verdict: "fail",
    };
  }
  const scored = Math.round(total * 10) / 10;
  const verdict: RunGrade["verdict"] =
    criticalErrors > 0 || ungraded > 0 || scored < 80
      ? "fail"
      : scored >= 90
        ? "pass"
        : "needs_review";
  return {
    model,
    questions: grades,
    categories,
    total: scored,
    critical_errors: criticalErrors,
    ungraded,
    verdict,
  };
}

type AnswersFile = {
  answers?: Array<{
    id: string;
    reply: string | null;
    status: string;
    error?: string;
  }>;
};

export type QuestionComparison = {
  id: string;
  category: string;
  critical: boolean;
  runs: number;
  mean_score: number;
  full_pass_rate: number;
  critical_errors: number;
  unstable: boolean;
};

export type RunComparison = {
  name: string;
  runs: number;
  totals: number[];
  mean_total: number;
  worst_verdict: RunGrade["verdict"];
  critical_error_runs: number;
  questions: QuestionComparison[];
  unstable_question_ids: string[];
};

const VERDICT_SEVERITY: Record<RunGrade["verdict"], number> = {
  pass: 0,
  needs_review: 1,
  fail: 2,
};

export function compareRuns(
  name: string,
  runGrades: RunGrade[],
): RunComparison {
  if (runGrades.length === 0) {
    throw new Error(`group ${name} has no graded runs to compare`);
  }
  const byId = new Map<string, QuestionGrade[]>();
  for (const run of runGrades) {
    for (const grade of run.questions) {
      const bucket = byId.get(grade.id) ?? [];
      bucket.push(grade);
      byId.set(grade.id, bucket);
    }
  }
  const questions: QuestionComparison[] = [];
  for (const [id, grades] of byId) {
    const scored = grades.filter((grade) => grade.score !== null);
    const mean =
      scored.reduce((sum, grade) => sum + (grade.score ?? 0), 0) /
        scored.length || 0;
    const fullPassRate =
      scored.filter((grade) => grade.score === 2).length / scored.length || 0;
    const scores = new Set(scored.map((grade) => grade.score));
    questions.push({
      id,
      category: grades[0].category,
      critical: grades[0].critical,
      runs: grades.length,
      mean_score: Math.round(mean * 100) / 100,
      full_pass_rate: Math.round(fullPassRate * 100) / 100,
      critical_errors: grades.filter((grade) => grade.critical_error).length,
      unstable: scores.size > 1,
    });
  }
  questions.sort((a, b) => a.id.localeCompare(b.id));
  const totals = runGrades.map((run) => run.total);
  return {
    name,
    runs: runGrades.length,
    totals,
    mean_total:
      Math.round(
        (totals.reduce((sum, total) => sum + total, 0) / totals.length) * 10,
      ) / 10,
    worst_verdict: runGrades.reduce<RunGrade["verdict"]>(
      (worst, run) =>
        VERDICT_SEVERITY[run.verdict] > VERDICT_SEVERITY[worst]
          ? run.verdict
          : worst,
      "pass",
    ),
    critical_error_runs: runGrades.filter((run) => run.critical_errors > 0)
      .length,
    questions,
    unstable_question_ids: questions
      .filter((question) => question.unstable)
      .map((question) => question.id),
  };
}

export function answersPath(dir: string): string | null {
  for (const candidate of [
    join(dir, "answers.json"),
    join(dir, "answers", "answers.json"),
  ]) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

async function gradeDir(dir: string, server: ServerHandle): Promise<RunGrade> {
  const source = answersPath(dir);
  if (!source) {
    throw new Error(`no answers.json under ${dir}`);
  }
  const answers = JSON.parse(readFileSync(source, "utf8")) as AnswersFile;
  if (!Array.isArray(answers.answers)) {
    throw new Error(`${dir}/answers.json has no answers array`);
  }
  const questions: Question[] = (
    JSON.parse(readFileSync(join(FIXTURE, "questions.json"), "utf8")) as {
      questions: Question[];
    }
  ).questions;
  const byId = new Map(questions.map((question) => [question.id, question]));

  const grades: QuestionGrade[] = [];
  for (const answer of answers.answers) {
    const question = byId.get(answer.id);
    if (!question) continue;
    if (!answer.reply) {
      grades.push({
        id: answer.id,
        category: question.category,
        critical: question.critical,
        score: null,
        critical_error: false,
        verdict: null,
        judge_error: answer.error ?? `no reply (status ${answer.status})`,
      });
      continue;
    }
    const judged = await sendQuestion(
      server,
      buildJudgePrompt(question, answer.reply),
    );
    if (!judged.reply) {
      grades.push({
        id: answer.id,
        category: question.category,
        critical: question.critical,
        score: null,
        critical_error: false,
        verdict: null,
        judge_error: judged.error ?? "judge returned no reply",
      });
      continue;
    }
    const parsed = parseJudgeVerdict(judged.reply, question);
    if (typeof parsed === "string") {
      grades.push({
        id: answer.id,
        category: question.category,
        critical: question.critical,
        score: null,
        critical_error: false,
        verdict: null,
        judge_error: parsed,
      });
      continue;
    }
    grades.push({
      id: answer.id,
      category: question.category,
      critical: question.critical,
      verdict: parsed,
      ...scoreQuestion(question, parsed),
    });
    console.log(`${answer.id}: score ${grades[grades.length - 1].score}`);
  }
  const runGrade = aggregateRun(grades, benchmarkModelMetadata(process.env));
  writeFileSync(
    join(dir, "grade.json"),
    `${JSON.stringify(runGrade, null, 2)}\n`,
    "utf8",
  );
  console.log(
    `${dir}: total ${runGrade.total}/100 · critical errors ${runGrade.critical_errors} · ungraded ${runGrade.ungraded} · verdict ${runGrade.verdict}`,
  );
  return runGrade;
}

export type Group = { name: string; dirs: string[] };

// Expand CLI arguments into named groups of single-run dirs (answers.json):
//   <modeDir>                    -> one run
//   <root>/run-XX/<mode>         -> one run, named run-XX/<mode>
//   <root> or <root>/run-XX      -> one group per mode, repeats as runs
//   name=dir1,dir2               -> explicit group
export function inferGroups(arg: string): Group[] {
  const eq = arg.indexOf("=");
  if (eq > 0) {
    return [
      {
        name: arg.slice(0, eq),
        dirs: arg
          .slice(eq + 1)
          .split(",")
          .filter(Boolean)
          .map((dir) => resolve(dir)),
      },
    ];
  }
  const dir = resolve(arg);
  const base = basename(dir);
  const parent = dirname(dir);
  const parentBase = basename(parent);
  const runReps = (path: string): string[] => {
    try {
      return readdirSync(path)
        .filter((entry) => /^run-\d+$/.test(entry))
        .sort();
    } catch {
      return [];
    }
  };
  const modeDirsOf = (repDir: string): string[] => {
    if (answersPath(repDir)) return [];
    try {
      return readdirSync(repDir)
        .filter((entry) => Boolean(answersPath(join(repDir, entry))))
        .sort();
    } catch {
      return [];
    }
  };

  if (/^run-\d+$/.test(parentBase) && answersPath(dir)) {
    // <root>/run-XX/<mode>: one repetition of one mode.
    return [
      {
        name:
          runReps(dirname(parent)).length <= 1 ? base : `${parentBase}/${base}`,
        dirs: [dir],
      },
    ];
  }
  if (answersPath(dir)) {
    return [{ name: base, dirs: [dir] }];
  }
  if (/^run-\d+$/.test(base)) {
    // <root>/run-XX -> one group per mode inside this repetition.
    return modeDirsOf(dir).map((mode) => ({
      name: `${mode}/${base}`,
      dirs: [join(dir, mode)],
    }));
  }
  const reps = runReps(dir);
  if (reps.length > 0) {
    const modes = [
      ...new Set(reps.flatMap((rep) => modeDirsOf(join(dir, rep)))),
    ].sort();
    if (modes.length > 0) {
      return modes.map((mode) => ({
        name: mode,
        dirs: reps
          .map((rep) => join(dir, rep, mode))
          .filter((path) => Boolean(answersPath(path))),
      }));
    }
    return [{ name: base, dirs: reps.map((rep) => join(dir, rep)) }];
  }
  return [{ name: base, dirs: [dir] }];
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    console.error(
      "Usage: grade.ts <modeDir|runRoot|name=dir1,dir2> [...more]\n" +
        "A dir with answers.json is one run; a root with run-XX/ repeats is grouped per mode.",
    );
    process.exit(1);
  }
  const anchored = args.flatMap((arg) => {
    const eq = arg.indexOf("=");
    const anchor = resolve(eq > 0 ? arg.slice(eq + 1).split(",")[0] : arg);
    return inferGroups(arg).map((group) => ({ group, anchor }));
  });
  for (const { group } of anchored) {
    if (group.dirs.length === 0) {
      throw new Error(`group ${group.name} has no directories`);
    }
    for (const dir of group.dirs) {
      if (!answersPath(dir)) {
        throw new Error(
          `group ${group.name}: no answers.json under ${dir} (did the benchmark skip questions?)`,
        );
      }
    }
  }
  const groupsPerAnchor = new Map<string, number>();
  for (const { anchor } of anchored) {
    groupsPerAnchor.set(anchor, (groupsPerAnchor.get(anchor) ?? 0) + 1);
  }

  const judgeBase = anchored[0].anchor;
  const judgeDir = join(judgeBase, "judge");
  mkdirSync(join(judgeDir, "vault"), { recursive: true });
  mkdirSync(join(judgeDir, "data"), { recursive: true });
  const { server } = await startServer({
    vault: join(judgeDir, "vault"),
    data: join(judgeDir, "data"),
    timezone: process.env.ASSISTANT_TIMEZONE ?? "UTC",
    logPath: join(judgeDir, "judge-server.log"),
  });

  const allRunGrades: RunGrade[] = [];
  try {
    const graded: Array<{ name: string; runs: RunGrade[] }> = [];
    for (const { group } of anchored) {
      const runs: RunGrade[] = [];
      for (const dir of group.dirs) {
        runs.push(await gradeDir(dir, server));
      }
      graded.push({ name: group.name, runs });
      allRunGrades.push(...runs);
    }
    for (const [index, { anchor }] of anchored.entries()) {
      const comparison = compareRuns(graded[index].name, graded[index].runs);
      const multi = (groupsPerAnchor.get(anchor) ?? 0) > 1;
      const outPath = join(
        anchor,
        multi
          ? `comparison-${comparison.name.replaceAll("/", "_")}.json`
          : "comparison.json",
      );
      writeFileSync(
        outPath,
        `${JSON.stringify(comparison, null, 2)}\n`,
        "utf8",
      );
      console.log(
        `${outPath}: mean ${comparison.mean_total} · runs ${comparison.totals.join(", ")} · worst ${comparison.worst_verdict} · unstable ${comparison.unstable_question_ids.join(", ") || "none"}`,
      );
    }
  } finally {
    await stopServer(server);
  }

  const anyFail = allRunGrades.some((run) => run.verdict === "fail");
  process.exitCode = anyFail ? 2 : 0;
}

const entry = process.argv[1]
  ? pathToFileURL(resolve(process.argv[1])).href
  : "";
if (import.meta.url === entry) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
