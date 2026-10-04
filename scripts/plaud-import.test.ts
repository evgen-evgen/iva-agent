/* eslint-disable @typescript-eslint/no-floating-promises -- Node test runner owns registrations. */
import "./lib/ts-esm-hooks.ts";
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  pendingPlaud,
  plaudKey,
  savePlaudSnapshot,
} from "../agent/lib/plaud-import.ts";

const root = mkdtempSync(join(tmpdir(), "iva-plaud-tools-"));
const vault = join(root, "vault");
process.env.ASSISTANT_DATA_DIR = join(root, "data");
process.env.ASSISTANT_VAULT_DIR = vault;
mkdirSync(join(vault, "cards", "meetings"), { recursive: true });
after(() => rmSync(root, { recursive: true, force: true }));
const { plaudSourceRoot, withPlaudClient } =
  await import("../agent/lib/plaud-client.ts");
const module = await import("../agent/tools/plaud_import.ts");
const tool = module.default as unknown as {
  execute: (input: Record<string, unknown>) => Promise<{
    ok: boolean;
    error?: string;
    content?: string;
    next_offset?: number | null;
  }>;
};
const source = {
  account: "ceo",
  fileId: "one",
  metadata: { name: "Meeting" },
  transcript: "A".repeat(30000),
  notes: [],
};

test("tool reads bounded source pages and refuses to acknowledge missing, stale or outside meeting cards", async () => {
  await savePlaudSnapshot(plaudSourceRoot(), source);
  const key = plaudKey(source.account, source.fileId);
  const snapshot = (await pendingPlaud(plaudSourceRoot()))[0];
  const first = await tool.execute({ action: "read", key });
  assert.equal(first.ok, true);
  assert.equal(first.content?.length, 24000);
  assert.equal(first.next_offset, 24000);
  const second = await tool.execute({
    action: "read",
    key,
    offset: first.next_offset,
  });
  assert.equal(second.next_offset, null);
  const finish = {
    action: "finish",
    key,
    revision: snapshot.revision,
    report: "Meeting report",
  };
  assert.equal((await tool.execute(finish)).ok, false);
  const meeting = join(vault, "cards", "meetings", "one.md");
  writeFileSync(meeting, `---\ntype: meeting\n---\n${key}\nold revision`);
  assert.equal(
    (await tool.execute({ ...finish, related: ["cards/meetings/one.md"] })).ok,
    false,
  );
  const outside = join(root, "outside.md");
  writeFileSync(
    outside,
    `---\ntype: meeting\n---\n${key}\n${snapshot.revision}`,
  );
  assert.equal(
    (await tool.execute({ ...finish, related: [outside] })).ok,
    false,
  );
  writeFileSync(
    meeting,
    `---\ntype: meeting\n---\n${key}\n${snapshot.revision}`,
  );
  assert.equal(
    (await tool.execute({ ...finish, related: ["cards/meetings/one.md"] })).ok,
    true,
  );
  assert.equal((await pendingPlaud(plaudSourceRoot())).length, 0);
  const read = await tool.execute({ action: "read", key, offset: 24000 });
  assert.match(read.content ?? "", /Meeting report/);
});

test("sync cannot contact a removed or untrusted plugin", async () => {
  await assert.rejects(
    withPlaudClient(() => Promise.resolve(true)),
    /Install and trust/,
  );
  const custom = join(root, "data", "custom");
  mkdirSync(custom, { recursive: true });
  writeFileSync(
    join(custom, "plugins.json"),
    JSON.stringify({
      plugins: [
        {
          name: "iva-plaud",
          source: "local",
          ref: "",
          sha: "",
          digest: "",
          enabled: true,
          trusted: false,
          installedAt: "2026-10-04",
          mcp: { plaud: { port: 8730 } },
        },
      ],
    }),
  );
  await assert.rejects(
    withPlaudClient(() => Promise.resolve(true)),
    /Install and trust/,
  );
});

test("enable refuses missing CEO schema and toggles only after the schema is present", async () => {
  assert.equal((await tool.execute({ action: "enable" })).ok, false);
  writeFileSync(
    join(vault, "schema.json"),
    JSON.stringify({
      node_types: { meeting: {}, commitment: {} },
      card_type_dirs: { meeting: "meetings", commitment: "commitments" },
    }),
  );
  assert.equal((await tool.execute({ action: "enable" })).ok, true);
  assert.equal((await tool.execute({ action: "disable" })).ok, true);
});
