/* eslint-disable @typescript-eslint/no-floating-promises -- Node's test runner owns registrations. */
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  aggregateRun,
  buildJudgePrompt,
  compareRuns,
  inferGroups,
  parseJudgeVerdict,
  scoreQuestion,
  type JudgeVerdict,
  type Question,
  type QuestionGrade,
  type RunGrade,
} from "./grade.ts";

const tempDirs: string[] = [];
test.after(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "iva-grade-test-"));
  tempDirs.push(dir);
  return dir;
}

const question: Question = {
  id: "Q01",
  checkpoint: "2026-09-08",
  category: "current_truth",
  prompt: "Когда NordSupply должен передать учётные данные?",
  critical: true,
  expected: {
    required_claims: ["Новый срок — пятница, 11 сентября, до 10:00"],
    forbidden_claims: [
      "Для NordSupply текущим сроком остаётся среда, 9 сентября",
    ],
    source_refs: ["D2-E01"],
  },
};

function verdict(required: boolean[], forbidden: boolean[]): JudgeVerdict {
  return {
    required: question.expected.required_claims.map((claim, index) => ({
      claim,
      present: required[index] ?? false,
    })),
    forbidden: (question.expected.forbidden_claims ?? []).map(
      (claim, index) => ({ claim, appears: forbidden[index] ?? false }),
    ),
  };
}

test("judge prompt carries the answer and every claim verbatim", () => {
  const prompt = buildJudgePrompt(question, "Ответ: 11 сентября до 10:00");
  assert.ok(prompt.includes("Ответ: 11 сентября до 10:00"));
  assert.ok(prompt.includes("Новый срок — пятница, 11 сентября, до 10:00"));
  assert.ok(
    prompt.includes("Для NordSupply текущим сроком остаётся среда, 9 сентября"),
  );
});

test("parseJudgeVerdict extracts fenced JSON and rejects shape mismatch", () => {
  const good = parseJudgeVerdict(
    '```json\n{"required":[{"claim":"a","present":true}],"forbidden":[{"claim":"b","appears":false}]}\n```',
    question,
  );
  assert.notEqual(typeof good, "string");
  const bad = parseJudgeVerdict('{"required":[],"forbidden":[]}', question);
  assert.equal(typeof bad, "string");
});

test("scoring: full claims 2, missing detail 1, forbidden assertion 0 + critical", () => {
  assert.deepEqual(scoreQuestion(question, verdict([true], [false])), {
    score: 2,
    critical_error: false,
  });
  assert.deepEqual(scoreQuestion(question, verdict([false], [false])), {
    score: 0,
    critical_error: false,
  });
  assert.deepEqual(scoreQuestion(question, verdict([true], [true])), {
    score: 0,
    critical_error: true,
  });
});

test("run aggregation is category-weighted and gates on criticals", () => {
  const grades: QuestionGrade[] = [
    {
      id: "Q01",
      category: "current_truth",
      critical: true,
      score: 2,
      critical_error: false,
      verdict: null,
    },
    {
      id: "Q13",
      category: "commitments",
      critical: true,
      score: 1,
      critical_error: false,
      verdict: null,
    },
    {
      id: "Q20",
      category: "entity_linking",
      critical: true,
      score: 0,
      critical_error: true,
      verdict: null,
    },
  ];
  const run = aggregateRun(grades, {
    provider: "test",
    model: "test-model",
    vision_model: "test-vision",
  });
  // 30*1 + 25*0.5 + 10*0 = 42.5, but a critical error fails the run anyway.
  assert.equal(run.total, 42.5);
  assert.equal(run.critical_errors, 1);
  assert.equal(run.verdict, "fail");
});

test("ungraded questions can never pass the run", () => {
  const run = aggregateRun(
    [
      {
        id: "Q01",
        category: "current_truth",
        critical: true,
        score: null,
        critical_error: false,
        verdict: null,
        judge_error: "judge returned no reply",
      },
    ],
    { provider: "test", model: "m", vision_model: "v" },
  );
  assert.equal(run.verdict, "fail");
  assert.equal(run.ungraded, 1);
});

