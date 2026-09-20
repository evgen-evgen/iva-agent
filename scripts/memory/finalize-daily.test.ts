/* eslint-disable @typescript-eslint/no-floating-promises -- Node's test runner owns registrations. */
import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { after, test } from "node:test";
import {
  appendDailyProcessingMarker,
  ensureDailySummaryFrontmatter,
  finalizeDailyMemory,
  prepareDailyMemory,
  type FinalizerCommandRunner,
} from "./finalize-daily.ts";

const dirs: string[] = [];

function fixture(date = "2026-09-10"): string {
  const vault = mkdtempSync(join(tmpdir(), "iva-finalize-daily-"));
  dirs.push(vault);
  mkdirSync(join(vault, "daily"), { recursive: true });
  mkdirSync(join(vault, "summaries", "daily"), { recursive: true });
  mkdirSync(join(vault, "cards", "projects"), { recursive: true });
  writeFileSync(join(vault, "schema.json"), "{}\n");
  writeFileSync(join(vault, "MOC.md"), "# MOC\n");
  writeFileSync(join(vault, "daily", `${date}.md`), "raw transcript\n");
  writeFileSync(
    join(vault, "summaries", "daily", `${date}.md`),
    `# ${date}\n\n[[cards/projects/delta|Delta]]\n`,
  );
  writeFileSync(join(vault, "cards", "projects", "delta.md"), "# Delta\n");
  return vault;
}

after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

test("prepare step deterministically creates the supersede input", () => {
  const vault = fixture();
  const commands: string[] = [];
  const run: FinalizerCommandRunner = (_command, args) => {
    commands.push(basename(args[1]));
    mkdirSync(join(vault, ".graph"), { recursive: true });
    writeFileSync(join(vault, ".graph", "supersede-candidates.json"), "[]\n");
    return { status: 0 };
  };

  prepareDailyMemory({ vault, run });

  assert.deepEqual(commands, ["supersede.py"]);
  assert.equal(
    readFileSync(join(vault, ".graph", "supersede-candidates.json"), "utf8"),
    "[]\n",
  );
});

test("finalizer repairs summary framing and owns all mechanical steps", () => {
  const date = "2026-09-10";
  const vault = fixture(date);
  const commands: string[] = [];
  const graphInvocations: string[][] = [];
  const run: FinalizerCommandRunner = (_command, args) => {
    const script = basename(args[1]);
    commands.push(script + (script === "graph.py" ? `:${args[2]}` : ""));
    if (script === "graph.py") graphInvocations.push(args.slice(2));
    if (script === "graph.py" && args[2] === "health") {
      mkdirSync(join(vault, ".graph"), { recursive: true });
      writeFileSync(join(vault, ".graph", "vault-graph.json"), "{}\n");
    }
    return { status: 0 };
  };

  finalizeDailyMemory({
    vault,
    date,
    timezone: "UTC",
    now: new Date("2026-09-14T16:32:00Z"),
    graphAsOf: date,
    run,
  });

  assert.deepEqual(commands, [
    "cleanup.py",
    "enforce.py",
    "graph.py:fix",
    "engine.py",
    "moc.py",
    "engine.py",
    "graph.py:health",
  ]);
  assert.deepEqual(graphInvocations, [
    ["fix", vault, join(vault, "schema.json"), "--apply", "--as-of", date],
    ["health", vault, join(vault, "schema.json"), "--as-of", date],
  ]);
  const summary = readFileSync(
    join(vault, "summaries", "daily", `${date}.md`),
    "utf8",
  );
  assert.match(summary, /^---\ntype: daily-summary\n/);
  assert.match(summary, /source: daily\/2026-09-10\.md/);

  const raw = readFileSync(join(vault, "daily", `${date}.md`), "utf8");
  assert.match(raw, /<!-- processed: 2026-09-10T16:32 -->/);
  assert.match(raw, /cards: 1/);
  assert.match(raw, /summary: summaries\/daily\/2026-09-10\.md/);
});

test("finalizer closes frontmatter truncated by a stale redelivery", () => {
  const date = "2026-09-10";
  const vault = fixture(date);
  const path = join(vault, "summaries", "daily", `${date}.md`);
  writeFileSync(
    path,
    [
      "---",
      "type: daily-summary",
      `date: ${date}`,
      "description: Daily summary with a complete field set.",
      "tags: [daily]",
      "status: active",
      "topics: [delta]",
      `source: daily/${date}.md`,
      "domain: personal",
      "",
      `# ${date}`,
      "",
      "## Topics",
      "",
      "- Delta",
      "",
    ].join("\n"),
  );

  assert.equal(ensureDailySummaryFrontmatter(vault, date), path);
  const summary = readFileSync(path, "utf8");
  assert.match(summary, /domain: personal\n---\n\n# 2026-09-10/);
  assert.equal((summary.match(/^---$/gm) ?? []).length, 2);
});

test("frontmatter repair remains fail-closed when required fields are missing", () => {
  const date = "2026-09-10";
  const vault = fixture(date);
  const path = join(vault, "summaries", "daily", `${date}.md`);
  writeFileSync(
    path,
    `---\ntype: daily-summary\ndate: ${date}\n\n# ${date}\n`,
  );

  assert.throws(
    () => ensureDailySummaryFrontmatter(vault, date),
    /frontmatter is missing required fields: description, tags, status, topics, source/,
  );
  assert.equal(
    readFileSync(path, "utf8"),
    `---\ntype: daily-summary\ndate: ${date}\n\n# ${date}\n`,
  );
});

test("a failed mechanical step leaves the day unmarked for a safe retry", () => {
  const date = "2026-09-10";
  const vault = fixture(date);
  const run: FinalizerCommandRunner = (_command, args) => ({
    status: basename(args[1]) === "cleanup.py" ? 7 : 0,
    stderr: "cleanup failed",
  });

  assert.throws(
    () => finalizeDailyMemory({ vault, date, timezone: "UTC", run }),
    /cleanup\.py failed.*cleanup failed/s,
  );
  assert.doesNotMatch(
    readFileSync(join(vault, "daily", `${date}.md`), "utf8"),
    /<!-- processed:/,
  );
});

test("processing marker is idempotent", () => {
  const date = "2026-09-10";
  const vault = fixture(date);
  const options = {
    vault,
    date,
    timezone: "UTC",
    now: new Date("2026-09-14T16:32:00Z"),
  };

  assert.equal(appendDailyProcessingMarker(options), true);
  assert.equal(appendDailyProcessingMarker(options), false);
  const raw = readFileSync(join(vault, "daily", `${date}.md`), "utf8");
  assert.equal((raw.match(/<!-- processed:/g) ?? []).length, 1);
});
