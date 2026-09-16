import { join } from "node:path";
import { commitmentsEnabled } from "#lib/commitment-config.ts";
import {
  commitmentPlanPath,
  dailyTranscriptSectionHeadings,
  readCommitmentPlan,
  requireAppliedCommitmentPlan,
} from "#lib/commitment-plan.ts";

export function commitmentPrepassRequired(vault: string): boolean {
  return commitmentsEnabled(vault);
}

export function buildCommitmentPrepassPrompt({
  vault,
  date,
  timezone,
  attempt = 1,
}: {
  vault: string;
  date: string;
  timezone: string;
  attempt?: number;
}): string {
  const source = join(vault, "daily", `${date}.md`);
  const headings = dailyTranscriptSectionHeadings(vault, date);
  const numbered = headings.length
    ? headings.map((heading, index) => `${index + 1}: ${heading}`).join("\n")
    : "(the transcript has no H2 sections; submit sections=[] )";
  const retry =
    attempt > 1
      ? `A previous attempt did not produce an applied plan. Read ${commitmentPlanPath(vault, date)} if it exists, correct the error, and resubmit the complete plan. `
      : "";

  return (
    `Mandatory commitment reconciliation for ${date} (${timezone}). ${retry}` +
    `Read ${source} and existing ${join(vault, "cards", "commitments")}. ` +
    `Classify EVERY numbered transcript section below exactly once, then call submit_commitment_plan exactly once. ` +
    `Do not finish with prose instead of the tool call.\n\n` +
    `Sections:\n${numbered}\n\n` +
    `For each explicit promise or obligation with owner, observable deliverable, and due date, emit create. ` +
    `For an explicit deadline change, completion, or cancellation, reuse the existing commitment_id and emit ` +
    `reschedule, complete, or cancel. A completion timestamp is the OBSERVED event time from the source heading/body, ` +
    `never the deadline. Preserve local timestamps as ISO with the ${timezone} offset when the source gives a time. ` +
    `A request without an accepted obligation is none. Iva's own opinion/inference is always none. ` +
    `A section may contain multiple actions. classification=none requires actions=[]; ` +
    `classification=commitment requires at least one action. Inspect existing cards before choosing IDs. ` +
    `Do not create summaries, contacts, projects, decisions, tasks, or CORE in this pass.`
  );
}

export function commitmentPlanApplied(vault: string, date: string): boolean {
  try {
    requireAppliedCommitmentPlan(vault, date);
    return true;
  } catch {
    return false;
  }
}

export function commitmentPlanFailure(vault: string, date: string): string {
  try {
    requireAppliedCommitmentPlan(vault, date);
    return "commitment plan is applied";
  } catch (error) {
    const plan = readCommitmentPlan(vault, date);
    return (
      plan?.error ?? (error instanceof Error ? error.message : String(error))
    );
  }
}