function runGrades(
  scoresPerRun: Array<
    Array<{ id: string; category: string; score: 0 | 1 | 2 }>
  >,
  criticalRun = false,
): RunGrade[] {
  return scoresPerRun.map((runScores, runIndex) => {
    const grades: QuestionGrade[] = runScores.map((entry) => ({
      id: entry.id,
      category: entry.category,
      critical: false,
      score: entry.score,
      critical_error: criticalRun && runIndex === 1 && entry.id === "Q01",
      verdict: null,
    }));
    return aggregateRun(grades, {
      provider: "test",
      model: "m",
      vision_model: "v",
    });
  });
}

test("compareRuns reports per-question variance and the worst verdict", () => {
  const comparison = compareRuns(
    "stock",
    runGrades([
      [
        { id: "Q02", category: "commitments", score: 2 },
        { id: "Q01", category: "current_truth", score: 2 },
      ],
      [
        { id: "Q02", category: "commitments", score: 1 },
        { id: "Q01", category: "current_truth", score: 2 },
      ],
    ]),
  );
  assert.equal(comparison.runs, 2);
  assert.deepEqual(comparison.totals.length, 2);
  assert.deepEqual(
    comparison.questions.map(
      ({ id, mean_score, full_pass_rate, unstable }) => ({
        id,
        mean_score,
        full_pass_rate,
        unstable,
      }),
    ),
    [
      { id: "Q01", mean_score: 2, full_pass_rate: 1, unstable: false },
      { id: "Q02", mean_score: 1.5, full_pass_rate: 0.5, unstable: true },
    ],
  );
  assert.deepEqual(comparison.unstable_question_ids, ["Q02"]);
});

test("a critical error in one repeat fails the whole group", () => {
  const comparison = compareRuns(
    "ceo-schema",
    runGrades(
      [
        [{ id: "Q01", category: "current_truth", score: 2 }],
        [{ id: "Q01", category: "current_truth", score: 0 }],
      ],
      true,
    ),
  );
  assert.equal(comparison.worst_verdict, "fail");
  assert.equal(comparison.critical_error_runs, 1);
  assert.equal(comparison.questions[0].critical_errors, 1);
});

test("inferGroups expands benchmark --runs repeats per mode", () => {
  const root = tempDir();
  const output = join(root, "timestamp");
  for (const rep of ["run-01", "run-02"]) {
    for (const mode of ["stock", "ceo-schema"]) {
      mkdirSync(join(output, rep, mode, "answers"), { recursive: true });
      writeFileSync(join(output, rep, mode, "answers", "answers.json"), "{}");
    }
  }

  assert.deepEqual(inferGroups(output), [
    {
      name: "ceo-schema",
      dirs: [
        join(output, "run-01", "ceo-schema"),
        join(output, "run-02", "ceo-schema"),
      ],
    },
    {
      name: "stock",
      dirs: [join(output, "run-01", "stock"), join(output, "run-02", "stock")],
    },
  ]);

  assert.deepEqual(inferGroups(join(output, "run-01")), [
    {
      name: "ceo-schema/run-01",
      dirs: [join(output, "run-01", "ceo-schema")],
    },
    { name: "stock/run-01", dirs: [join(output, "run-01", "stock")] },
  ]);

  assert.deepEqual(inferGroups(join(output, "run-01", "stock")), [
    { name: "run-01/stock", dirs: [join(output, "run-01", "stock")] },
  ]);

  const explicit = inferGroups(
    `pair=${join(output, "run-01", "stock")},${join(output, "run-02", "stock")}`,
  );
  assert.equal(explicit.length, 1);
  assert.equal(explicit[0].name, "pair");
  assert.equal(explicit[0].dirs.length, 2);
});

test("an empty grade set fails closed instead of scoring NaN", () => {
  const run = aggregateRun([], {
    provider: "test",
    model: "m",
    vision_model: "v",
  });
  assert.equal(run.total, 0);
  assert.equal(run.verdict, "fail");
  assert.throws(() => compareRuns("empty", []), /no graded runs/);
});

test("inferGroups treats a plain mode dir as one run", () => {
  const root = tempDir();
  const modeDir = join(root, "stock");
  // benchmark.ts writes answers/answers.json, not answers.json directly.
  mkdirSync(join(modeDir, "answers"), { recursive: true });
  writeFileSync(join(modeDir, "answers", "answers.json"), "{}");
  assert.deepEqual(inferGroups(modeDir), [{ name: "stock", dirs: [modeDir] }]);
});
