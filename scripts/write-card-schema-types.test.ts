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

const REPO = fileURLToPath(new URL("..", import.meta.url));
const VAULT = mkdtempSync(join(tmpdir(), "iva-schema-card-"));
process.env.ASSISTANT_VAULT_DIR = VAULT;
process.env.ASSISTANT_TIMEZONE = "UTC";

mkdirSync(join(VAULT, "cards"), { recursive: true });
cpSync(join(REPO, "vault-template", "schema.json"), join(VAULT, "schema.json"));

const schemaPath = join(VAULT, "schema.json");
const schema = JSON.parse(readFileSync(schemaPath, "utf8")) as {
  node_types: Record<string, unknown>;
  card_type_dirs: Record<string, string>;
  path_type_hints: Record<string, string>;
};
schema.node_types.commitment = {
  description: "A promise with an owner and lifecycle",
  required: ["description", "tags", "status"],
  status: ["open", "done", "cancelled", "superseded"],
};
schema.card_type_dirs.commitment = "commitments";
schema.path_type_hints["cards/commitments/"] = "commitment";
writeFileSync(schemaPath, `${JSON.stringify(schema, null, 2)}\n`, "utf8");

after(() => rmSync(VAULT, { recursive: true, force: true }));

const writeCard = (await import("../agent/tools/write_card.ts")).default;
type WriteCardInput = Parameters<typeof writeCard.execute>[0];
const inputSchema = writeCard.inputSchema as unknown as {
  parse: (value: unknown) => WriteCardInput;
};
const testTool = writeCard as unknown as {
  execute: (input: WriteCardInput) => Promise<unknown>;
};

test("write_card accepts a schema-configured commitment type and folder", async () => {
  const result = (await testTool.execute(
    inputSchema.parse({
      operation: "ADD",
      type: "commitment",
      title: "Марина — договор Acme",
      description: "Марина отправит договор Acme до 14 сентября",
      tags: ["acme", "commitment"],
      status: "open",
      body: "Владелец: Марина. Срок: 2026-09-14 16:00.",
    }),
  )) as { ok: boolean; file: string; status: string; type: string };

  assert.equal(result.ok, true);
  assert.equal(result.type, "commitment");
  assert.equal(result.status, "open");
  assert.match(result.file, /^cards\/commitments\//);
  assert.equal(existsSync(join(VAULT, result.file)), true);
});

test("write_card validates custom statuses from the vault schema", async () => {
  const result = (await testTool.execute(
    inputSchema.parse({
      operation: "ADD",
      type: "commitment",
      title: "Invalid commitment",
      description: "Must not accept an invented type lifecycle",
      tags: ["commitment"],
      status: "waiting-on-magic",
      body: "Invalid status.",
    }),
  )) as { ok: boolean; error: string };

  assert.equal(result.ok, false);
  assert.match(result.error, /Недопустимый status/);
});
