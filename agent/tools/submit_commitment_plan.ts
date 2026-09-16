import { mkdirSync } from "node:fs";
import { dirname, relative, sep } from "node:path";
import { defineTool } from "eve/tools";
import { z } from "zod";
import { commitmentDirectory } from "../lib/commitment-config.ts";
import {
  COMMITMENT_PLAN_VERSION,
  commitmentPlanPath,
  dailyTranscriptFingerprint,
  dailyTranscriptSectionHeadings,
  validateSectionCoverage,
} from "../lib/commitment-plan.ts";
import { acquireLock, atomicWrite } from "../lib/card-store.js";
import { memoryWriteDate } from "../lib/memory-date.ts";
import writeCommitment, {
  commitmentActionSchema,
  type CommitmentActionInput,
} from "./write_commitment.ts";

const VAULT = () => process.env.ASSISTANT_VAULT_DIR || "vault";

const noCommitmentSection = z.object({
  section: z.number().int().positive(),
  classification: z.literal("none"),
  actions: z.array(commitmentActionSchema).max(0),
});

const commitmentSection = z.object({
  section: z.number().int().positive(),
  classification: z.literal("commitment"),
  actions: z.array(commitmentActionSchema).min(1).max(10),
});

export const commitmentPlanInputSchema = z.object({
  sections: z
    .array(
      z.discriminatedUnion("classification", [
        noCommitmentSection,
        commitmentSection,
      ]),
    )
    .max(500)
    .describe(
      "Exactly one classification for every numbered H2 section in the daily transcript",
    ),
});

type PlanInput = z.infer<typeof commitmentPlanInputSchema>;

type ApplyResult = {
  section: number;
  action: CommitmentActionInput["action"];
  commitment_id: string;
  ok: boolean;
  result: unknown;
};

function planRelativePath(vault: string, path: string): string {
  return relative(vault, path).split(sep).join("/");
}

function writePlan(
  vault: string,
  date: string,
  sectionCount: number,
  sourceSha256: string,
  input: PlanInput,
  results: ApplyResult[],
  status: "applied" | "failed",
  error?: string,
): string {
  const path = commitmentPlanPath(vault, date);
  mkdirSync(dirname(path), { recursive: true });
  const release = acquireLock(path);
  try {
    atomicWrite(
      path,
      `${JSON.stringify(
        {
          version: COMMITMENT_PLAN_VERSION,
          date,
          source: `daily/${date}.md`,
          source_sha256: sourceSha256,
          section_count: sectionCount,
          status,
          sections: input.sections,
          results,
          ...(error ? { error } : {}),
        },
        null,
        2,
      )}\n`,
    );
  } finally {
    release();
  }
  return planRelativePath(vault, path);
}

export default defineTool({
  description:
    "Submit the complete commitment classification for one daily transcript. " +
    "You MUST classify every numbered transcript section exactly once. The tool validates coverage, " +
    "then deterministically applies all lifecycle actions through write_commitment and writes an audit plan. " +
    "Use classification=none with actions=[] only when that section contains no explicit commitment event.",
  inputSchema: commitmentPlanInputSchema,
  async execute(input, ctx) {
    const vault = VAULT();
    const date = memoryWriteDate();
    if (!commitmentDirectory(vault)) {
      return {
        ok: false,
        error: "Commitment plans are disabled by schema.json for this vault",
      };
    }

    let sectionCount: number;
    let sourceSha256: string;
    try {
      sectionCount = dailyTranscriptSectionHeadings(vault, date).length;
      sourceSha256 = dailyTranscriptFingerprint(vault, date);
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
    const coverageError = validateSectionCoverage(sectionCount, input.sections);
    if (coverageError) {
      const plan = writePlan(
        vault,
        date,
        sectionCount,
        sourceSha256,
        input,
        [],
        "failed",
        coverageError,
      );
      return { ok: false, error: coverageError, plan };
    }

    const results: ApplyResult[] = [];
    for (const section of [...input.sections].sort(
      (left, right) => left.section - right.section,
    )) {
      for (const action of section.actions) {
        const result = (await writeCommitment.execute(action, ctx)) as unknown;
        const ok =
          typeof result === "object" &&
          result !== null &&
          (result as { ok?: unknown }).ok === true;
        results.push({
          section: section.section,
          action: action.action,
          commitment_id: action.commitment_id,
          ok,
          result,
        });
        if (!ok) {
          const message =
            typeof result === "object" &&
            result !== null &&
            typeof (result as { error?: unknown }).error === "string"
              ? (result as { error: string }).error
              : `failed to apply ${action.action} for ${action.commitment_id}`;
          const plan = writePlan(
            vault,
            date,
            sectionCount,
            sourceSha256,
            input,
            results,
            "failed",
            message,
          );
          return { ok: false, error: message, plan, results };
        }
      }
    }

    const plan = writePlan(
      vault,
      date,
      sectionCount,
      sourceSha256,
      input,
      results,
      "applied",
    );
    return {
      ok: true,
      plan,
      section_count: sectionCount,
      action_count: results.length,
      results,
    };
  },
});
