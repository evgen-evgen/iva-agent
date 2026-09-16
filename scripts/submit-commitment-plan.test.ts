/* eslint-disable @typescript-eslint/no-floating-promises -- Node's test runner owns registrations. */
import "./lib/ts-esm-hooks.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  readCommitmentPlan,
  requireAppliedCommitmentPlan,
} from "../agent/lib/commitment-plan.ts";

const REPO = fileURLToPath(new URL("..", import.meta.url));
const ROOT = mkdtempSync(join(tmpdir(), "iva-submit-commitment-plan-"));
const VAULT = join(ROOT, "vault");
const DATA = join(ROOT, "data");
const DATE = "2026-09-07";
process.env.ASSISTANT_VAULT_DIR = VAULT;
process.env.ASSISTANT_DATA_DIR = DATA;
process.env.ASSISTANT_TIMEZONE = "Europe/Warsaw";
process.env.IVA_MEMORY_EVAL_MODE = "1";

mkdirSync(join(VAULT, "cards"), { recursive: true });
mkdirSync(join(VAULT, "daily"), { recursive: true });
mkdirSync(DATA, { recursive: true });
cpSync(join(REPO, "vault-template", "schema.json"), join(VAULT, "schema.json"));
writeFileSync(join(DATA, "memory-eval-date"), `${DATE}\n`);
writeFileSync(
  join(VAULT, "daily", `${DATE}.md`),
  [
    "# 2026-09-07",
    "",
    "## 09:00 [text]",
    "Марина отправит предложение завтра до 17:00.",
    "",
    "## 09:01 [iva]",
    "Похоже, поставщик ненадёжен.",
    "",
    "## 09:05 [text]",
    "Стена в офисе синяя.",
    "",
  ].join("\n"),
);

const schemaPath = join(VAULT, "schema.json");
const schema = JSON.parse(readFileSync(schemaPath, "utf8")) as {
  node_types: Record<string, unknown>;
  card_type_dirs: Record<string, string>;
  path_type_hints: Record<string, string>;
};
schema.node_types.commitment = {
  required: ["commitment_id", "owner", "deliverable", "due_at", "status"],
  status: ["open", "done", "cancelled"],
};
schema.card_type_dirs.commitment = "commitments";
schema.path_type_hints["cards/commitments/"] = "commitment";
writeFileSync(schemaPath, `${JSON.stringify(schema, null, 2)}\n`);

after(() => rmSync(ROOT, { recursive: true, force: true }));

const submitPlan = (await import("../agent/tools/submit_commitment_plan.ts"))
  .default;
type SubmitInput = Parameters<typeof submitPlan.execute>[0];
const inputSchema = submitPlan.inputSchema as unknown as {
  parse: (value: unknown) => SubmitInput;
};
const tool = submitPlan as unknown as {
  execute: (input: SubmitInput) => Promise<unknown>;
};

async function call(input: unknown): Promise<Record<string, unknown>> {
  return (await tool.execute(inputSchema.parse(input))) as Record<
    string,
    unknown
  >;
}

test("submit_commitment_plan fails incomplete coverage, then applies one complete plan", async () => {
  const incomplete = await call({
    sections: [{ section: 1, classification: "none", actions: [] }],
  });
  assert.equal(incomplete.ok, false);
  assert.match(String(incomplete.error), /expected 1,2,3/);
  assert.equal(readCommitmentPlan(VAULT, DATE)?.status, "failed");
  assert.equal(existsSync(join(VAULT, "cards", "commitments")), false);

  const applied = await call({
    sections: [
      {
        section: 1,
        classification: "commitment",
        actions: [
          {
            action: "create",
            commitment_id: "marina-acme-proposal",
            owner: "Марина Волкова",
            deliverable: "Отправить обновлённое предложение Acme",
            due_at: "2026-09-08T17:00:00+02:00",
            source_role: "user",
            tags: ["acme"],
          },
        ],
      },
      { section: 2, classification: "none", actions: [] },
      { section: 3, classification: "none", actions: [] },
    ],
  });
  assert.equal(applied.ok, true);
  assert.equal(applied.section_count, 3);
  assert.equal(applied.action_count, 1);
  assert.equal(
    existsSync(join(VAULT, "cards", "commitments", "marina-acme-proposal.md")),
    true,
  );
  assert.doesNotThrow(() => requireAppliedCommitmentPlan(VAULT, DATE));
});
