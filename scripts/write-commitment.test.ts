/* eslint-disable @typescript-eslint/no-floating-promises -- Node's test runner owns registrations. */
import "./lib/ts-esm-hooks.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseFrontmatter } from "../agent/lib/frontmatter.ts";

const REPO = fileURLToPath(new URL("..", import.meta.url));
const ROOT = mkdtempSync(join(tmpdir(), "iva-commitment-"));
const VAULT = join(ROOT, "vault");
const DATA = join(ROOT, "data");
process.env.ASSISTANT_VAULT_DIR = VAULT;
process.env.ASSISTANT_DATA_DIR = DATA;
process.env.ASSISTANT_TIMEZONE = "Europe/Warsaw";
process.env.IVA_MEMORY_EVAL_MODE = "1";

mkdirSync(join(VAULT, "cards"), { recursive: true });
mkdirSync(DATA, { recursive: true });
cpSync(join(REPO, "vault-template", "schema.json"), join(VAULT, "schema.json"));

const schemaPath = join(VAULT, "schema.json");
const schema = JSON.parse(readFileSync(schemaPath, "utf8")) as {
  node_types: Record<string, unknown>;
  card_type_dirs: Record<string, string>;
  path_type_hints: Record<string, string>;
};
schema.node_types.commitment = {
  required: [
    "commitment_id",
    "owner",
    "deliverable",
    "due_at",
    "completed_at",
    "source_role",
  ],
  status: ["open", "done", "cancelled"],
};
schema.card_type_dirs.commitment = "commitments";
schema.path_type_hints["cards/commitments/"] = "commitment";
writeFileSync(schemaPath, `${JSON.stringify(schema, null, 2)}\n`, "utf8");

after(() => rmSync(ROOT, { recursive: true, force: true }));

const writeCommitment = (await import("../agent/tools/write_commitment.ts"))
  .default;
type WriteCommitmentInput = Parameters<typeof writeCommitment.execute>[0];
const inputSchema = writeCommitment.inputSchema as unknown as {
  parse: (value: unknown) => WriteCommitmentInput;
};
const tool = writeCommitment as unknown as {
  execute: (input: WriteCommitmentInput) => Promise<unknown>;
};

function setDate(date: string): void {
  writeFileSync(join(DATA, "memory-eval-date"), `${date}\n`, "utf8");
}

async function call(input: unknown): Promise<Record<string, unknown>> {
  return (await tool.execute(inputSchema.parse(input))) as Record<
    string,
    unknown
  >;
}

test("write_commitment owns a deterministic create-reschedule-complete lifecycle", async () => {
  setDate("2026-09-07");
  assert.deepEqual(
    await call({
      action: "create",
      commitment_id: "oleg-delta-cash-flow",
      owner: "Oleg Smirnov",
      deliverable: "Provide the Delta cash-flow forecast",
      due_at: "2026-09-10T18:00:00+02:00",
      source_role: "user",
      tags: ["Delta", "finance"],
      related: ["cards/projects/delta", "cards/contacts/oleg-smirnov"],
    }),
    {
      ok: true,
      action: "created",
      file: "cards/commitments/oleg-delta-cash-flow.md",
      status: "open",
      commitment_id: "oleg-delta-cash-flow",
    },
  );

  setDate("2026-09-09");
  const rescheduled = await call({
    action: "reschedule",
    commitment_id: "oleg-delta-cash-flow",
    due_at: "2026-09-11T14:00:00+02:00",
    source_role: "user",
    reason: "The finance model needs another day",
  });
  assert.equal(rescheduled.ok, true);
  assert.equal(rescheduled.status, "open");

  setDate("2026-09-11");
  const completed = await call({
    action: "complete",
    commitment_id: "oleg-delta-cash-flow",
    completed_at: "2026-09-11T13:30:00+02:00",
    source_role: "user",
  });
  assert.equal(completed.ok, true);
  assert.equal(completed.status, "done");

  const file = join(VAULT, "cards", "commitments", "oleg-delta-cash-flow.md");
  const content = readFileSync(file, "utf8");
  const parsed = parseFrontmatter(content);
  assert.equal(parsed.fields?.commitment_id, "oleg-delta-cash-flow");
  assert.equal(parsed.fields?.owner, "Oleg Smirnov");
  assert.equal(parsed.fields?.status, "done");
  assert.equal(parsed.fields?.due_at, "2026-09-11T14:00:00+02:00");
  assert.equal(parsed.fields?.completed_at, "2026-09-11T13:30:00+02:00");
  assert.deepEqual(parsed.fields?.sources, [
    "daily/2026-09-07.md",
    "daily/2026-09-09.md",
    "daily/2026-09-11.md",
  ]);
  assert.equal((content.match(/^## History$/gm) ?? []).length, 1);
  assert.match(
    content,
    /due_at 2026-09-10T18:00:00\+02:00 -> 2026-09-11T14:00:00\+02:00/,
  );
  assert.match(content, /status open -> done/);
  assert.doesNotMatch(
    content.slice(0, content.indexOf("## History")),
    /2026-09-10T18:00:00\+02:00/,
  );
});

test("write_commitment retries are idempotent and invalid transitions fail closed", async () => {
  setDate("2026-09-11");
  const file = join(VAULT, "cards", "commitments", "oleg-delta-cash-flow.md");
  const before = readFileSync(file, "utf8");
  const replay = await call({
    action: "complete",
    commitment_id: "oleg-delta-cash-flow",
    completed_at: "2026-09-11T13:30:00+02:00",
    source_role: "user",
  });
  assert.equal(replay.action, "noop");
  assert.equal(readFileSync(file, "utf8"), before);

  const invalid = await call({
    action: "reschedule",
    commitment_id: "oleg-delta-cash-flow",
    due_at: "2026-09-12T14:00:00+02:00",
    source_role: "user",
  });
  assert.equal(invalid.ok, false);
  assert.match(String(invalid.error), /Cannot reschedule a done commitment/);
  assert.equal(readFileSync(file, "utf8"), before);
});

test("write_commitment refuses invented timestamps and disabled schema", async () => {
  setDate("2026-09-07");
  const invalid = await call({
    action: "create",
    commitment_id: "bad-time",
    owner: "Someone",
    deliverable: "Do something",
    due_at: "next Friday-ish",
    source_role: "user",
  });
  assert.equal(invalid.ok, false);
  assert.match(String(invalid.error), /Invalid due_at/);

  const current = JSON.parse(readFileSync(schemaPath, "utf8")) as {
    node_types: Record<string, unknown>;
    card_type_dirs: Record<string, string>;
  };
  delete current.node_types.commitment;
  delete current.card_type_dirs.commitment;
  writeFileSync(schemaPath, `${JSON.stringify(current, null, 2)}\n`, "utf8");
  const disabled = await call({
    action: "noop",
    commitment_id: "oleg-delta-cash-flow",
    source_role: "user",
  });
  assert.equal(disabled.ok, false);
  assert.match(String(disabled.error), /disabled/);
});
