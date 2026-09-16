import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";

export const COMMITMENT_PLAN_VERSION = 1;

export type CommitmentPlanStatus = "applied" | "failed";

export type StoredCommitmentPlan = {
  version: number;
  date: string;
  source: string;
  source_sha256: string;
  section_count: number;
  status: CommitmentPlanStatus;
  sections: unknown[];
  results: unknown[];
  error?: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function commitmentPlanPath(vault: string, date: string): string {
  return join(vault, ".memory", "commitment-plans", `${date}.json`);
}

export function transcriptSectionHeadings(raw: string): string[] {
  return raw
    .replaceAll("\r\n", "\n")
    .split("\n")
    .flatMap((line) => {
      const match = /^##\s+(.+?)\s*$/.exec(line);
      return match ? [match[1]] : [];
    });
}

export function dailyTranscriptSectionHeadings(
  vault: string,
  date: string,
): string[] {
  const path = join(vault, "daily", `${date}.md`);
  if (!existsSync(path)) throw new Error(`raw daily file is missing: ${path}`);
  return transcriptSectionHeadings(readFileSync(path, "utf8"));
}

export function dailyTranscriptFingerprint(
  vault: string,
  date: string,
): string {
  const path = join(vault, "daily", `${date}.md`);
  if (!existsSync(path)) throw new Error(`raw daily file is missing: ${path}`);
  const raw = readFileSync(path, "utf8").replaceAll("\r\n", "\n");
  const marker = raw.search(
    new RegExp(`^<!-- processed: ${date}T\\d{2}:\\d{2} -->$`, "m"),
  );
  const source = (marker >= 0 ? raw.slice(0, marker) : raw).trimEnd();
  return createHash("sha256").update(`${source}\n`).digest("hex");
}

export function expectedSectionNumbers(sectionCount: number): number[] {
  return Array.from({ length: sectionCount }, (_, index) => index + 1);
}

export function validateSectionCoverage(
  sectionCount: number,
  sections: Array<{ section: number }>,
): string | null {
  const actual = sections.map(({ section }) => section).sort((a, b) => a - b);
  const expected = expectedSectionNumbers(sectionCount);
  if (
    actual.length !== expected.length ||
    actual.some((section, index) => section !== expected[index])
  ) {
    return `sections must cover every transcript section exactly once; expected ${expected.join(",") || "none"}, got ${actual.join(",") || "none"}`;
  }
  return null;
}

export function readCommitmentPlan(
  vault: string,
  date: string,
): StoredCommitmentPlan | null {
  const path = commitmentPlanPath(vault, date);
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (!isRecord(parsed)) return null;
    if (
      parsed.version !== COMMITMENT_PLAN_VERSION ||
      parsed.date !== date ||
      parsed.source !== `daily/${date}.md` ||
      typeof parsed.source_sha256 !== "string" ||
      !/^[a-f0-9]{64}$/.test(parsed.source_sha256) ||
      typeof parsed.section_count !== "number" ||
      !Number.isSafeInteger(parsed.section_count) ||
      parsed.section_count < 0 ||
      !["applied", "failed"].includes(String(parsed.status)) ||
      !Array.isArray(parsed.sections) ||
      !Array.isArray(parsed.results)
    ) {
      return null;
    }
    return parsed as StoredCommitmentPlan;
  } catch {
    return null;
  }
}

export function requireAppliedCommitmentPlan(
  vault: string,
  date: string,
): void {
  const plan = readCommitmentPlan(vault, date);
  if (!plan) {
    throw new Error(
      `commitment plan is missing or invalid: ${commitmentPlanPath(vault, date)}`,
    );
  }
  if (plan.status !== "applied") {
    throw new Error(
      `commitment plan was not applied${plan.error ? `: ${plan.error}` : ""}`,
    );
  }
  const currentHeadings = dailyTranscriptSectionHeadings(vault, date);
  if (plan.section_count !== currentHeadings.length) {
    throw new Error(
      `commitment plan is stale: expected ${currentHeadings.length} source sections, plan has ${plan.section_count}`,
    );
  }
  const fingerprint = dailyTranscriptFingerprint(vault, date);
  if (plan.source_sha256 !== fingerprint) {
    throw new Error(
      "commitment plan is stale: daily transcript content changed",
    );
  }
  const sections = plan.sections
    .filter(isRecord)
    .flatMap((section) =>
      typeof section.section === "number" ? [{ section: section.section }] : [],
    );
  const coverageError = validateSectionCoverage(plan.section_count, sections);
  if (coverageError)
    throw new Error(`commitment plan coverage is invalid: ${coverageError}`);
}
