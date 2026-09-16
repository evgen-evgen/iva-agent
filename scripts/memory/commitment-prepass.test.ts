/* eslint-disable @typescript-eslint/no-floating-promises -- Node's test runner owns registrations. */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { buildCommitmentPrepassPrompt } from "./commitment-prepass.ts";

const roots: string[] = [];

after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

test("commitment pre-pass numbers every source section and forbids deadline-as-completion", () => {
  const vault = mkdtempSync(join(tmpdir(), "iva-commitment-prepass-"));
  roots.push(vault);
  mkdirSync(join(vault, "daily"), { recursive: true });
  writeFileSync(
    join(vault, "daily", "2026-09-11.md"),
    "# Day\n\n## 09:18 [forward]\nSent.\n\n## 09:20 [iva]\nNoted.\n",
  );

  const prompt = buildCommitmentPrepassPrompt({
    vault,
    date: "2026-09-11",
    timezone: "Europe/Warsaw",
    attempt: 2,
  });
  assert.match(prompt, /1: 09:18 \[forward\]/);
  assert.match(prompt, /2: 09:20 \[iva\]/);
  assert.match(prompt, /submit_commitment_plan exactly once/);
  assert.match(prompt, /OBSERVED event time/);
  assert.match(prompt, /previous attempt did not produce an applied plan/i);
});
