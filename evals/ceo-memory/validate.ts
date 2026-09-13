import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

type SourceEntry = {
  id: string;
  file: string;
  time: string;
  type: string;
};

type Scenario = {
  version: string;
  period: { start: string; end: string };
  source_entries: SourceEntry[];
};

type Question = {
  id: string;
  checkpoint: string;
  category: string;
  critical: boolean;
  expected: {
    required_claims: string[];
    source_refs: string[];
    forbidden_claims?: string[];
  };
};

type Questions = { questions: Question[] };

const HERE = dirname(fileURLToPath(import.meta.url));
const VERSION_DIR = join(HERE, "v1");

function json<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

function unique(values: string[], label: string): void {
  assert.equal(
    new Set(values).size,
    values.length,
    `${label} must contain unique values`,
  );
}

function collectSourceRefs(value: unknown, into: string[]): void {
  if (Array.isArray(value)) {
    for (const item of value) collectSourceRefs(item, into);
    return;
  }
  if (value === null || typeof value !== "object") return;
  for (const [key, item] of Object.entries(value)) {
    if (key === "source_refs") {
      assert.ok(Array.isArray(item), "source_refs must be an array");
      for (const ref of item) {
        assert.equal(typeof ref, "string", "source ref must be a string");
        into.push(ref as string);
      }
    } else {
      collectSourceRefs(item, into);
    }
  }
}

const scenario = json<Scenario>(join(VERSION_DIR, "scenario.json"));
const questions = json<Questions>(join(VERSION_DIR, "questions.json"));
const truth = json<unknown>(join(VERSION_DIR, "expected", "truth.json"));

assert.match(scenario.version, /^1\./, "validator only supports v1 scenarios");
unique(
  scenario.source_entries.map((entry) => entry.id),
  "source entry IDs",
);
unique(
  questions.questions.map((question) => question.id),
  "question IDs",
);

const sourceIds = new Set(scenario.source_entries.map((entry) => entry.id));
const validCheckpoints = new Set([
  ...scenario.source_entries.map(
    (entry) => entry.file.match(/(\d{4}-\d{2}-\d{2})\.md$/)?.[1],
  ),
  "final",
]);
const validCategories = new Set([
  "current_truth",
  "commitments",
  "temporal_history",
  "entity_linking",
  "provenance",
  "precision",
]);

assert.ok(
  scenario.period.start <= scenario.period.end,
  "scenario period must be ordered",
);

const entriesByFile = new Map<string, SourceEntry[]>();
for (const entry of scenario.source_entries) {
  const entries = entriesByFile.get(entry.file) ?? [];
  entries.push(entry);
  entriesByFile.set(entry.file, entries);
}

for (const [file, entries] of entriesByFile) {
  const path = join(VERSION_DIR, file);
  const text = readFileSync(path, "utf8");
  const actualHeaders = [
    ...text.matchAll(/^## (\d{2}:\d{2}) (\[[^\n]+\])$/gm),
  ].map((match) => `${match[1]} ${match[2]}`);
  const mappedHeaders = entries.map((entry) => `${entry.time} ${entry.type}`);
  assert.deepEqual(
    actualHeaders,
    mappedHeaders,
    `${file}: source map must cover every transcript entry in order`,
  );
}

for (const question of questions.questions) {
  assert.ok(
    validCheckpoints.has(question.checkpoint),
    `${question.id}: unknown checkpoint ${question.checkpoint}`,
  );
  assert.ok(
    validCategories.has(question.category),
    `${question.id}: unknown category ${question.category}`,
  );
  assert.equal(
    typeof question.critical,
    "boolean",
    `${question.id}: critical must be boolean`,
  );
  assert.ok(
    question.expected.required_claims.length > 0,
    `${question.id}: at least one required claim is required`,
  );
  assert.ok(
    question.expected.source_refs.length > 0,
    `${question.id}: at least one source ref is required`,
  );
  for (const ref of question.expected.source_refs) {
    assert.ok(sourceIds.has(ref), `${question.id}: unknown source ref ${ref}`);
  }
  assert.ok(
    (question.expected.forbidden_claims?.length ?? 0) <= 6,
    `${question.id}: keep forbidden claims focused`,
  );
}

const truthRefs: string[] = [];
collectSourceRefs(truth, truthRefs);
for (const ref of truthRefs) {
  assert.ok(sourceIds.has(ref), `truth.json: unknown source ref ${ref}`);
}

console.log(
  `CEO memory benchmark ${scenario.version}: ${scenario.source_entries.length} source entries, ` +
    `${questions.questions.length} questions, ${truthRefs.length} truth references — valid.`,
);
