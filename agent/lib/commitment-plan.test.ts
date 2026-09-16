/* eslint-disable @typescript-eslint/no-floating-promises -- Node's test runner owns registrations. */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import {
  COMMITMENT_PLAN_VERSION,
  commitmentPlanPath,
  dailyTranscriptFingerprint,
  requireAppliedCommitmentPlan,
  transcriptSectionHeadings,
  validateSectionCoverage,
} from "./commitment-plan.ts";

const roots: string[] = [];

function fixture(): { vault: string; date: string } {
  const vault = mkdtempSync(join(tmpdir(), "iva-commitment-plan-"));
  roots.push(vault);
  const date = "2026-09-07";
  mkdirSync(join(vault, "daily"), { recursive: true });
  writeFileSync(
    join(vault, "daily", `${date}.md`),
    "# Day\n\n## 09:00 [text]\nFirst\n\n## 10:00 [iva]\nSecond\n",
  );
  return { vault, date };
}

after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

test("transcript sections and exact plan coverage are deterministic", () => {
  assert.deepEqual(
    transcriptSectionHeadings(
      "# Day\r\n\r\n## 09:00 [text]\r\nA\r\n## 10:00 [iva]\r\nB\r\n",
    ),
    ["09:00 [text]", "10:00 [iva]"],
  );
  assert.equal(
    validateSectionCoverage(2, [{ section: 2 }, { section: 1 }]),
    null,
  );
  assert.match(
    validateSectionCoverage(2, [{ section: 1 }]) ?? "",
    /expected 1,2, got 1/,
  );
  assert.match(
    validateSectionCoverage(2, [{ section: 1 }, { section: 1 }]) ?? "",
    /expected 1,2, got 1,1/,
  );
});

test("an applied plan is bound to source content but ignores the finalizer marker", () => {
  const { vault, date } = fixture();
  const path = commitmentPlanPath(vault, date);
  mkdirSync(join(vault, ".memory", "commitment-plans"), { recursive: true });
  writeFileSync(
    path,
    `${JSON.stringify({
      version: COMMITMENT_PLAN_VERSION,
      date,
      source: `daily/${date}.md`,
      source_sha256: dailyTranscriptFingerprint(vault, date),
      section_count: 2,
      status: "applied",
      sections: [{ section: 1 }, { section: 2 }],
      results: [],
    })}\n`,
  );

  assert.doesNotThrow(() => requireAppliedCommitmentPlan(vault, date));
  writeFileSync(
    join(vault, "daily", `${date}.md`),
    [
      "# Day",
      "",
      "## 09:00 [text]",
      "First",
      "",
      "## 10:00 [iva]",
      "Second",
      "",
      `<!-- processed: ${date}T23:59 -->`,
      "",
      "---",
      "",
      `processed: ${date}T23:59`,
      "cards: 0",
      `summary: summaries/daily/${date}.md`,
      "---",
      "",
    ].join("\n"),
  );
  assert.doesNotThrow(() => requireAppliedCommitmentPlan(vault, date));
  writeFileSync(
    join(vault, "daily", `${date}.md`),
    "# Day\n\n## 09:00 [text]\nChanged\n\n## 10:00 [iva]\nSecond\n",
  );
  assert.throws(
    () => requireAppliedCommitmentPlan(vault, date),
    /transcript content changed/,
  );
});
