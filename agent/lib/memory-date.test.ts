/* eslint-disable @typescript-eslint/no-floating-promises -- Node's test runner owns registrations. */
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  isIsoCalendarDate,
  MEMORY_EVAL_DATE_FILE,
  MEMORY_EVAL_MODE_ENV,
  memoryWriteDate,
} from "./memory-date.ts";

const DIR = mkdtempSync(join(tmpdir(), "iva-memory-date-"));
const previousDataDir = process.env.ASSISTANT_DATA_DIR;
const previousEvalMode = process.env[MEMORY_EVAL_MODE_ENV];

before(() => {
  process.env.ASSISTANT_DATA_DIR = DIR;
  process.env[MEMORY_EVAL_MODE_ENV] = "1";
});

after(() => {
  if (previousDataDir === undefined) delete process.env.ASSISTANT_DATA_DIR;
  else process.env.ASSISTANT_DATA_DIR = previousDataDir;
  if (previousEvalMode === undefined) delete process.env[MEMORY_EVAL_MODE_ENV];
  else process.env[MEMORY_EVAL_MODE_ENV] = previousEvalMode;
  rmSync(DIR, { recursive: true, force: true });
});

test("ISO calendar date validation rejects impossible dates", () => {
  assert.equal(isIsoCalendarDate("2026-09-07"), true);
  assert.equal(isIsoCalendarDate("2026-02-30"), false);
  assert.equal(isIsoCalendarDate("07-09-2026"), false);
});

test("explicit eval mode reads the current fixture date from isolated data", () => {
  writeFileSync(join(DIR, MEMORY_EVAL_DATE_FILE), "2026-09-09\n", "utf8");
  assert.equal(memoryWriteDate(), "2026-09-09");

  writeFileSync(join(DIR, MEMORY_EVAL_DATE_FILE), "not-a-date\n", "utf8");
  assert.throws(() => memoryWriteDate(), /valid YYYY-MM-DD/);
});
