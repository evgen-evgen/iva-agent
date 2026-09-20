/* eslint-disable @typescript-eslint/no-floating-promises -- Node's test runner owns registrations. */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { nowMarkdown } from "./instructions/now.ts";

const dirs: string[] = [];

function tempDataDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "iva-now-"));
  dirs.push(dir);
  return dir;
}

after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

test("production instructions use the supplied live clock", () => {
  const markdown = nowMarkdown({
    dataDir: tempDataDir(),
    env: { AGENT_LANGUAGE: "en" },
    timezone: "UTC",
    now: new Date("2026-09-14T10:30:00Z"),
  });
  assert.match(markdown, /September 14, 2026/);
  assert.doesNotMatch(markdown, /frozen/);
});

test("isolated memory eval freezes the prompt at the fixture date", () => {
  const dataDir = tempDataDir();
  writeFileSync(join(dataDir, "memory-eval-date"), "2026-09-11\n", "utf8");
  const markdown = nowMarkdown({
    dataDir,
    env: { AGENT_LANGUAGE: "en", IVA_MEMORY_EVAL_MODE: "1" },
    timezone: "Asia/Tbilisi",
    now: new Date("2030-01-01T00:00:00Z"),
  });
  assert.match(markdown, /September 11, 2026/);
  assert.match(markdown, /2026-09-11/);
  assert.match(markdown, /frozen/);
  assert.doesNotMatch(markdown, /2030/);
});

test("isolated memory eval rejects an impossible fixture date", () => {
  const dataDir = tempDataDir();
  writeFileSync(join(dataDir, "memory-eval-date"), "2026-02-30\n", "utf8");
  assert.throws(
    () =>
      nowMarkdown({
        dataDir,
        env: { IVA_MEMORY_EVAL_MODE: "1" },
        timezone: "UTC",
      }),
    /valid YYYY-MM-DD/,
  );
});
