/* eslint-disable @typescript-eslint/no-floating-promises -- Node's test runner owns registrations. */
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import {
  benchmarkModelMetadata,
  deepMerge,
  failedRunRecord,
  normalizeQuestionResult,
  parseArgs,
  resetDailyRollupSession,
  resolveCodexAuthDataDir,
  validateDailyArtifacts,
} from "./benchmark.ts";

const dirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "iva-ceo-benchmark-"));
  dirs.push(dir);
  return dir;
}

after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

test("benchmark CLI defaults to a safe single stock run", () => {
  assert.deepEqual(parseArgs([]), {
    mode: "stock",
    prepareOnly: false,
    skipQuestions: false,
  });
});

test("benchmark CLI parses explicit modes and non-model preparation", () => {
  assert.deepEqual(
    parseArgs([
      "--mode",
      "both",
      "--output",
      "data/custom-eval",
      "--prepare-only",
      "--skip-questions",
    ]),
    {
      mode: "both",
      output: "data/custom-eval",
      prepareOnly: true,
      skipQuestions: true,
    },
  );
  assert.throws(() => parseArgs(["--mode", "magic"]), /stock/);
  assert.throws(() => parseArgs(["--wat"]), /Unknown argument/);
});

test("schema overlay merges maps without dropping stock card types", () => {
  const merged = deepMerge(
    {
      node_types: { contact: { status: ["active"] } },
      card_type_dirs: { contact: "contacts" },
    },
    {
      node_types: { commitment: { status: ["open", "done"] } },
      card_type_dirs: { commitment: "commitments" },
    },
  );
  assert.deepEqual(merged.card_type_dirs, {
    contact: "contacts",
    commitment: "commitments",
  });
  assert.deepEqual(Object.keys(merged.node_types as object), [
    "contact",
    "commitment",
  ]);
});

test("Codex auth can come from the live Iva data dir without sharing eval state", () => {
  assert.equal(
    resolveCodexAuthDataDir({ ASSISTANT_DATA_DIR: "data" }, "/srv/iva-agent"),
    "/srv/iva-agent/data",
  );
  assert.equal(
    resolveCodexAuthDataDir(
      {
        ASSISTANT_DATA_DIR: "data",
        IVA_CODEX_AUTH_DATA_DIR: "/srv/live-iva/data",
      },
      "/srv/iva-agent",
    ),
    "/srv/live-iva/data",
  );
});

test("benchmark records the OpenRouter free model without exposing its key", () => {
  const metadata = benchmarkModelMetadata({
    MODEL_PROVIDER: "openrouter",
    OPENROUTER_MODEL: "openrouter/free",
    OPENROUTER_API_KEY: "secret-not-for-run-json",
  });
  assert.deepEqual(metadata, {
    provider: "openrouter",
    model: "openrouter/free",
    vision_model: "google/gemini-2.5-flash",
  });
  assert.equal(
    JSON.stringify(metadata).includes("secret-not-for-run-json"),
    false,
  );
});

test("a reply is recorded as completed even when Eve returns to waiting", () => {
  assert.deepEqual(
    normalizeQuestionResult({ status: "waiting", message: "  answer  " }),
    {
      status: "completed",
      reply: "answer",
      transport_status: "waiting",
    },
  );
  assert.deepEqual(normalizeQuestionResult({ status: "failed" }), {
    status: "failed",
    reply: null,
    error: "turn failed",
  });
});

test("an interrupted benchmark records a terminal failed state", () => {
  assert.deepEqual(
    failedRunRecord(
      { scenario: "ceo-week-v1", status: "running" },
      "stock",
      { stock: { status: "failed", issue_count: 2 } },
      new Error("daily summary is missing"),
      "2026-09-14T17:35:00.000Z",
    ),
    {
      scenario: "ceo-week-v1",
      status: "failed",
      completed_at: "2026-09-14T17:35:00.000Z",
      failed_mode: "stock",
      error: "daily summary is missing",
      artifact_validation: {
        stock: { status: "failed", issue_count: 2 },
      },
    },
  );
});

test("each synthetic day discards the previous rollup session cursor", async () => {
  const data = tempDir();
  const cursor = join(data, "rollup-session-daily.json");
  writeFileSync(cursor, '{"state":"old"}\n');

  await resetDailyRollupSession(data);

  assert.equal(existsSync(cursor), false);
});

test("artifact validator accepts a complete daily memory contract", async () => {
  const vault = tempDir();
  mkdirSync(join(vault, "daily"), { recursive: true });
  mkdirSync(join(vault, "summaries", "daily"), { recursive: true });
  mkdirSync(join(vault, ".graph"), { recursive: true });
  mkdirSync(join(vault, "cards", "projects"), { recursive: true });
  writeFileSync(
    join(vault, "daily", "2026-09-10.md"),
    "source\n<!-- processed: 2026-09-10T23:45 -->\nsummary: summaries/daily/2026-09-10.md\n",
  );
  writeFileSync(
    join(vault, "summaries", "daily", "2026-09-10.md"),
    "---\ntype: daily-summary\ndate: 2026-09-10\nsource: daily/2026-09-10.md\n---\n# Day\n",
  );
  writeFileSync(join(vault, ".graph", "vault-graph.json"), "{}\n");
  writeFileSync(join(vault, "MOC.md"), "[[MOC/MOC-projects]]\n");
  writeFileSync(
    join(vault, "cards", "projects", "delta.md"),
    "Launch: 25 сентября\n\n## History\n\nLaunch: 18 сентября\n",
  );
  assert.deepEqual(await validateDailyArtifacts(vault, "2026-09-10"), []);
});

test("artifact validator exposes skipped mechanical and supersede work", async () => {
  const vault = tempDir();
  mkdirSync(join(vault, "daily"), { recursive: true });
  mkdirSync(join(vault, "summaries", "daily"), { recursive: true });
  mkdirSync(join(vault, "cards", "projects"), { recursive: true });
  writeFileSync(join(vault, "daily", "2026-09-10.md"), "source\n");
  writeFileSync(
    join(vault, "summaries", "daily", "2026-09-10.md"),
    "# 2026-09-10\n",
  );
  writeFileSync(join(vault, "MOC.md"), "# template\n");
  writeFileSync(
    join(vault, "cards", "projects", "delta.md"),
    "Launch: 25 сентября\n",
  );
  const codes = (await validateDailyArtifacts(vault, "2026-09-10")).map(
    ({ code }) => code,
  );
  assert.deepEqual(codes, [
    "missing-processing-marker",
    "missing-summary-frontmatter",
    "missing-vault-graph",
    "stale-moc",
    "missing-delta-history",
  ]);
});
